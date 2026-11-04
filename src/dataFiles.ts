// Finds config/data files (e.g. src/data/site.ts) and turns their exported values into an
// editable tree. Edits replace only the changed literals in the source text, so comments,
// formatting and types stay as they are. No VS Code APIs here.
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { parseDocument } from 'yaml';

export type Key = string | number;
export type DataNode =
  | { kind: 'string'; value: string; path: Key[]; comment?: string }
  | { kind: 'number'; value: number; path: Key[]; comment?: string }
  | { kind: 'boolean'; value: boolean; path: Key[]; comment?: string }
  | { kind: 'null'; path: Key[]; comment?: string }
  | { kind: 'object'; entries: { key: string; node: DataNode }[]; path: Key[]; comment?: string }
  | { kind: 'array'; items: DataNode[]; path: Key[]; comment?: string; canAdd: boolean }
  | { kind: 'code'; text: string; line: number; path: Key[]; comment?: string; image?: string };

export interface DataExport {
  name: string;
  comment?: string;
  line: number;
  node: DataNode;
}

export interface DataFileInfo {
  file: string;
  label: string;
  format: 'ts' | 'json' | 'yaml';
  exports: { name: string; fields: number }[];
}

export interface DataFile extends DataFileInfo {
  data: DataExport[];
}

export type DataEdit = { path: Key[]; value: string | number | boolean | null };
export type DataOp = { op: 'duplicate' | 'remove' | 'up' | 'down' | 'add'; path: Key[] };

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro', 'pages', 'components', 'layouts', 'styles', 'assets', 'content']);
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const MIN_FIELDS = 2;

const toPosix = (p: string) => p.split(path.sep).join('/');

function walk(dir: string, out: string[] = []) {
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(d.name)) walk(full, out);
    } else out.push(full);
  }
  return out;
}

function labelFor(rel: string) {
  const parsed = path.parse(rel);
  const base = parsed.name === 'index' ? path.basename(parsed.dir) : parsed.name;
  return base.replace(/[._-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
}

function countFields(n: DataNode): number {
  if (n.kind === 'object') return n.entries.reduce((s, e) => s + countFields(e.node), 0);
  if (n.kind === 'array') return n.items.reduce((s, i) => s + countFields(i), 0);
  return n.kind === 'code' ? 0 : 1;
}

/** Lists files in src/ (outside pages/components/content) whose exports hold editable data. */
export function findDataFiles(root: string, extra: string[] = []): DataFileInfo[] {
  const src = path.join(root, 'src');
  const files = walk(src).filter((f) => {
    const b = path.basename(f);
    if (/\.d\.ts$/.test(b) || /^content\.config\./.test(b) || /^env\./.test(b)) return false;
    return /\.(ts|mts|js|mjs|json|ya?ml)$/.test(b);
  });
  for (const e of extra) {
    const abs = path.resolve(root, e);
    if (fs.existsSync(abs) && !files.includes(abs)) files.push(abs);
  }
  const out: DataFileInfo[] = [];
  for (const abs of files) {
    try {
      const df = readDataFile(root, toPosix(path.relative(root, abs)));
      const total = df.exports.reduce((s, e) => s + e.fields, 0);
      if (total >= MIN_FIELDS || extra.includes(df.file)) out.push({ file: df.file, label: df.label, format: df.format, exports: df.exports });
    } catch {
      /* unparsable: skip */
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function resolveInRoot(root: string, rel: string) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new Error(`Path is outside the project: ${rel}`);
  return abs;
}

export function readDataFile(root: string, rel: string): DataFile {
  const abs = resolveInRoot(root, rel);
  const text = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs).slice(1).toLowerCase();
  let data: DataExport[];
  let format: DataFile['format'];
  if (ext === 'json' || ext === 'yaml' || ext === 'yml') {
    format = ext === 'json' ? 'json' : 'yaml';
    const value = format === 'json' ? JSON.parse(text) : parseDocument(text).toJS();
    data = [{ name: 'default', line: 0, node: fromValue(value, []) }];
  } else {
    format = 'ts';
    data = tsExports(root, abs, text);
  }
  return {
    file: rel,
    label: labelFor(rel),
    format,
    data,
    exports: data.map((d) => ({ name: d.name, fields: countFields(d.node) })),
  };
}

// ---------- plain values (JSON / YAML) ----------

function fromValue(v: unknown, p: Key[]): DataNode {
  if (v === null || v === undefined) return { kind: 'null', path: p };
  if (typeof v === 'string') return { kind: 'string', value: v, path: p };
  if (typeof v === 'number') return { kind: 'number', value: v, path: p };
  if (typeof v === 'boolean') return { kind: 'boolean', value: v, path: p };
  if (Array.isArray(v)) return { kind: 'array', items: v.map((x, i) => fromValue(x, [...p, i])), path: p, canAdd: v.length > 0 };
  if (v instanceof Date) return { kind: 'string', value: v.toISOString(), path: p };
  return { kind: 'object', entries: Object.entries(v as object).map(([k, x]) => ({ key: k, node: fromValue(x, [...p, k]) })), path: p };
}

// ---------- TypeScript / JavaScript ----------

function parse(abs: string, text: string) {
  const kind = /\.m?js$/.test(abs) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind);
}

/** Strips `as const`, `satisfies X`, parentheses and wrapper calls like `withBase({...})`. */
function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e) && e.arguments.length === 1 && ts.isObjectLiteralExpression(unwrapShallow(e.arguments[0]))) e = e.arguments[0];
    else return e;
  }
}
function unwrapShallow(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function commentBefore(text: string, node: ts.Node): string | undefined {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart());
  if (!ranges?.length) return undefined;
  const c = ranges
    .map((r) =>
      text
        .slice(r.pos, r.end)
        .replace(/^\/\*\*?|\*\/$/g, '')
        .replace(/^\s*\/\/\s?/gm, '')
        .replace(/^\s*\*\s?/gm, '')
        .trim(),
    )
    .filter(Boolean)
    .join(' ');
  return c || undefined;
}

function propName(n: ts.PropertyName): string | null {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

/** Image imports: `import photo from '../assets/x.jpg'` → { photo: 'src/assets/x.jpg' } */
function imageImports(root: string, abs: string, sf: ts.SourceFile) {
  const map: Record<string, string> = {};
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause?.name || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    const spec = s.moduleSpecifier.text;
    if (!IMAGE_RE.test(spec)) continue;
    const target = spec.startsWith('.') ? path.resolve(path.dirname(abs), spec) : spec.startsWith('~/') || spec.startsWith('@/') ? path.join(root, 'src', spec.slice(2)) : null;
    if (target) map[s.importClause.name.text] = toPosix(path.relative(root, target));
  }
  return map;
}

function tsExports(root: string, abs: string, text: string): DataExport[] {
  const sf = parse(abs, text);
  const images = imageImports(root, abs, sf);
  const out: DataExport[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line;

  const toNode = (e: ts.Expression, p: Key[], comment?: string): DataNode => {
    const u = unwrap(e);
    if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return { kind: 'string', value: u.text, path: p, comment };
    if (ts.isNumericLiteral(u)) return { kind: 'number', value: Number(u.text), path: p, comment };
    if (ts.isPrefixUnaryExpression(u) && u.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(u.operand))
      return { kind: 'number', value: -Number(u.operand.text), path: p, comment };
    if (u.kind === ts.SyntaxKind.TrueKeyword || u.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'boolean', value: u.kind === ts.SyntaxKind.TrueKeyword, path: p, comment };
    if (u.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null', path: p, comment };
    if (ts.isArrayLiteralExpression(u)) {
      const items = u.elements.map((el, i) => (ts.isSpreadElement(el) ? codeNode(el, [...p, i]) : toNode(el, [...p, i], commentBefore(text, el))));
      return { kind: 'array', items, path: p, comment, canAdd: items.length > 0 && items.every((i) => i.kind !== 'code' || !/^\.\.\./.test(i.text)) };
    }
    if (ts.isObjectLiteralExpression(u)) {
      const entries: { key: string; node: DataNode }[] = [];
      for (const prop of u.properties) {
        const c = commentBefore(text, prop);
        if (ts.isPropertyAssignment(prop)) {
          const k = propName(prop.name);
          if (k !== null) entries.push({ key: k, node: toNode(prop.initializer, [...p, k], c) });
          else entries.push({ key: prop.name.getText(), node: codeNode(prop, [...p, prop.name.getText()], c) });
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          entries.push({ key: prop.name.text, node: codeNode(prop.name, [...p, prop.name.text], c) });
        } else {
          const k = ts.isSpreadAssignment(prop) ? `...${prop.expression.getText()}` : prop.name?.getText() ?? '?';
          entries.push({ key: k, node: codeNode(prop, [...p, k], c) });
        }
      }
      return { kind: 'object', entries, path: p, comment };
    }
    return codeNode(e, p, comment);
  };

  const codeNode = (n: ts.Node, p: Key[], comment?: string): DataNode => {
    const t = n.getText();
    const img = ts.isIdentifier(n) ? images[n.text] : undefined;
    return { kind: 'code', text: t.length > 160 ? `${t.slice(0, 157)}…` : t, line: line(n), path: p, comment, image: img };
  };

  for (const s of sf.statements) {
    const exported = ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(s) && exported) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const u = unwrap(d.initializer);
        if (ts.isArrowFunction(u) || ts.isFunctionExpression(u) || ts.isClassExpression(u)) continue;
        const node = toNode(d.initializer, [d.name.text]);
        if (node.kind === 'code') continue;
        out.push({ name: d.name.text, comment: commentBefore(text, s), line: line(d), node });
      }
    } else if (ts.isExportAssignment(s) && !s.isExportEquals) {
      const node = toNode(s.expression, ['default']);
      if (node.kind !== 'code') out.push({ name: 'default', comment: commentBefore(text, s), line: line(s), node });
    }
  }
  return out;
}

/** Finds the expression node for a path like ['site', 'phone'] or ['team', 0, 'name']. */
function findExpr(sf: ts.SourceFile, p: Key[]): ts.Expression {
  const [head, ...rest] = p;
  let cur: ts.Expression | undefined;
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === head && d.initializer) cur = d.initializer;
    } else if (head === 'default' && ts.isExportAssignment(s)) cur = s.expression;
  }
  if (!cur) throw new Error(`Export "${head}" not found — the file may have changed. Reload and try again.`);
  for (const k of rest) {
    const u = unwrap(cur);
    let next: ts.Expression | undefined;
    if (typeof k === 'number' && ts.isArrayLiteralExpression(u)) next = u.elements[k];
    else if (ts.isObjectLiteralExpression(u)) {
      for (const prop of u.properties) if (ts.isPropertyAssignment(prop) && propName(prop.name) === String(k)) next = prop.initializer;
    }
    if (!next) throw new Error(`Field "${p.join('.')}" not found — the file may have changed. Reload and try again.`);
    cur = next;
  }
  return cur;
}

function literal(value: string | number | boolean | null, original?: ts.Expression): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'boolean') return String(value);
  const o = original ? unwrapShallow(original) : undefined;
  if ((o && ts.isNoSubstitutionTemplateLiteral(o)) || value.includes('\n')) return '`' + value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
  const q = o && ts.isStringLiteral(o) && o.getText().startsWith('"') ? '"' : "'";
  return q + value.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`).replace(/\r/g, '\\r') + q;
}

function lineIndent(text: string, pos: number) {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))![0];
}

/** Blank copy of a value's source, used when adding a new list item. */
function emptyLike(e: ts.Expression): string | null {
  const u = unwrapShallow(e);
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return "''";
  if (ts.isNumericLiteral(u)) return '0';
  if (u.kind === ts.SyntaxKind.TrueKeyword || u.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  return null;
}

function applyTsOp(text: string, sf: ts.SourceFile, op: DataOp): string {
  const target = findExpr(sf, op.path);
  if (op.op === 'add') {
    const arr = unwrap(target);
    if (!ts.isArrayLiteralExpression(arr) || !arr.elements.length) throw new Error('Can only add to a non-empty list. Add the first item in the code.');
    const last = arr.elements[arr.elements.length - 1];
    const copy = emptyLike(last) ?? last.getText();
    return insertAfter(text, last, copy);
  }
  const parentPath = op.path.slice(0, -1);
  const idx = op.path[op.path.length - 1];
  const arr = unwrap(findExpr(sf, parentPath));
  if (!ts.isArrayLiteralExpression(arr) || typeof idx !== 'number') throw new Error('Not a list item.');
  const els = arr.elements;
  const el = els[idx];
  if (op.op === 'duplicate') return insertAfter(text, el, el.getText());
  if (op.op === 'remove') {
    if (els.length === 1) return text.slice(0, arr.getStart() + 1) + text.slice(arr.getEnd() - 1).replace(/^\s*/, '');
    if (idx > 0) return text.slice(0, els[idx - 1].getEnd()) + text.slice(el.getEnd());
    return text.slice(0, el.getStart()) + text.slice(els[1].getStart());
  }
  const other = op.op === 'up' ? idx - 1 : idx + 1;
  if (other < 0 || other >= els.length) return text;
  const [a, b] = idx < other ? [el, els[other]] : [els[other], el];
  return text.slice(0, a.getStart()) + b.getText() + text.slice(a.getEnd(), b.getStart()) + a.getText() + text.slice(b.getEnd());
}

function insertAfter(text: string, el: ts.Node, copy: string) {
  // multiline list → new line with the same indentation; inline list → ", copy"
  const multiline = text.slice(el.getFullStart(), el.getStart()).includes('\n');
  const sep = multiline ? `,\n${lineIndent(text, el.getStart())}` : ', ';
  return text.slice(0, el.getEnd()) + sep + copy + text.slice(el.getEnd());
}

// ---------- plain value ops (JSON / YAML) ----------

function getAt(obj: any, p: Key[]) {
  return p.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function applyValueOp(root: any, op: DataOp) {
  if (op.op === 'add') {
    const arr = getAt(root, op.path);
    if (!Array.isArray(arr) || !arr.length) throw new Error('Can only add to a non-empty list.');
    const last = arr[arr.length - 1];
    arr.push(typeof last === 'string' ? '' : typeof last === 'number' ? 0 : typeof last === 'boolean' ? false : structuredClone(last));
    return;
  }
  const arr = getAt(root, op.path.slice(0, -1));
  const i = op.path[op.path.length - 1] as number;
  if (!Array.isArray(arr)) throw new Error('Not a list item.');
  if (op.op === 'duplicate') arr.splice(i + 1, 0, structuredClone(arr[i]));
  else if (op.op === 'remove') arr.splice(i, 1);
  else {
    const j = op.op === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < arr.length) [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Applies value edits, then an optional list operation, and writes the file. */
export function saveDataFile(root: string, rel: string, edits: DataEdit[], op?: DataOp) {
  const abs = resolveInRoot(root, rel);
  const ext = path.extname(abs).slice(1).toLowerCase();
  let text = fs.readFileSync(abs, 'utf8');

  if (ext === 'json' || ext === 'yaml' || ext === 'yml') {
    const isJson = ext === 'json';
    const doc = isJson ? null : parseDocument(text);
    const wrapper = { default: isJson ? JSON.parse(text) : doc!.toJS() };
    for (const e of edits) {
      const parent = getAt(wrapper, e.path.slice(0, -1));
      if (parent == null) throw new Error(`Field "${e.path.join('.')}" not found.`);
      parent[e.path[e.path.length - 1]] = e.value;
    }
    if (op) applyValueOp(wrapper, op);
    if (isJson) {
      const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
      text = JSON.stringify(wrapper.default, null, indent) + '\n';
    } else if (!op) {
      for (const e of edits) doc!.setIn(e.path.slice(1), e.value);
      text = doc!.toString();
    } else {
      const d = parseDocument('');
      d.contents = d.createNode(wrapper.default) as never;
      text = d.toString();
    }
    fs.writeFileSync(abs, text);
    return;
  }

  // TS/JS: replace literal spans one by one (re-parsing keeps positions right)
  for (const e of edits) {
    const sf = parse(abs, text);
    const node = findExpr(sf, e.path);
    const u = unwrapShallow(node);
    const isLiteral =
      ts.isStringLiteral(u) ||
      ts.isNoSubstitutionTemplateLiteral(u) ||
      ts.isNumericLiteral(u) ||
      ts.isPrefixUnaryExpression(u) ||
      u.kind === ts.SyntaxKind.TrueKeyword ||
      u.kind === ts.SyntaxKind.FalseKeyword ||
      u.kind === ts.SyntaxKind.NullKeyword;
    if (!isLiteral) throw new Error(`"${e.path.join('.')}" is code, not a plain value. Edit it in the file.`);
    text = text.slice(0, u.getStart()) + literal(e.value, u) + text.slice(u.getEnd());
  }
  if (op) text = applyTsOp(text, parse(abs, text), op);

  // never write a file that no longer parses
  const check = parse(abs, text) as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] };
  if (check.parseDiagnostics?.length) throw new Error(`Edit would break the file: ${ts.flattenDiagnosticMessageText(check.parseDiagnostics[0].messageText, '\n')}`);
  fs.writeFileSync(abs, text);
}
