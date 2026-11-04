import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { AstroProject, NewCollectionDef } from './project';
import { DataNode, DataFile, findDataFiles, readDataFile, saveDataFile } from './dataFiles';

type Msg = { id: number; type: string; payload?: any };

const cfg = () => vscode.workspace.getConfiguration('astroDashboard');

export class DashboardPanel {
  static current: DashboardPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private devTerminal: vscode.Terminal | undefined;

  static show(context: vscode.ExtensionContext, project: AstroProject, view?: string) {
    if (DashboardPanel.current && DashboardPanel.current.project.root === project.root) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (view) DashboardPanel.current.navigate(view);
      return;
    }
    DashboardPanel.current?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('astroDashboard', 'Dashboard', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.file(project.root)],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'tab-icon.svg');
    DashboardPanel.current = new DashboardPanel(panel, context, project, view);
  }

  private constructor(
    private panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private project: AstroProject,
    private initialView?: string,
  ) {
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m: Msg) => this.handle(m), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    vscode.window.onDidCloseTerminal((t) => t === this.devTerminal && (this.devTerminal = undefined), null, this.disposables);
  }

  navigate(view: string) {
    this.panel.webview.postMessage({ type: 'navigate', view });
  }

  notifyChanged() {
    this.panel.webview.postMessage({ type: 'changed' });
  }

  private dispose() {
    DashboardPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }

  private async handle(m: Msg) {
    try {
      const result = await this.run(m.type, m.payload ?? {});
      this.panel.webview.postMessage({ id: m.id, ok: true, result });
    } catch (e: any) {
      this.panel.webview.postMessage({ id: m.id, ok: false, error: e?.message ?? String(e) });
    }
  }

  private webUri(rel: string) {
    return this.panel.webview.asWebviewUri(vscode.Uri.file(this.project.abs(rel))).toString();
  }

  private mediaFolders(): string[] {
    return cfg().get<string[]>('mediaFolders') ?? ['src/assets', 'public'];
  }

  private async confirm(message: string, action: string) {
    return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
  }

  private async run(type: string, p: any): Promise<unknown> {
    const pr = this.project;
    switch (type) {
      case 'init': {
        const view = this.initialView;
        this.initialView = undefined;
        return { view, ...(await this.run('overview', {}) as object) };
      }
      case 'overview': {
        const site = pr.siteInfo();
        const collections = pr.collections();
        const recent = collections
          .flatMap((c) => pr.entries(c.name))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 8);
        const media = pr.media(this.mediaFolders());
        return {
          site,
          collections,
          recent,
          mediaCount: media.length,
          mediaSize: media.reduce((s, x) => s + x.size, 0),
          recentMedia: media.filter((x) => x.kind === 'image').slice(0, 6).map((x) => ({ ...x, uri: this.webUri(x.file) })),
          pageCount: pr.pages().length,
          dataFiles: this.dataFiles(),
          devServer: await this.devServerUp(),
          devUrl: cfg().get('devServerUrl'),
          uploadFolder: cfg().get('defaultUploadFolder'),
          mediaFolders: this.mediaFolders(),
        };
      }
      case 'collections':
        return pr.collections();
      case 'entries': {
        const entries = pr.entries(p.collection);
        return entries;
      }
      case 'entry': {
        const e = pr.entry(p.collection, p.id);
        const imageUris: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.data)) {
          if (typeof v === 'string' && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(v)) {
            const abs = v.startsWith('/') ? path.join(pr.root, 'public', v.replace(pr.siteInfo().base, '')) : path.resolve(path.dirname(pr.abs(e.file)), v);
            imageUris[k] = this.panel.webview.asWebviewUri(vscode.Uri.file(abs)).toString();
          }
        }
        return { ...e, imageUris, route: pr.entryRoute(p.collection, e) };
      }
      case 'saveEntry': {
        const r = pr.saveEntry(p.collection, p);
        return r;
      }
      case 'deleteEntry': {
        const e = pr.entry(p.collection, p.id);
        if (!(await this.confirm(`Delete "${e.title}"?\n\n${e.file} will be removed.`, 'Delete'))) return { cancelled: true };
        pr.deleteEntry(p.collection, p.id);
        return { deleted: true };
      }
      case 'duplicateEntry':
        return pr.duplicateEntry(p.collection, p.id, p.locale);
      case 'addCollection': {
        const r = pr.addCollection(p as NewCollectionDef);
        vscode.window.showInformationMessage(`Collection "${p.name}" added to ${r.configFile}. Restart the dev server (or run "astro sync") so Astro picks it up.`);
        return r;
      }
      case 'enableDrafts': {
        const r = pr.enableDrafts(p.collection);
        if (r.changed) {
          vscode.window.showInformationMessage(
            `Added "draft" to ${p.collection} in ${r.configFile}. Make sure your pages skip drafts, e.g. getCollection('${p.collection}', (e) => import.meta.env.DEV || !e.data.draft).`,
          );
        }
        return r;
      }
      case 'dataFiles':
        return this.dataFiles();
      case 'dataFile':
        return this.withImageUris(readDataFile(pr.root, p.file));
      case 'saveDataFile':
        saveDataFile(pr.root, p.file, p.edits ?? [], p.op);
        return this.withImageUris(readDataFile(pr.root, p.file));
      case 'media': {
        const items = pr.media(this.mediaFolders()).map((x) => ({ ...x, uri: this.webUri(x.file) }));
        return { items, folders: this.mediaFolders(), uploadFolder: cfg().get('defaultUploadFolder') };
      }
      case 'uploadMedia': {
        const folder = p.folder || cfg().get('defaultUploadFolder') || 'src/assets';
        const saved: string[] = [];
        for (const f of p.files as { name: string; data: string }[]) {
          saved.push(pr.uploadMedia(folder, f.name, Buffer.from(f.data, 'base64')));
        }
        return { saved };
      }
      case 'pickMedia': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Upload',
          filters: { Media: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'mp4', 'webm', 'mp3', 'pdf'], All: ['*'] },
        });
        if (!picked) return { saved: [] };
        const folder = p.folder || cfg().get('defaultUploadFolder') || 'src/assets';
        const saved: string[] = [];
        for (const u of picked) {
          const bytes = await vscode.workspace.fs.readFile(u);
          saved.push(pr.uploadMedia(folder, path.basename(u.fsPath), bytes));
        }
        return { saved };
      }
      case 'renameMedia': {
        const name = await vscode.window.showInputBox({ prompt: 'New file name', value: path.basename(p.file) });
        if (!name) return { cancelled: true };
        const to = pr.renameMedia(p.file, name);
        if (p.usedIn?.length) {
          vscode.window.showWarningMessage(`Renamed. ${p.usedIn.length} file(s) still reference the old name: ${p.usedIn.join(', ')}`);
        }
        return { file: to };
      }
      case 'deleteMedia': {
        const warn = p.usedIn?.length ? `\n\nStill used in:\n${p.usedIn.join('\n')}` : '';
        if (!(await this.confirm(`Delete ${p.file}?${warn}`, 'Delete'))) return { cancelled: true };
        pr.deleteMedia(p.file);
        return { deleted: true };
      }
      case 'mediaReference':
        return pr.mediaReference(p.media, p.from ?? null, pr.siteInfo().base);
      case 'pages':
        return pr.pages();
      case 'linkTargets':
        return pr.linkTargets();
      case 'openFile': {
        const doc = await vscode.workspace.openTextDocument(pr.abs(p.file));
        const pos = typeof p.line === 'number' ? new vscode.Position(p.line, 0) : undefined;
        await vscode.window.showTextDocument(doc, {
          viewColumn: p.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
          preview: false,
          selection: pos ? new vscode.Range(pos, pos) : undefined,
        });
        return null;
      }
      case 'reveal':
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(pr.abs(p.file)));
        return null;
      case 'copy':
        await vscode.env.clipboard.writeText(p.text);
        vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
        return null;
      case 'preview': {
        const url = `${String(cfg().get('devServerUrl')).replace(/\/$/, '')}${p.route}`;
        if (!(await this.devServerUp())) {
          const start = await vscode.window.showInformationMessage('The Astro dev server is not running.', 'Start dev server');
          if (start) this.startDevServer();
          return { started: !!start };
        }
        if (p.external) vscode.env.openExternal(vscode.Uri.parse(url));
        else vscode.commands.executeCommand('simpleBrowser.show', url);
        return null;
      }
      case 'devServer':
        this.startDevServer();
        return null;
      case 'devStatus':
        return this.devServerUp();
      case 'stopDevServer':
        return this.stopDevServer();
      case 'settings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'astroDashboard');
        return null;
      default:
        throw new Error(`Unknown request: ${type}`);
    }
  }

  private dataFiles() {
    try {
      return findDataFiles(this.project.root, cfg().get<string[]>('configFiles') ?? []);
    } catch {
      return [];
    }
  }

  /** Adds webview URLs for image imports (e.g. `photo: photoTomic`) so the form can show thumbnails. */
  private withImageUris(f: DataFile) {
    const visit = (n: DataNode) => {
      if (n.kind === 'code' && n.image) (n as DataNode & { imageUri?: string }).imageUri = this.webUri(n.image);
      else if (n.kind === 'object') n.entries.forEach((e) => visit(e.node));
      else if (n.kind === 'array') n.items.forEach(visit);
    };
    f.data.forEach((d) => visit(d.node));
    return f;
  }

  /** Our terminal, or one left over from before a window reload. */
  private findDevTerminal() {
    if (this.devTerminal && vscode.window.terminals.includes(this.devTerminal)) return this.devTerminal;
    return (this.devTerminal = vscode.window.terminals.find((t) => t.name === 'Astro dev'));
  }

  /** Runs the project's own astro CLI (falls back to npx). */
  private astroCli(args: string[]): Promise<string> {
    const local = path.join(this.project.root, 'node_modules', '.bin', 'astro');
    const [cmd, argv] = fs.existsSync(local) ? [local, args] : ['npx', ['astro', ...args]];
    return new Promise((resolve) =>
      execFile(cmd, argv, { cwd: this.project.root, timeout: 15000 }, (_err, stdout, stderr) => resolve(`${stdout}\n${stderr}`)),
    );
  }

  private async stopDevServer(): Promise<{ stopped: boolean; message?: string }> {
    const term = this.findDevTerminal();
    if (term) {
      term.sendText('\u0003', false); // Ctrl+C, then close the terminal
      await new Promise((r) => setTimeout(r, 600));
      term.dispose();
      this.devTerminal = undefined;
      await new Promise((r) => setTimeout(r, 400));
      if (!(await this.devServerUp())) return { stopped: true };
    }
    await this.astroCli(['dev', 'stop']);
    await new Promise((r) => setTimeout(r, 300));
    if (!(await this.devServerUp())) return { stopped: true };

    // Started somewhere else (another terminal or tool): ask before killing it.
    const status = await this.astroCli(['dev', 'status']);
    const pid = Number(/pid (\d+)/.exec(status)?.[1]);
    if (!pid) return { stopped: false, message: 'The dev server was started outside the dashboard. Stop it in the terminal where it runs.' };
    const ok = await this.confirm(`The dev server (process ${pid}) was started outside the dashboard. Stop it anyway?`, 'Stop server');
    if (!ok) return { stopped: false };
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e: any) {
      return { stopped: false, message: `Could not stop process ${pid}: ${e.message}` };
    }
    for (let i = 0; i < 10 && (await this.devServerUp()); i++) await new Promise((r) => setTimeout(r, 300));
    return { stopped: !(await this.devServerUp()) };
  }

  private startDevServer() {
    const existing = this.findDevTerminal();
    if (existing) return existing.show();
    this.devTerminal = vscode.window.createTerminal({ name: 'Astro dev', cwd: this.project.root });
    this.devTerminal.show(true);
    this.devTerminal.sendText('npx astro dev');
  }

  private async devServerUp() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      const res = await fetch(String(cfg().get('devServerUrl')), { signal: ctrl.signal, redirect: 'manual' });
      clearTimeout(t);
      return res.status > 0;
    } catch {
      return false;
    }
  }

  private html() {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dashboard.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dashboard.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data: blob:; media-src ${w.cspSource}; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Dashboard</title>
</head>
<body>
<div id="app"><div class="loading">Loading dashboard…</div></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
