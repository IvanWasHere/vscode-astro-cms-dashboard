import * as vscode from 'vscode';
import * as path from 'node:path';
import { AstroProject } from './project';
import { DashboardPanel } from './panel';

let project: AstroProject | undefined;

async function resolveProject(pick = false): Promise<AstroProject | undefined> {
  if (project && !pick) return project;
  const roots = (vscode.workspace.workspaceFolders ?? []).flatMap((f) => AstroProject.find(f.uri.fsPath));
  if (!roots.length) {
    vscode.window.showWarningMessage('Astro Dashboard: no astro.config file found in this workspace.');
    return undefined;
  }
  let root = roots[0];
  if (roots.length > 1) {
    const choice = await vscode.window.showQuickPick(
      roots.map((r) => ({ label: path.basename(r), description: r, root: r })),
      { placeHolder: 'Which Astro project?' },
    );
    if (!choice) return undefined;
    root = choice.root;
  }
  project = new AstroProject(root);
  return project;
}

export async function activate(context: vscode.ExtensionContext) {
  const open = async (view?: string) => {
    const p = await resolveProject();
    if (p) DashboardPanel.show(context, p, view);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('astroDashboard.open', () => open()),
    vscode.commands.registerCommand('astroDashboard.media', () => open('media')),
    vscode.commands.registerCommand('astroDashboard.config', () => open('data')),
    vscode.commands.registerCommand('astroDashboard.newCollection', () => open('new-collection')),
    vscode.commands.registerCommand('astroDashboard.newEntry', async () => {
      const p = await resolveProject();
      if (!p) return;
      const cols = p.collections();
      if (!cols.length) return open('new-collection');
      const c = cols.length === 1 ? cols[0] : await vscode.window.showQuickPick(cols.map((x) => ({ label: x.name, c: x }))).then((x) => x?.c);
      if (c) open(`new-entry:${c.name}`);
    }),
  );

  const roots = (vscode.workspace.workspaceFolders ?? []).flatMap((f) => AstroProject.find(f.uri.fsPath));
  vscode.commands.executeCommand('setContext', 'astroDashboard.isAstroProject', roots.length > 0);

  // Activity bar icon: the view is empty (shows welcome buttons); opening it also opens the dashboard.
  const sidebar = vscode.window.createTreeView('astroDashboard.sidebar', {
    treeDataProvider: { getChildren: () => [], getTreeItem: (x: vscode.TreeItem) => x },
  });
  context.subscriptions.push(
    sidebar,
    sidebar.onDidChangeVisibility((e) => {
      if (e.visible && roots.length) open();
    }),
  );
  if (sidebar.visible && roots.length) open();

  if (!roots.length) return;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(dashboard) Dashboard';
  status.tooltip = 'Open Astro Dashboard';
  status.command = 'astroDashboard.open';
  status.show();
  context.subscriptions.push(status);

  // Refresh the dashboard when files change on disk (also edits made in normal editors).
  const watcher = vscode.workspace.createFileSystemWatcher('**/{src,public}/**');
  const cfgWatcher = vscode.workspace.createFileSystemWatcher('**/{astro.config.*,.astro/collections/*.json}');
  let timer: NodeJS.Timeout | undefined;
  const changed = (uri: vscode.Uri) => {
    if (uri.fsPath.includes(`${path.sep}node_modules${path.sep}`)) return;
    clearTimeout(timer);
    timer = setTimeout(() => DashboardPanel.current?.notifyChanged(), 300);
  };
  for (const w of [watcher, cfgWatcher]) {
    w.onDidChange(changed);
    w.onDidCreate(changed);
    w.onDidDelete(changed);
    context.subscriptions.push(w);
  }

  if (vscode.workspace.getConfiguration('astroDashboard').get('openOnStartup')) open();
}

export function deactivate() {}
