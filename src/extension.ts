import * as vscode from 'vscode';
import { CacheTreeProvider, RequestItem, TitleGroupItem, computeCleanPlan } from './cacheTreeProvider';
import { loadConfig } from './config';
import { deleteCacheRecord, deleteAllForTitle } from './cacheDb';

function resolveCachePath(): string {
  const settings = vscode.workspace.getConfiguration('servicex');
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return loadConfig(settings.get<string>('configPath') || undefined, workspaceFolder).cachePath;
}

export function activate(context: vscode.ExtensionContext) {
  const cacheTreeProvider = new CacheTreeProvider();
  const treeView = vscode.window.createTreeView('servicexCacheView', {
    treeDataProvider: cacheTreeProvider,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.refreshCache', () => cacheTreeProvider.refresh())
  );

  const applyStatusFilter = (filter: Set<string> | undefined) => {
    cacheTreeProvider.setStatusFilter(filter);
    vscode.commands.executeCommand('setContext', 'servicex.statusFilterActive', filter !== undefined);
    treeView.message = filter ? `Filtered by status: ${Array.from(filter).join(', ')}` : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.filterByStatus', async () => {
      await cacheTreeProvider.ensureLoaded();
      const statuses = cacheTreeProvider.getAvailableStatuses();
      if (statuses.length === 0) {
        vscode.window.showInformationMessage('No cached transform requests to filter yet.');
        return;
      }
      const current = cacheTreeProvider.getStatusFilter();
      const picks = await vscode.window.showQuickPick(
        statuses.map((status) => ({ label: status, picked: !current || current.has(status) })),
        { canPickMany: true, placeHolder: 'Show requests with status...' }
      );
      if (!picks) {
        return;
      }
      const selected = new Set(picks.map((p) => p.label));
      applyStatusFilter(selected.size === statuses.length ? undefined : selected);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.clearStatusFilter', () => applyStatusFilter(undefined))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.deleteFromCache', async (item: RequestItem) => {
      if (!item) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete cached files for '${item.entry.title}' (${item.entry.requestId})?`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') {
        return;
      }
      const deleted = deleteCacheRecord(resolveCachePath(), item.entry.requestId);
      vscode.window.showInformationMessage(
        deleted
          ? `Deleted cached files for ${item.entry.requestId}.`
          : `No cached files found for ${item.entry.requestId}.`
      );
      cacheTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.cleanGroup', async (item: TitleGroupItem) => {
      if (!item) {
        return;
      }
      const toDelete = computeCleanPlan(item.allEntries);
      if (toDelete.length === 0) {
        vscode.window.showInformationMessage(`Nothing to clean for '${item.title}'.`);
        return;
      }
      const filterWarning = cacheTreeProvider.getStatusFilter()
        ? ' A status filter is currently active - Clean will still remove matching requests for ' +
          "this title even if they aren't shown in the tree right now."
        : '';
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${toDelete.length} cached request(s) for '${item.title}' ` +
          `(older completed runs and any cancelled runs), keeping the most recent completed one?` +
          filterWarning,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') {
        return;
      }
      const cachePath = resolveCachePath();
      let count = 0;
      for (const e of toDelete) {
        if (deleteCacheRecord(cachePath, e.requestId)) {
          count++;
        }
      }
      vscode.window.showInformationMessage(`Deleted ${count} cached request(s) for '${item.title}'.`);
      cacheTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.copyRequestId', async (item: RequestItem) => {
      if (!item) {
        return;
      }
      await vscode.env.clipboard.writeText(item.entry.requestId);
      vscode.window.setStatusBarMessage(`Copied request ID: ${item.entry.requestId}`, 3000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.copyFileList', async (item: RequestItem) => {
      if (!item) {
        return;
      }
      const fileList = item.entry.fileList ?? [];
      if (fileList.length === 0) {
        vscode.window.showInformationMessage(
          `No downloaded files to copy for ${item.entry.requestId}.`
        );
        return;
      }
      await vscode.env.clipboard.writeText(fileList.join('\n'));
      vscode.window.setStatusBarMessage(`Copied ${fileList.length} file path(s) to clipboard`, 3000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.deleteGroup', async (item: TitleGroupItem) => {
      if (!item) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete ALL ${item.entries.length} cached request(s) for '${item.title}'? This cannot be undone.`,
        { modal: true },
        'Delete All'
      );
      if (confirm !== 'Delete All') {
        return;
      }
      const count = deleteAllForTitle(resolveCachePath(), item.title);
      vscode.window.showInformationMessage(`Deleted ${count} cached request(s) for '${item.title}'.`);
      cacheTreeProvider.refresh();
    })
  );
}

export function deactivate() {}
