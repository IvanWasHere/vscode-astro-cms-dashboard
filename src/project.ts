// Reads and writes an Astro project on disk: collections, entries, media and pages.
// No VS Code APIs here, so this module can be tested with plain Node.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDocument, stringify } from 'yaml';

export type FieldType = 'string' | 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'tags' | 'image' | 'json';

export interface Field {
  name: string;
  type: FieldType;
  required: boolean;
  default?: unknown;
  options?: string[];
  /** Field exists in entries but not in the schema. */
  extra?: boolean;
}

export interface Collection {
  name: string;
  baseRel: string;
  pattern: string;
  extensions: string[];
  /** 'content' = markdown with a body, 'data' = json/yaml without body. */
  kind: 'content' | 'data';
  fields: Field[];
  schemaSource: 'json-schema' | 'config' | 'inferred';
  localized: boolean;
  locales: string[];
  entryCount: number;
}

export interface EntrySummary {
  collection: string;
  id: string;
  slug: string;
  locale: string | null;
  file: string;
  title: string;
  date: string | null;
  draft: boolean;
  mtime: number;
}

export interface Entry extends EntrySummary {
  data: Record<string, unknown>;
  body: string;
}

export interface MediaItem {
  file: string;
  folder: string;
  name: string;
  ext: string;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  size: number;
  mtime: number;
  usedIn: string[];
}

export interface PageItem {
  file: string;
  route: string;
  locale: string | null;
  kind: 'page' | 'dynamic' | 'endpoint';
  title: string | null;
}

export interface LinkTarget {
  group: string;
  title: string;
  route: string;
  locale: string | null;
  file: string;
  draft: boolean;
}

export interface SiteInfo {
  root: string;
  name: string;
  configFile: string | null;
  contentConfigFile: string | null;
  site: string | null;
  base: string;
  locales: string[];
  defaultLocale: string | null;
  integrations: string[];
  astroVersion: string | null;
}

export interface NewFieldDef {
  name: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  default?: unknown;
}

export interface NewCollectionDef {
  name: string;
  folder?: string;
  kind: 'content' | 'data';
  fields: NewFieldDef[];
  locales?: string[];
}

const CONTENT_EXT = ['md', 'mdx', 'markdoc', 'mdoc'];
const DATA_EXT = ['json', 'yaml', 'yml', 'toml'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'ogv'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac'];
const DOC_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro', '.vercel', '.netlify']);

const IMAGE_FIELD = /^(image|img|cover|thumbnail|thumb|hero|photo|avatar|banner|logo|picture|ogImage|heroImage|coverImage)$/i;
const TEXT_FIELD = /(summary|description|excerpt|abstract|bio|intro|teaser|lead|subtitle)$/i;
const CONFIG_NAMES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js', 'astro.config.cjs'];
const CONTENT_CONFIG_NAMES = ['src/content.config.ts', 'src/content.config.mjs', 'src/content.config.js', 'src/content/config.ts', 'src/content/config.mjs', 'src/content/config.js'];

const toPosix = (p: string) => p.split(path.sep).join('/');
const readText = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walk(full, out);
    else if (d.isFile()) out.push(full);
  }
  return out;
}

/** Splits a markdown file into frontmatter text and body. */
export function splitFrontmatter(src: string): { fm: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { fm: '', body: src };
  return { fm: m[1], body: src.slice(m[0].length) };
}

export function parseFrontmatter(src: string): { data: Record<string, unknown>; body: string } {
  const { fm, body } = splitFrontmatter(src);
  if (!fm.trim()) return { data: {}, body };
  const doc = parseDocument(fm);
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  return { data: typeof data === 'object' && !Array.isArray(data) ? data : {}, body };
}

/** Writes new frontmatter values while keeping comments and key order of the existing YAML. */
export function writeFrontmatter(existing: string | null, data: Record<string, unknown>, body: string): string {
  const { fm } = existing ? splitFrontmatter(existing) : { fm: '' };
  const doc = parseDocument(fm || '{}');
  if (!fm.trim()) doc.contents = doc.createNode({}) as never;
  for (const key of Object.keys(doc.toJS() ?? {})) {
    if (!(key in data)) doc.delete(key);
  }
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') doc.delete(key);
    else doc.set(key, value);
  }
  let yaml = doc.toString({ lineWidth: 0 }).trimEnd();
  if (yaml === '{}') yaml = '';
  const cleanBody = body.replace(/^\r?\n/, '');
  return `---\n${yaml}${yaml ? '\n' : ''}---\n\n${cleanBody.trimEnd()}\n`;
}

export class AstroProject {
  constructor(public root: string) {}

  static find(dir: string, depth = 2): string[] {
    const found: string[] = [];
    const visit = (d: string, level: number) => {
      if (CONFIG_NAMES.some((n) => fs.existsSync(path.join(d, n)))) {
        found.push(d);
        return;
      }
      if (level >= depth) return;
      let children: fs.Dirent[] = [];
      try {
        children = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const c of children) {
        if (c.isDirectory() && !c.name.startsWith('.') && !SKIP_DIRS.has(c.name)) visit(path.join(d, c.name), level + 1);
      }
    };
    visit(dir, 0);
    return found;
  }

  abs(rel: string) {
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`Path is outside the project: ${rel}`);
    return full;
  }

  rel(abs: string) {
    return toPosix(path.relative(this.root, abs));
  }

  // ---------- site ----------

  configFile() {
    const n = CONFIG_NAMES.find((f) => fs.existsSync(path.join(this.root, f)));
    return n ?? null;
  }

  contentConfigFile() {
    return CONTENT_CONFIG_NAMES.find((f) => fs.existsSync(path.join(this.root, f))) ?? null;
  }

  siteInfo(): SiteInfo {
    const configFile = this.configFile();
    const cfg = configFile ? readText(this.abs(configFile)) ?? '' : '';
    const str = (key: string) => {
      const direct = new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`).exec(cfg);
      if (direct) return direct[1];
      // `base,` shorthand or `base: base` → look for `const base = '...'`
      if (new RegExp(`\\b${key}\\s*[,}\\n]|\\b${key}\\s*:\\s*${key}\\b`).test(cfg)) {
        const v = new RegExp(`(?:const|let|var)\\s+${key}\\s*=\\s*['"\`]([^'"\`]*)['"\`]`).exec(cfg);
        if (v) return v[1];
      }
      return null;
    };
    const i18nBlock = /i18n\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(cfg)?.[1] ?? '';
    const localesRaw = /locales\s*:\s*\[([^\]]*)\]/.exec(i18nBlock)?.[1] ?? '';
    const locales = [...localesRaw.matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]);
    const defaultLocale = /defaultLocale\s*:\s*['"]([\w-]+)['"]/.exec(i18nBlock)?.[1] ?? null;
    const integrations = [...cfg.matchAll(/^import\s+(\w+)\s+from\s+['"](@astrojs\/[\w-]+|[\w@/-]+)['"]/gm)]
      .map((m) => m[2])
      .filter((p) => p !== 'astro/config');
    const pkg = JSON.parse(readText(this.abs('package.json')) ?? '{}');
    const installed = JSON.parse(readText(this.abs('node_modules/astro/package.json')) ?? '{}');
    return {
      root: this.root,
      name: pkg.name ?? path.basename(this.root),
      configFile,
      contentConfigFile: this.contentConfigFile(),
      site: str('site'),
      base: (str('base') ?? '').replace(/\/$/, ''),
      locales,
      defaultLocale,
      integrations,
      astroVersion: installed.version ?? pkg.dependencies?.astro ?? pkg.devDependencies?.astro ?? null,
    };
  }

  // ---------- collections ----------

  private collectionBlocks(): { name: string; varName: string; block: string }[] {
    const file = this.contentConfigFile();
    const src = file ? readText(this.abs(file)) ?? '' : '';
    const exp = /export\s+const\s+collections\s*=\s*\{([\s\S]*?)\}/.exec(src);
    if (!exp) return [];
    const names = exp[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [k, v] = s.split(':').map((x) => x.trim().replace(/^['"]|['"]$/g, ''));
        return { name: k, varName: v || k };
      });
    return names.map(({ name, varName }) => {
      const start = src.search(new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*defineCollection\\s*\\(`));
      let block = '';
      if (start >= 0) {
        // take text up to the matching closing parenthesis of defineCollection(
        const open = src.indexOf('(', src.indexOf('defineCollection', start));
        let depth = 0;
        for (let i = open; i < src.length; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')' && --depth === 0) {
            block = src.slice(start, i + 1);
            break;
          }
        }
      }
      return { name, varName, block };
    });
  }

  collections(): Collection[] {
    const locales = this.siteInfo().locales;
    return this.collectionBlocks().map(({ name, block }) => {
      const base = /base\s*:\s*['"`]([^'"`]+)['"`]/.exec(block)?.[1];
      const pattern = /pattern\s*:\s*['"`]([^'"`]+)['"`]/.exec(block)?.[1] ?? '**/*.{md,mdx}';
      const file = /file\s*\(\s*['"`]([^'"`]+)['"`]/.exec(block)?.[1];
      const baseRel = toPosix(path.normalize(base ?? (file ? path.dirname(file) : `src/content/${name}`))).replace(/^\.\//, '');
      const extMatch = /\.\{?([\w,]+)\}?\s*$/.exec(pattern);
      const extensions = extMatch ? extMatch[1].split(',') : ['md', 'mdx'];
      const kind = extensions.some((e) => CONTENT_EXT.includes(e)) ? 'content' : 'data';

      const files = this.entryFiles(baseRel, extensions);
      const datas = files.map((f) => {
        try {
          return this.readData(f);
        } catch {
          return {};
        }
      });

      let fields = this.fieldsFromJsonSchema(name);
      let schemaSource: Collection['schemaSource'] = 'json-schema';
      const configFields = this.fieldsFromZod(block);
      const schemaFile = this.abs(`.astro/collections/${name}.schema.json`);
      const cfgFile = this.contentConfigFile();
      const schemaStale =
        fields && cfgFile && fs.existsSync(schemaFile) && fs.statSync(schemaFile).mtimeMs < fs.statSync(this.abs(cfgFile)).mtimeMs;
      if (!fields || (schemaStale && configFields.length)) {
        fields = configFields;
        schemaSource = 'config';
      }
      // zod knows enums options and image() better than JSON schema
      for (const f of fields) {
        const z = configFields.find((c) => c.name === f.name);
        if (z?.type === 'image' || (z?.type === 'enum' && !f.options)) Object.assign(f, { type: z.type, options: z.options });
      }
      if (!fields.length) schemaSource = 'inferred';
      for (const d of datas) {
        for (const [k, v] of Object.entries(d)) {
          if (!fields.some((f) => f.name === k)) fields.push({ name: k, type: inferType(k, v), required: false, extra: schemaSource !== 'inferred' });
        }
      }

      const rels = files.map((f) => toPosix(path.relative(this.abs(baseRel), f)));
      const firstSegs = new Set(rels.filter((r) => r.includes('/')).map((r) => r.split('/')[0]));
      const entryLocales = [...firstSegs].filter((s) => locales.includes(s));
      const localized = entryLocales.length > 0;
      return {
        name,
        baseRel,
        pattern,
        extensions,
        kind,
        fields,
        schemaSource,
        localized,
        locales: localized ? locales : [],
        entryCount: files.length,
      };
    });
  }

  collection(name: string) {
    const c = this.collections().find((x) => x.name === name);
    if (!c) throw new Error(`Unknown collection: ${name}`);
    return c;
  }

  private fieldsFromJsonSchema(name: string): Field[] | null {
    const raw = readText(this.abs(`.astro/collections/${name}.schema.json`));
    if (!raw) return null;
    let schema: any;
    try {
      schema = JSON.parse(raw);
    } catch {
      return null;
    }
    // data collections are wrapped: { type: object, additionalProperties: {...} } or definitions
    if (!schema.properties && schema.$ref && schema.definitions) {
      schema = schema.definitions[schema.$ref.split('/').pop()];
    }
    if (!schema?.properties) return null;
    const required: string[] = schema.required ?? [];
    return Object.entries<any>(schema.properties)
      .filter(([k]) => k !== '$schema')
      .map(([k, p]) => {
        const s = p.anyOf?.find((x: any) => x.type && x.type !== 'null') ?? p;
        let type: FieldType = 'json';
        let options: string[] | undefined;
        if (s.enum) {
          type = 'enum';
          options = s.enum.map(String);
        } else if (s.type === 'string' && (s.format === 'date-time' || s.format === 'date' || s.format === 'unix-time')) type = 'date';
        else if (s.type === 'string') type = IMAGE_FIELD.test(k) ? 'image' : TEXT_FIELD.test(k) ? 'text' : 'string';
        else if (s.type === 'number' || s.type === 'integer') type = 'number';
        else if (s.type === 'boolean') type = 'boolean';
        else if (s.type === 'array' && (!s.items || s.items.type === 'string')) type = 'tags';
        return { name: k, type, required: required.includes(k) && p.default === undefined, default: p.default, options };
      });
  }

  private fieldsFromZod(block: string): Field[] {
    const obj = /z\.object\s*\(\s*\{([\s\S]*)\}\s*\)/.exec(block)?.[1];
    if (!obj) return [];
    const fields: Field[] = [];
    // only top-level keys: track nesting depth
    let depth = 0;
    let line = '';
    const parts: string[] = [];
    for (const ch of obj) {
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) {
        parts.push(line);
        line = '';
      } else line += ch;
    }
    parts.push(line);
    for (const part of parts) {
      const clean = part.replace(/\/\/.*$/gm, '').trim();
      const m = /^['"]?(\w+)['"]?\s*:\s*([\s\S]+)$/.exec(clean);
      if (!m) continue;
      const [, name, expr] = m;
      let type: FieldType = 'json';
      let options: string[] | undefined;
      if (/^image\(\)/.test(expr)) type = 'image';
      else if (/z\.enum\s*\(/.test(expr)) {
        type = 'enum';
        options = [...(/z\.enum\s*\(\s*\[([^\]]*)\]/.exec(expr)?.[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
      } else if (/^z\.(coerce\.)?date\(/.test(expr)) type = 'date';
      else if (/^z\.(coerce\.)?number\(/.test(expr)) type = 'number';
      else if (/^z\.(coerce\.)?boolean\(/.test(expr)) type = 'boolean';
      else if (/^z\.array\(\s*z\.string\(\)/.test(expr)) type = 'tags';
      else if (/^z\.(coerce\.)?string\(/.test(expr)) type = IMAGE_FIELD.test(name) ? 'image' : TEXT_FIELD.test(name) ? 'text' : 'string';
      const def = /\.default\(\s*([^)]*)\)/.exec(expr)?.[1];
      let defVal: unknown;
      if (def !== undefined) {
        try {
          defVal = JSON.parse(def.replace(/'/g, '"'));
        } catch {
          defVal = undefined;
        }
      }
      fields.push({ name, type, options, required: !/\.(optional|default|nullable|nullish)\(/.test(expr), default: defVal });
    }
    return fields;
  }

  private entryFiles(baseRel: string, extensions: string[]) {
    const base = this.abs(baseRel);
    return walk(base).filter((f) => extensions.includes(path.extname(f).slice(1).toLowerCase()) && !path.basename(f).startsWith('_'));
  }

  private readData(file: string): Record<string, unknown> {
    const src = fs.readFileSync(file, 'utf8');
    const ext = path.extname(file).slice(1).toLowerCase();
    if (ext === 'json') return JSON.parse(src);
    if (ext === 'yaml' || ext === 'yml') return (parseDocument(src).toJS() ?? {}) as Record<string, unknown>;
    return parseFrontmatter(src).data;
  }

  entries(collectionName: string): EntrySummary[] {
    const c = this.collection(collectionName);
    const base = this.abs(c.baseRel);
    return this.entryFiles(c.baseRel, c.extensions)
      .map((f) => this.summarize(c, base, f))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.title.localeCompare(b.title));
  }

  private summarize(c: Collection, base: string, file: string): EntrySummary {
    let data: Record<string, unknown> = {};
    try {
      data = this.readData(file);
    } catch {
      /* broken frontmatter: still list the file */
    }
    const id = toPosix(path.relative(base, file)).replace(/\.[^.]+$/, '');
    const seg = id.split('/');
    const locale = c.localized && seg.length > 1 && c.locales.includes(seg[0]) ? seg[0] : null;
    const slug = locale ? seg.slice(1).join('/') : id;
    const dateVal = data.date ?? data.pubDate ?? data.publishDate ?? data.published ?? data.updatedDate;
    return {
      collection: c.name,
      id,
      slug,
      locale,
      file: this.rel(file),
      title: String(data.title ?? data.name ?? data.heading ?? slug),
      date: dateVal ? normalizeDate(dateVal) : null,
      draft: data.draft === true || data.published === false,
      mtime: fs.statSync(file).mtimeMs,
    };
  }

  entry(collectionName: string, id: string): Entry {
    const c = this.collection(collectionName);
    const file = this.findEntryFile(c, id);
    const src = fs.readFileSync(file, 'utf8');
    const ext = path.extname(file).slice(1);
    let data: Record<string, unknown>;
    let body = '';
    if (CONTENT_EXT.includes(ext)) ({ data, body } = parseFrontmatter(src));
    else data = this.readData(file);
    for (const [k, v] of Object.entries(data)) if (v instanceof Date) data[k] = normalizeDate(v);
    return { ...this.summarize(c, this.abs(c.baseRel), file), data, body };
  }

  private findEntryFile(c: Collection, id: string) {
    for (const ext of c.extensions) {
      const f = this.abs(path.join(c.baseRel, `${id}.${ext}`));
      if (fs.existsSync(f)) return f;
    }
    throw new Error(`Entry not found: ${c.name}/${id}`);
  }

  /** Creates or updates an entry. Returns the (possibly new) id. */
  saveEntry(collectionName: string, opts: { id?: string; slug: string; locale?: string | null; data: Record<string, unknown>; body: string }) {
    const c = this.collection(collectionName);
    const slug = sanitizeSlug(opts.slug);
    if (!slug) throw new Error('Please enter a slug (file name).');
    const newId = opts.locale ? `${opts.locale}/${slug}` : slug;
    const ext = c.extensions.find((e) => (c.kind === 'content' ? CONTENT_EXT : DATA_EXT).includes(e)) ?? c.extensions[0];
    let oldFile: string | null = null;
    if (opts.id) oldFile = this.findEntryFile(c, opts.id);
    const targetExt = oldFile ? path.extname(oldFile).slice(1) : ext;
    const target = this.abs(path.join(c.baseRel, `${newId}.${targetExt}`));
    if (target !== oldFile && fs.existsSync(target)) throw new Error(`An entry called "${newId}" already exists.`);

    const data = cleanData(opts.data, c.fields);
    let out: string;
    if (targetExt === 'json') out = JSON.stringify(data, null, 2) + '\n';
    else if (targetExt === 'yaml' || targetExt === 'yml') out = stringify(data);
    else out = writeFrontmatter(oldFile ? fs.readFileSync(oldFile, 'utf8') : null, data, opts.body ?? '');

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, out);
    if (oldFile && oldFile !== target) fs.rmSync(oldFile);
    return { id: newId, file: this.rel(target) };
  }

  deleteEntry(collectionName: string, id: string) {
    const c = this.collection(collectionName);
    fs.rmSync(this.findEntryFile(c, id));
  }

  duplicateEntry(collectionName: string, id: string, targetLocale?: string | null) {
    const e = this.entry(collectionName, id);
    let slug = e.slug;
    const locale = targetLocale === undefined ? e.locale : targetLocale;
    const exists = (s: string) => this.entries(collectionName).some((x) => x.slug === s && x.locale === locale);
    if (targetLocale === undefined || exists(slug)) {
      let n = 2;
      while (exists(`${e.slug}-${n}`)) n++;
      slug = `${e.slug}-${n}`;
    }
    return this.saveEntry(collectionName, { slug, locale, data: e.data, body: e.body });
  }

  addCollection(def: NewCollectionDef) {
    const name = def.name.trim();
    if (!/^[a-zA-Z_][\w]*$/.test(name)) throw new Error('Collection name must be a valid identifier (letters, numbers, _).');
    if (this.collectionBlocks().some((b) => b.name === name)) throw new Error(`Collection "${name}" already exists.`);
    const folder = (def.folder?.trim() || `src/content/${name}`).replace(/^\.\//, '').replace(/\/$/, '');
    const pattern = def.kind === 'content' ? '**/*.{md,mdx}' : '**/*.{json,yaml,yml}';
    const usesImage = def.fields.some((f) => f.type === 'image');
    const zod = (f: NewFieldDef) => {
      let e: string;
      switch (f.type) {
        case 'number':
          e = 'z.number()';
          break;
        case 'boolean':
          e = 'z.boolean()';
          break;
        case 'date':
          e = 'z.coerce.date()';
          break;
        case 'tags':
          e = 'z.array(z.string())';
          break;
        case 'image':
          e = 'image()';
          break;
        case 'enum':
          e = `z.enum([${(f.options ?? []).map((o) => JSON.stringify(o)).join(', ')}])`;
          break;
        case 'json':
          e = 'z.any()';
          break;
        default:
          e = 'z.string()';
      }
      if (f.type === 'boolean') return `${e}.default(${f.default === true})`;
      if (f.type === 'tags' && !f.required) return `${e}.default([])`;
      return f.required ? e : `${e}.optional()`;
    };
    const fieldLines = def.fields
      .filter((f) => /^[a-zA-Z_]\w*$/.test(f.name))
      .map((f) => `    ${f.name}: ${zod(f)},`)
      .join('\n');
    const schema = usesImage ? `({ image }) =>\n    z.object({\n${fieldLines.replace(/^/gm, '  ')}\n    })` : `z.object({\n${fieldLines}\n  })`;
    const snippet = `const ${name} = defineCollection({\n  loader: glob({ pattern: '${pattern}', base: './${folder}' }),\n  schema: ${schema},\n});\n`;

    const rel = this.contentConfigFile() ?? 'src/content.config.ts';
    const file = this.abs(rel);
    let src = readText(file) ?? '';
    if (!src.trim()) {
      src = `import { defineCollection } from 'astro:content';\nimport { glob } from 'astro/loaders';\nimport { z } from 'astro/zod';\n\n${snippet}\nexport const collections = { ${name} };\n`;
    } else {
      src = ensureImport(src, 'defineCollection', 'astro:content');
      src = ensureImport(src, 'glob', 'astro/loaders');
      if (!/\bimport\s*\{[^}]*\bz\b[^}]*\}\s*from/.test(src)) src = ensureImport(src, 'z', 'astro/zod');
      const exp = /export\s+const\s+collections\s*=\s*\{([\s\S]*?)\}/.exec(src);
      if (!exp) {
        src = `${src.trimEnd()}\n\n${snippet}\nexport const collections = { ${name} };\n`;
      } else {
        const inner = exp[1].replace(/,\s*$/, '').trimEnd();
        const multiline = inner.includes('\n');
        const newInner = !inner.trim() ? ` ${name} ` : multiline ? `${inner},\n  ${name},\n` : `${inner.trimEnd()}, ${name} `;
        const newExport = `export const collections = {${newInner}}`;
        src = src.slice(0, exp.index) + snippet + '\n' + newExport + src.slice(exp.index + exp[0].length);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, src);
    const base = this.abs(folder);
    fs.mkdirSync(base, { recursive: true });
    for (const l of def.locales ?? []) fs.mkdirSync(path.join(base, l), { recursive: true });
    // keep empty folders in git
    const dirs = def.locales?.length ? def.locales.map((l) => path.join(base, l)) : [base];
    for (const d of dirs) if (!fs.readdirSync(d).length) fs.writeFileSync(path.join(d, '.gitkeep'), '');
    return { configFile: rel, folder };
  }

  /** Adds `draft: z.boolean().default(false)` to a collection's schema in the content config. */
  enableDrafts(collectionName: string) {
    const rel = this.contentConfigFile();
    if (!rel) throw new Error('No content config file found.');
    const file = this.abs(rel);
    const src = fs.readFileSync(file, 'utf8');
    const b = this.collectionBlocks().find((x) => x.name === collectionName);
    if (!b?.block) throw new Error(`Could not find defineCollection() for "${collectionName}".`);
    if (/\bdraft\s*:/.test(b.block)) return { configFile: rel, changed: false };
    const start = src.indexOf(b.block);
    const obj = b.block.search(/z\.object\s*\(\s*\{/);
    if (obj < 0) throw new Error(`"${collectionName}" has no z.object({...}) schema to extend.`);
    const open = b.block.indexOf('{', obj);
    let depth = 0;
    let close = -1;
    for (let i = open; i < b.block.length; i++) {
      if (b.block[i] === '{') depth++;
      else if (b.block[i] === '}' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) throw new Error('Could not parse the schema object.');
    const inner = b.block.slice(open + 1, close);
    const lines = inner.split('\n').filter((l) => l.trim());
    const indent = /^\s*/.exec(lines[lines.length - 1] ?? '')?.[0] || '    ';
    const trimmed = inner.trimEnd();
    const sep = !trimmed.trim() || trimmed.endsWith(',') ? '' : ',';
    const closingWs = inner.slice(trimmed.length);
    const newInner = inner.includes('\n')
      ? `${trimmed}${sep}\n${indent}draft: z.boolean().default(false),${closingWs}`
      : `${trimmed}${sep} draft: z.boolean().default(false) `;
    const newBlock = b.block.slice(0, open + 1) + newInner + b.block.slice(close);
    fs.writeFileSync(file, src.slice(0, start) + newBlock + src.slice(start + b.block.length));
    return { configFile: rel, changed: true };
  }

  // ---------- media ----------

  media(folders: string[]): MediaItem[] {
    const files = folders.flatMap((f) => {
      try {
        return walk(this.abs(f)).map((file) => ({ file, folder: f }));
      } catch {
        return [];
      }
    });
    const usage = this.usageIndex();
    return files
      .filter(({ file }) => !/\.(DS_Store|gitkeep)$/.test(file))
      .map(({ file, folder }) => {
        const ext = path.extname(file).slice(1).toLowerCase();
        const stat = fs.statSync(file);
        const name = path.basename(file);
        return {
          file: this.rel(file),
          folder,
          name,
          ext,
          kind: IMAGE_EXT.includes(ext) ? 'image' : VIDEO_EXT.includes(ext) ? 'video' : AUDIO_EXT.includes(ext) ? 'audio' : DOC_EXT.includes(ext) ? 'document' : 'other',
          size: stat.size,
          mtime: stat.mtimeMs,
          usedIn: usage.filter((u) => u.text.includes(name)).map((u) => u.file),
        } as MediaItem;
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  private usageIndex() {
    return walk(this.abs('src'))
      .filter((f) => /\.(astro|md|mdx|ts|tsx|js|jsx|mjs|vue|svelte|json|ya?ml|css|scss)$/.test(f))
      .map((f) => ({ file: this.rel(f), text: fs.readFileSync(f, 'utf8') }));
  }

  uploadMedia(folderRel: string, name: string, bytes: Uint8Array) {
    const safe = name.replace(/[^\w.\-]+/g, '-').replace(/^-+/, '') || 'upload';
    const dir = this.abs(folderRel);
    fs.mkdirSync(dir, { recursive: true });
    let target = path.join(dir, safe);
    const { name: stem, ext } = path.parse(safe);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${stem}-${n}${ext}`);
    fs.writeFileSync(target, bytes);
    return this.rel(target);
  }

  renameMedia(fileRel: string, newName: string) {
    const from = this.abs(fileRel);
    const safe = newName.trim().replace(/[^\w.\-]+/g, '-');
    if (!safe) throw new Error('Invalid file name.');
    const to = path.join(path.dirname(from), safe);
    if (fs.existsSync(to)) throw new Error(`"${safe}" already exists.`);
    fs.renameSync(from, to);
    return this.rel(to);
  }

  deleteMedia(fileRel: string) {
    fs.rmSync(this.abs(fileRel));
  }

  /** How to reference a media file from a given entry file (relative import for src/, URL for public/). */
  mediaReference(mediaRel: string, fromFileRel: string | null, base: string) {
    if (mediaRel.startsWith('public/')) return `${base}/${mediaRel.slice('public/'.length)}`;
    if (!fromFileRel) return `/${mediaRel}`;
    let r = toPosix(path.relative(path.dirname(this.abs(fromFileRel)), this.abs(mediaRel)));
    if (!r.startsWith('.')) r = `./${r}`;
    return r;
  }

  // ---------- routes for entries ----------

  /** Does this file (or files it imports, up to `depth` levels) read the collection? */
  private usesCollection(fileAbs: string, name: string, depth = 2, seen = new Set<string>()): boolean {
    if (seen.has(fileAbs) || !fs.existsSync(fileAbs)) return false;
    seen.add(fileAbs);
    const src = fs.readFileSync(fileAbs, 'utf8');
    if (new RegExp(`get(Collection|Entry|Entries)\\s*\\(\\s*['"\`]${name}['"\`]`).test(src)) return true;
    if (depth === 0) return false;
    for (const m of src.matchAll(/import\s+[^'"]*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const spec = path.resolve(path.dirname(fileAbs), m[1]);
      const candidates = [spec, ...['.ts', '.js', '.mjs', '.astro'].map((e) => spec + e), path.join(spec, 'index.ts')];
      const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (hit && this.usesCollection(hit, name, depth - 1, seen)) return true;
    }
    return false;
  }

  /** Best guess of the URL an entry is published at, e.g. /blog/my-post/. */
  entryRoute(collectionName: string, entry: { slug: string; locale: string | null }): string | null {
    const dynamic = this.pages().filter((p) => p.kind === 'dynamic' && /\[\.{0,3}\w+\]\/?$/.test(p.route));
    const matches = dynamic.filter((p) => this.usesCollection(this.abs(p.file), collectionName));
    const page = matches.find((p) => !entry.locale || p.locale === entry.locale) ?? matches[0];
    if (!page) return null;
    return page.route.replace(/\[\.{0,3}\w+\]\/?$/, `${entry.slug}/`);
  }

  /** Everything you can link to inside the site: static pages and collection entries with a URL. */
  linkTargets(): LinkTarget[] {
    const pages = this.pages();
    const out: LinkTarget[] = [];
    for (const p of pages) {
      if (p.kind !== 'page' || /\/404\/?$/.test(p.route)) continue;
      const last = p.route.replace(/\/$/, '').split('/').pop() ?? '';
      const isHome = p.route.replace(/\/$/, '') === this.siteInfo().base || (p.locale && last === p.locale);
      const title = p.title ?? (isHome ? 'Home' : humanizeSlug(last));
      out.push({ group: 'Pages', title, route: p.route, locale: p.locale, file: p.file, draft: false });
    }
    // one route lookup per collection + locale (it scans page imports)
    const routeFor = new Map<string, string | null>();
    for (const c of this.collections()) {
      for (const e of this.entries(c.name)) {
        const key = `${c.name}|${e.locale}`;
        if (!routeFor.has(key)) routeFor.set(key, this.entryRoute(c.name, { slug: '__SLUG__', locale: e.locale }));
        const tpl = routeFor.get(key);
        if (!tpl) continue;
        out.push({ group: c.name, title: e.title, route: tpl.replace('__SLUG__', e.slug), locale: e.locale, file: e.file, draft: e.draft });
      }
    }
    return out;
  }

  // ---------- pages ----------

  pages(): PageItem[] {
    const info = this.siteInfo();
    const dir = this.abs('src/pages');
    return walk(dir)
      .filter((f) => /\.(astro|md|mdx|html|ts|js)$/.test(f))
      .map((f) => {
        const rel = toPosix(path.relative(dir, f));
        const isEndpoint = /\.(ts|js)$/.test(rel);
        let route = rel.replace(/\.[^.]+$/, '').replace(/(^|\/)index$/, '');
        if (isEndpoint) route = rel.replace(/\.(ts|js)$/, '');
        const seg = route.split('/');
        const locale = info.locales.includes(seg[0]) && seg[0] !== info.defaultLocale ? seg[0] : info.locales.length ? info.defaultLocale : null;
        const src = fs.readFileSync(f, 'utf8');
        const title =
          /^title\s*:\s*['"]?(.+?)['"]?\s*$/m.exec(splitFrontmatter(src).fm)?.[1] ??
          /\btitle\s*=\s*["']([^"'{]+)["']/.exec(src)?.[1] ??
          /<title>([^<{]+)<\/title>/.exec(src)?.[1] ??
          /<h1[^>]*>([^<{]+)<\/h1>/.exec(src)?.[1] ??
          null;
        return {
          file: this.rel(f),
          route: `${info.base}/${route}${route && !isEndpoint ? '/' : ''}`.replace(/\/+/g, '/'),
          locale,
          kind: isEndpoint ? 'endpoint' : /\[/.test(rel) ? 'dynamic' : 'page',
          title: title?.trim() ?? null,
        } as PageItem;
      })
      .sort((a, b) => a.route.localeCompare(b.route));
  }
}

function ensureImport(src: string, name: string, from: string) {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${from.replace('/', '\\/')}['"];?`);
  const m = re.exec(src);
  if (m) {
    if (new RegExp(`\\b${name}\\b`).test(m[1])) return src;
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    return src.replace(m[0], `import { ${[...names, name].join(', ')} } from '${from}';`);
  }
  if (new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(src)) return src;
  const lastImport = [...src.matchAll(/^import .*$/gm)].pop();
  const line = `import { ${name} } from '${from}';`;
  if (!lastImport) return `${line}\n${src}`;
  const at = lastImport.index! + lastImport[0].length;
  return `${src.slice(0, at)}\n${line}${src.slice(at)}`;
}

function humanizeSlug(s: string) {
  return s.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function inferType(key: string, v: unknown): FieldType {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))) return 'date';
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return 'tags';
  if (typeof v === 'string') return IMAGE_FIELD.test(key) ? 'image' : TEXT_FIELD.test(key) || v.length > 80 ? 'text' : 'string';
  return 'json';
}

function normalizeDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function sanitizeSlug(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^[-/]+|[-/]+$)/g, '');
}

function cleanData(data: Record<string, unknown>, fields: Field[]) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const f = fields.find((x) => x.name === k);
    if (v === '' || v === null || v === undefined) continue;
    if (f?.type === 'number' && typeof v === 'string') out[k] = Number(v);
    else if (f?.type === 'boolean') {
      // don't write booleans that equal their default
      if (v === (f.default ?? false) && !f.required) continue;
      out[k] = v;
    } else if (f?.type === 'tags' && typeof v === 'string') out[k] = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (f?.type === 'json' && typeof v === 'string') {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else out[k] = v;
  }
  return out;
}
