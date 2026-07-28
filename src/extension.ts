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
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('servicexCacheView', cacheTreeProvider)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.refreshCache', () => cacheTreeProvider.refresh())
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
      const toDelete = computeCleanPlan(item.entries);
      if (toDelete.length === 0) {
        vscode.window.showInformationMessage(`Nothing to clean for '${item.title}'.`);
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${toDelete.length} cached request(s) for '${item.title}' ` +
          `(older completed runs and any cancelled runs), keeping the most recent completed one?`,
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
