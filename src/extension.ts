import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  CacheTreeProvider,
  RequestItem,
  TitleGroupItem,
  computeCleanPlan,
  formatBytes,
  FailureFilter,
  SortBy,
  SortDirection,
} from './cacheTreeProvider';
import { loadConfig, ServiceXConfig } from './config';
import { deleteCacheRecord, deleteAllForTitle, directorySize } from './cacheDb';
import { pickDateFilter, pickFailureFilter, pickMulti } from './filterPrompts';

function resolveConfig(): ServiceXConfig {
  const settings = vscode.workspace.getConfiguration('servicex');
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return loadConfig(settings.get<string>('configPath') || undefined, workspaceFolder);
}

function resolveCachePath(): string {
  return resolveConfig().cachePath;
}

/**
 * Opens `targetPath` as a new VS Code window. Deliberately not "Reveal in
 * Finder/Explorer" (`revealFileInOS`) - that command has no meaningful
 * behavior over Remote-SSH (there's no GUI on a headless analysis-facility
 * login node to show a native file browser on). `vscode.openFolder` is
 * remote-aware instead: giving it a URI stamped with the current workspace's
 * scheme/authority keeps it on the same host (local or the connected SSH
 * remote) without any extra local-vs-remote branching here.
 */
async function openFolderInNewWindow(targetPath: string): Promise<void> {
  if (!fs.existsSync(targetPath)) {
    vscode.window.showInformationMessage(`${targetPath} doesn't exist on disk.`);
    return;
  }
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const targetUri = workspaceUri && workspaceUri.scheme !== 'file'
    ? vscode.Uri.from({ scheme: workspaceUri.scheme, authority: workspaceUri.authority, path: targetPath })
    : vscode.Uri.file(targetPath);
  await vscode.commands.executeCommand('vscode.openFolder', targetUri, true);
}

const SORT_CHOICES: { label: string; sortBy: SortBy; direction: SortDirection }[] = [
  { label: 'Title (A → Z)', sortBy: 'title', direction: 'asc' },
  { label: 'Title (Z → A)', sortBy: 'title', direction: 'desc' },
  { label: 'Date (Newest First)', sortBy: 'date', direction: 'desc' },
  { label: 'Date (Oldest First)', sortBy: 'date', direction: 'asc' },
  { label: 'Total Files (Most First)', sortBy: 'files', direction: 'desc' },
  { label: 'Total Files (Fewest First)', sortBy: 'files', direction: 'asc' },
  { label: 'Total Size (Largest First)', sortBy: 'size', direction: 'desc' },
  { label: 'Total Size (Smallest First)', sortBy: 'size', direction: 'asc' },
];

export function activate(context: vscode.ExtensionContext) {
  const cacheTreeProvider = new CacheTreeProvider();
  const treeView = vscode.window.createTreeView('servicexCacheView', {
    treeDataProvider: cacheTreeProvider,
  });
  context.subscriptions.push(treeView);
  vscode.commands.executeCommand('setContext', 'servicex.groupingEnabled', true);

  /** Shows the total size of everything currently on disk under the cache
   *  path, as a badge next to the view title - always visible, independent
   *  of whatever filter is active. Recomputed straight from disk (not the
   *  provider's fetched entries) so it stays accurate after a delete even
   *  when the tree hasn't been re-fetched yet. */
  const updateCacheSizeLabel = () => {
    try {
      treeView.description = formatBytes(directorySize(resolveConfig().cachePath));
    } catch {
      treeView.description = undefined;
    }
  };
  updateCacheSizeLabel();

  const updateFilterMessage = () => {
    if (!cacheTreeProvider.hasActiveFilter()) {
      treeView.message = undefined;
      return;
    }
    const parts: string[] = [];
    const status = cacheTreeProvider.getStatusFilter();
    if (status) {
      parts.push(`status: ${Array.from(status).join(', ')}`);
    }
    const backend = cacheTreeProvider.getBackendFilter();
    if (backend) {
      parts.push(`backend: ${Array.from(backend).join(', ')}`);
    }
    const failures = cacheTreeProvider.getFailureFilter();
    if (failures !== 'all') {
      parts.push(`failures: ${failures === 'withFailures' ? 'with failures only' : 'without failures only'}`);
    }
    const dateFilter = cacheTreeProvider.getDateFilter();
    if (dateFilter) {
      const from = dateFilter.from ? dateFilter.from.toLocaleDateString() : '…';
      const to = dateFilter.to ? dateFilter.to.toLocaleDateString() : '…';
      parts.push(`date: ${from} → ${to}`);
    }
    treeView.message = `Filtered by ${parts.join(' · ')}`;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.refreshCache', () => {
      cacheTreeProvider.refresh();
      updateCacheSizeLabel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.openCacheRootFolder', async () => {
      await openFolderInNewWindow(resolveConfig().cachePath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.openFilterMenu', async () => {
      await cacheTreeProvider.ensureLoaded();

      const describeSet = (s?: Set<string>) => (s ? Array.from(s).join(', ') : 'All');
      const failureLabel: Record<FailureFilter, string> = {
        all: 'All',
        withFailures: 'With Failures Only',
        withoutFailures: 'Without Failures Only',
      };
      const df = cacheTreeProvider.getDateFilter();
      const dateLabel = df
        ? `${df.from ? df.from.toLocaleDateString() : '…'} → ${df.to ? df.to.toLocaleDateString() : '…'}`
        : 'All Time';

      const items: (vscode.QuickPickItem & { action: string })[] = [
        {
          label: '$(check-all) Status',
          description: describeSet(cacheTreeProvider.getStatusFilter()),
          action: 'status',
        },
        {
          label: '$(server) Backend',
          description: describeSet(cacheTreeProvider.getBackendFilter()),
          action: 'backend',
        },
        {
          label: '$(warning) Failures',
          description: failureLabel[cacheTreeProvider.getFailureFilter()],
          action: 'failures',
        },
        { label: '$(calendar) Date Range', description: dateLabel, action: 'date' },
      ];
      if (cacheTreeProvider.hasActiveFilter()) {
        items.push({ label: '$(clear-all) Clear All Filters', action: 'clear' });
      }

      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Choose a filter to configure' });
      if (!pick) {
        return;
      }

      switch (pick.action) {
        case 'status': {
          const statuses = cacheTreeProvider.getAvailableStatuses();
          if (statuses.length === 0) {
            vscode.window.showInformationMessage('No cached transform requests to filter yet.');
            return;
          }
          const result = await pickMulti(statuses, cacheTreeProvider.getStatusFilter(), 'Show requests with status...');
          if (result !== 'cancel') {
            cacheTreeProvider.setStatusFilter(result);
          }
          break;
        }
        case 'backend': {
          const backends = cacheTreeProvider.getAvailableBackends();
          if (backends.length === 0) {
            vscode.window.showInformationMessage('No cached transform requests to filter yet.');
            return;
          }
          const result = await pickMulti(
            backends,
            cacheTreeProvider.getBackendFilter(),
            'Show requests from backend...'
          );
          if (result !== 'cancel') {
            cacheTreeProvider.setBackendFilter(result);
          }
          break;
        }
        case 'failures': {
          const result = await pickFailureFilter(cacheTreeProvider.getFailureFilter());
          if (result) {
            cacheTreeProvider.setFailureFilter(result);
          }
          break;
        }
        case 'date': {
          const result = await pickDateFilter();
          if (result !== 'cancel') {
            cacheTreeProvider.setDateFilter(result);
          }
          break;
        }
        case 'clear':
          cacheTreeProvider.clearAllFilters();
          break;
      }
      updateFilterMessage();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.clearAllFilters', () => {
      cacheTreeProvider.clearAllFilters();
      updateFilterMessage();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.openSortMenu', async () => {
      const current = cacheTreeProvider.getSort();
      const pick = await vscode.window.showQuickPick(
        SORT_CHOICES.map((choice) => ({
          ...choice,
          description: choice.sortBy === current.sortBy && choice.direction === current.direction ? 'current' : undefined,
        })),
        { placeHolder: 'Sort by...' }
      );
      if (!pick) {
        return;
      }
      cacheTreeProvider.setSort(pick.sortBy, pick.direction);
    })
  );

  const setGrouping = (enabled: boolean) => {
    cacheTreeProvider.setGroupingEnabled(enabled);
    vscode.commands.executeCommand('setContext', 'servicex.groupingEnabled', enabled);
  };

  context.subscriptions.push(vscode.commands.registerCommand('servicex.groupByTitle', () => setGrouping(true)));
  context.subscriptions.push(vscode.commands.registerCommand('servicex.ungroup', () => setGrouping(false)));

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
      updateCacheSizeLabel();
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
      const filterWarning = cacheTreeProvider.hasActiveFilter()
        ? ' A filter is currently active - Clean will still remove matching requests for ' +
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
      updateCacheSizeLabel();
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
    vscode.commands.registerCommand('servicex.openDashboard', async (item: RequestItem) => {
      if (!item) {
        return;
      }
      if (!item.entry.backend) {
        vscode.window.showInformationMessage(
          `Can't open the dashboard for ${item.entry.requestId} - its backend couldn't be determined.`
        );
        return;
      }
      const endpoint = resolveConfig().endpoints.find((e) => e.name === item.entry.backend);
      if (!endpoint) {
        vscode.window.showInformationMessage(
          `Can't open the dashboard for ${item.entry.requestId} - backend '${item.entry.backend}' is not configured.`
        );
        return;
      }
      const url = `${endpoint.endpoint.replace(/\/+$/, '')}/transformation-request/${item.entry.requestId}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.openCacheFolder', async (item: RequestItem) => {
      if (!item) {
        return;
      }
      if (!item.entry.dataDir) {
        vscode.window.showInformationMessage(`No downloaded files to open for ${item.entry.requestId} yet.`);
        return;
      }
      await openFolderInNewWindow(item.entry.dataDir);
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
      updateCacheSizeLabel();
    })
  );
}

export function deactivate() {}
