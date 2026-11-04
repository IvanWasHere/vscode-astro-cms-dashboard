// Serves the real dashboard webview in a normal browser, backed by the real extension code
// (src/panel.ts + src/project.ts, bundled with a fake `vscode` module). Used to take README
// screenshots, and handy for working on the UI without restarting an Extension Development Host.
//
//   node scripts/screenshots/server.cjs [astro-project] [port]
//   open http://localhost:4400/            (optional: ?state={"view":"media"} to open a view)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '../..');
const projectRoot = path.resolve(process.argv[2] ?? path.join(repo, 'example'));
const port = Number(process.argv[3] ?? 4400);
const origin = `http://localhost:${port}`;

const outdir = path.join(repo, 'dist/screenshots');
esbuild.buildSync({
  entryPoints: [path.join(repo, 'src/panel.ts'), path.join(repo, 'src/project.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outdir,
  outExtension: { '.js': '.cjs' },
  external: ['vscode'],
  logLevel: 'warning',
});
// `require('vscode')` inside the bundle gets our shim (one shared instance with this file)
const shimPath = path.join(__dirname, 'vscode-shim.cjs');
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? shimPath : resolve.call(this, request, ...rest);
};
const vscode = require(shimPath);
const { DashboardPanel } = require(path.join(outdir, 'panel.cjs'));
const { AstroProject } = require(path.join(outdir, 'project.cjs'));

// VS Code "Dark Modern" theme colors, as VS Code injects them into webviews
const THEME = {
  'font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
  'editor-font-family': 'Menlo, Monaco, "Courier New", monospace',
  'editor-background': '#1f1f1f',
  'editor-foreground': '#cccccc',
  'sideBar-background': '#181818',
  'editorWidget-background': '#202020',
  'descriptionForeground': '#9d9d9d',
  'panel-border': '#2b2b2b',
  'widget-border': '#313131',
  'input-background': '#313131',
  'input-border': '#3c3c3c',
  'input-foreground': '#cccccc',
  'button-background': '#0078d4',
  'button-foreground': '#ffffff',
  'button-hoverBackground': '#026ec1',
  'button-border': '#ffffff12',
  'button-secondaryBackground': '#313131',
  'button-secondaryForeground': '#cccccc',
  'button-secondaryHoverBackground': '#3c3c3c',
  'badge-background': '#616161',
  'badge-foreground': '#f8f8f8',
  'textLink-foreground': '#4daafc',
  'textCodeBlock-background': '#2b2b2b',
  'focusBorder': '#0078d4',
  'errorForeground': '#f85149',
  'editorWarning-foreground': '#cca700',
  'testing-iconPassed': '#73c991',
  'list-hoverBackground': '#2a2d2e',
  'list-activeSelectionBackground': '#04395e',
  'list-activeSelectionForeground': '#ffffff',
  'notifications-background': '#1f1f1f',
  'notifications-foreground': '#cccccc',
};
const themeCss = `:root{${Object.entries(THEME).map(([k, v]) => `--vscode-${k}:${v}`).join(';')}}`;

// Replaces acquireVsCodeApi(): each message is a POST whose response is the extension's reply.
const bridgeJs = `
(() => {
  const q = new URLSearchParams(location.search);
  let state = q.has('state') ? JSON.parse(q.get('state')) : undefined;
  window.acquireVsCodeApi = () => ({
    postMessage: (m) =>
      fetch('/message', { method: 'POST', body: JSON.stringify(m) })
        .then((r) => r.json())
        .then((reply) => window.dispatchEvent(new MessageEvent('message', { data: reply }))),
    getState: () => state,
    setState: (s) => { state = s; },
  });
})();`;

const context = { extensionUri: vscode.Uri.file(repo) };
const project = new AstroProject(projectRoot);
vscode.bridge.origin = origin;

// Requests get a server-wide id, so replies can't mix up between page loads.
let nextId = 0;
const waiting = new Map(); // server id → { res, id: the page's own id }
vscode.bridge.post = (m) => {
  const w = waiting.get(m.id);
  if (!w) return; // events like "changed" have no request; the preview doesn't need them
  waiting.delete(m.id);
  w.res.writeHead(200, { 'Content-Type': 'application/json' });
  w.res.end(JSON.stringify({ ...m, id: w.id }));
};

function freshPanel() {
  DashboardPanel.current = undefined;
  DashboardPanel.show(context, project);
  // the real CSP allows only the extension's own scripts; add the bridge + theme inline
  return DashboardPanel.current.panel.webview.html
    .replace(/script-src 'nonce-([^']+)'/, (m) => `${m} ${origin}`)
    .replace(/style-src [^;]+/, (m) => `${m} 'unsafe-inline'; connect-src ${origin}`)
    .replace('<link rel="stylesheet"', `<style>${themeCss}</style>\n<script src="/bridge.js"></script>\n<link rel="stylesheet"`);
}

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(freshPanel());
    }
    if (url.pathname === '/bridge.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(bridgeJs);
    }
    if (url.pathname === '/message' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const m = JSON.parse(body);
        const id = ++nextId;
        waiting.set(id, { res, id: m.id });
        vscode.bridge.onMessage?.({ ...m, id });
      });
    }
    if (url.pathname.startsWith('/fs/')) {
      const file = decodeURI(url.pathname.slice(3));
      const allowed = [repo, projectRoot].some((r) => file.startsWith(r + path.sep));
      if (!allowed || !fs.existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404).end();
  })
  .listen(port, () => console.log(`Dashboard webview for ${projectRoot}\n→ ${origin}/`));
