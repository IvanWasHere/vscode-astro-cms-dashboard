// Minimal stand-in for the `vscode` module, so src/panel.ts can run in plain Node and serve its
// webview to a normal browser (see server.cjs). Only what panel.ts uses is implemented; dialogs
// and editor actions are logged and answered with "cancel".
const path = require('node:path');
const pkg = require('../../package.json');

const log = (...a) => console.log('[vscode]', ...a);
const disposable = () => ({ dispose() {} });
const event = () => disposable;

class Uri {
  constructor(fsPath, str) {
    this.fsPath = fsPath;
    this.str = str;
  }
  static file(p) { return new Uri(p); }
  static joinPath(u, ...parts) { return new Uri(path.join(u.fsPath, ...parts)); }
  static parse(s) { return new Uri(null, s); }
  toString() { return this.str ?? `file://${this.fsPath}`; }
}

const defaults = Object.fromEntries(
  Object.entries(pkg.contributes.configuration.properties).map(([k, v]) => [k.replace(/^astroDashboard\./, ''), v.default]),
);

// The server sets these to connect the panel to the browser.
const bridge = { origin: 'http://localhost', post: (m) => log('postMessage', m), onMessage: null, settings: {} };

const window = {
  terminals: [],
  createWebviewPanel(_id, title) {
    const webview = {
      html: '',
      cspSource: bridge.origin,
      asWebviewUri: (u) => `${bridge.origin}/fs${encodeURI(u.fsPath)}`,
      onDidReceiveMessage(cb) { bridge.onMessage = cb; return disposable(); },
      postMessage(m) { bridge.post(m); return Promise.resolve(true); },
    };
    return { title, webview, reveal() {}, dispose() {}, onDidDispose: event() };
  },
  onDidCloseTerminal: event(),
  showInformationMessage: async (m) => log('info:', m),
  showWarningMessage: async (m) => log('warning (answered cancel):', m),
  showErrorMessage: async (m) => log('error:', m),
  showInputBox: async (o) => log('input box (cancelled):', o?.prompt),
  showOpenDialog: async () => log('open dialog (cancelled)'),
  showTextDocument: async (d) => log('open file:', d?.uri?.fsPath),
  setStatusBarMessage: (m) => log('status:', m),
  createTerminal: (o) => { log('terminal:', o?.name); return { sendText() {}, show() {}, dispose() {} }; },
};

module.exports = {
  bridge,
  Uri,
  window,
  ViewColumn: { Active: -1, Beside: -2 },
  Position: class { constructor(line, ch) { Object.assign(this, { line, ch }); } },
  Range: class { constructor(a, b) { Object.assign(this, { a, b }); } },
  Disposable: class { dispose() {} },
  workspace: {
    getConfiguration: () => ({ get: (k) => (k in bridge.settings ? bridge.settings[k] : defaults[k]) }),
    openTextDocument: async (p) => ({ uri: { fsPath: p } }),
  },
  commands: { executeCommand: async (...a) => log('command:', ...a) },
  env: { clipboard: { writeText: async (t) => log('copied:', t) }, openExternal: async (u) => log('open:', String(u)) },
};
