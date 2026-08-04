import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CacheEntry,
  CacheTreeProvider,
  DASHBOARD_SOURCE,
  RequestItem,
  TitleGroupItem,
  computeCleanPlan,
  formatBytes,
  getServiceXApi,
  groupByTitle,
  isTerminalStatus,
  FailureFilter,
  SortBy,
  SortDirection,
} from './cacheTreeProvider';
import { loadConfig, ServiceXConfig, EndpointConfig } from './config';
import { deleteCacheRecord, directorySize, directoryStats, setLabel } from './cacheDb';
import { pickDateFilter, pickFailureFilter, pickMulti } from './filterPrompts';
import { decodeQastle, pythonInterpreterCandidates } from './pythonBridge';
import {
  DecodedSelection,
  classifySelection,
  decodeSelection,
  prettyPrintQastle,
  renderQueryDocument,
} from './queryDecoder';

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

/**
 * The configured endpoint a request was found on, or undefined (after
 * explaining why in an info message) when there isn't one: a stale request
 * that no backend recognized has none, and a backend the user has since
 * renamed or dropped from servicex.yaml is no longer resolvable. `action`
 * names what the user was trying to do, e.g. "open the dashboard".
 */
function endpointForRequest(entry: CacheEntry, action: string): EndpointConfig | undefined {
  if (!entry.backend) {
    vscode.window.showInformationMessage(
      `Can't ${action} for ${entry.requestId} - its backend couldn't be determined.`
    );
    return undefined;
  }
  const endpoint = resolveConfig().endpoints.find((e) => e.name === entry.backend);
  if (!endpoint) {
    vscode.window.showInformationMessage(
      `Can't ${action} for ${entry.requestId} - backend '${entry.backend}' is not configured.`
    );
    return undefined;
  }
  return endpoint;
}

/**
 * Turn a raw `selection` into the document to show. Everything but qastle
 * decodes in-process; qastle needs a Python interpreter with the qastle
 * package, and falls back to the indented s-expression when there isn't one.
 */
async function decodeForDisplay(selection: string, scriptPath: string): Promise<DecodedSelection> {
  if (classifySelection(selection) === 'qastle') {
    const interpreters = await pythonInterpreterCandidates();
    // func_adl's backend packages wrap the query in one MetaData(...) call
    // per C++ type/method it touches - dozens of them, none hand-written.
    // They're dropped unless the user asks to see them.
    const keepMetadata = vscode.workspace.getConfiguration('servicex').get<boolean>('showQueryMetadata');
    const { source, reason } = await decodeQastle(
      selection,
      scriptPath,
      interpreters,
      keepMetadata ? ['--metadata'] : []
    );
    return source
      ? { kind: 'qastle', body: source, language: 'python' }
      : { kind: 'qastle', body: prettyPrintQastle(selection), language: 'plaintext', warning: reason };
  }
  return (
    decodeSelection(selection) ?? {
      kind: 'unknown',
      body: selection.trim(),
      language: 'plaintext',
    }
  );
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

/** Builds the "Filtered by ..." message shown in a tree view's title bar (or
 *  clears it when nothing is filtered) - shared by the cache and dashboard
 *  panels, which each pass their own provider/treeView. */
function makeUpdateFilterMessage(provider: CacheTreeProvider, treeView: vscode.TreeView<unknown>): () => void {
  return () => {
    if (!provider.hasActiveFilter()) {
      treeView.message = undefined;
      return;
    }
    const parts: string[] = [];
    const status = provider.getStatusFilter();
    if (status) {
      parts.push(`status: ${Array.from(status).join(', ')}`);
    }
    const backend = provider.getBackendFilter();
    if (backend) {
      parts.push(`backend: ${Array.from(backend).join(', ')}`);
    }
    const failures = provider.getFailureFilter();
    if (failures !== 'all') {
      parts.push(`failures: ${failures === 'withFailures' ? 'with failures only' : 'without failures only'}`);
    }
    const dateFilter = provider.getDateFilter();
    if (dateFilter) {
      const from = dateFilter.from ? dateFilter.from.toLocaleDateString() : '…';
      const to = dateFilter.to ? dateFilter.to.toLocaleDateString() : '…';
      parts.push(`date: ${from} → ${to}`);
    }
    treeView.message = `Filtered by ${parts.join(' · ')}`;
  };
}

/** The "Filter..." hub QuickPick and each filter dimension's own picker -
 *  shared by the cache and dashboard panels, which only differ in which
 *  provider they act on and what to say when there's nothing to filter yet. */
async function showFilterMenu(
  provider: CacheTreeProvider,
  onChange: () => void,
  noEntriesMessage: string
): Promise<void> {
  await provider.ensureLoaded();

  const describeSet = (s?: Set<string>) => (s ? Array.from(s).join(', ') : 'All');
  const failureLabel: Record<FailureFilter, string> = {
    all: 'All',
    withFailures: 'With Failures Only',
    withoutFailures: 'Without Failures Only',
  };
  const df = provider.getDateFilter();
  const dateLabel = df
    ? `${df.from ? df.from.toLocaleDateString() : '…'} → ${df.to ? df.to.toLocaleDateString() : '…'}`
    : 'All Time';

  const items: (vscode.QuickPickItem & { action: string })[] = [
    { label: '$(check-all) Status', description: describeSet(provider.getStatusFilter()), action: 'status' },
    { label: '$(server) Backend', description: describeSet(provider.getBackendFilter()), action: 'backend' },
    { label: '$(warning) Failures', description: failureLabel[provider.getFailureFilter()], action: 'failures' },
    { label: '$(calendar) Date Range', description: dateLabel, action: 'date' },
  ];
  if (provider.hasActiveFilter()) {
    items.push({ label: '$(clear-all) Clear All Filters', action: 'clear' });
  }

  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Choose a filter to configure' });
  if (!pick) {
    return;
  }

  switch (pick.action) {
    case 'status': {
      const statuses = provider.getAvailableStatuses();
      if (statuses.length === 0) {
        vscode.window.showInformationMessage(noEntriesMessage);
        return;
      }
      const result = await pickMulti(statuses, provider.getStatusFilter(), 'Show requests with status...');
      if (result !== 'cancel') {
        provider.setStatusFilter(result);
      }
      break;
    }
    case 'backend': {
      const backends = provider.getAvailableBackends();
      if (backends.length === 0) {
        vscode.window.showInformationMessage(noEntriesMessage);
        return;
      }
      const result = await pickMulti(backends, provider.getBackendFilter(), 'Show requests from backend...');
      if (result !== 'cancel') {
        provider.setBackendFilter(result);
      }
      break;
    }
    case 'failures': {
      const result = await pickFailureFilter(provider.getFailureFilter());
      if (result) {
        provider.setFailureFilter(result);
      }
      break;
    }
    case 'date': {
      const result = await pickDateFilter();
      if (result !== 'cancel') {
        provider.setDateFilter(result);
      }
      break;
    }
    case 'clear':
      provider.clearAllFilters();
      break;
  }
  onChange();
}

/** The "Sort..." QuickPick - shared by the cache and dashboard panels. */
async function showSortMenu(provider: CacheTreeProvider): Promise<void> {
  const current = provider.getSort();
  const pick = await vscode.window.showQuickPick(
    SORT_CHOICES.map((choice) => ({
      ...choice,
      description:
        choice.sortBy === current.sortBy && choice.direction === current.direction ? 'current' : undefined,
    })),
    { placeHolder: 'Sort by...' }
  );
  if (!pick) {
    return;
  }
  provider.setSort(pick.sortBy, pick.direction);
}

/** Toggles grouping and mirrors it into a `when`-clause context key, so the
 *  view/title menu can swap the "Group by Title"/"Ungroup" icon - shared by
 *  the cache and dashboard panels, which use different context keys. */
function makeSetGrouping(provider: CacheTreeProvider, contextKey: string): (enabled: boolean) => void {
  return (enabled: boolean) => {
    provider.setGroupingEnabled(enabled);
    vscode.commands.executeCommand('setContext', contextKey, enabled);
  };
}

const LIVE_POLL_INTERVAL_MS = 5000;

/** What one poll tick fetches for an entry and merges back in via
 *  CacheTreeProvider.updateEntry - the dashboard only has remote status to
 *  go on, while the cache panel also re-scans local disk (its progress bar
 *  and size depend on that, not on remote completion). */
type PollFn = (entry: CacheEntry, endpoint: EndpointConfig) => Promise<Partial<CacheEntry>>;

/**
 * While a still-running row is expanded, polls it every few seconds via
 * `pollEntry` and merges the result back into the tree (CacheTreeProvider.
 * updateEntry) - so the progress bar and other live details stay current
 * without the user having to manually refresh. Stops automatically once the
 * transform reaches a terminal status, the row is collapsed, the entry
 * disappears from the tree (e.g. an intervening full refresh dropped it), or
 * the extension deactivates. Only ever polls rows the user actually has
 * expanded - never the whole list - so this doesn't turn into another
 * source of unbounded background requests. Shared by both panels; each
 * calls this with its own `pollEntry` and its own independent timer map.
 */
function registerLivePolling(
  context: vscode.ExtensionContext,
  treeView: vscode.TreeView<unknown>,
  provider: CacheTreeProvider,
  pollEntry: PollFn
): void {
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  const stop = (requestId: string) => {
    const timer = timers.get(requestId);
    if (timer) {
      clearInterval(timer);
      timers.delete(requestId);
    }
  };

  context.subscriptions.push(
    treeView.onDidExpandElement(({ element }) => {
      if (!(element instanceof RequestItem) || isTerminalStatus(element.entry.status)) {
        return;
      }
      const requestId = element.entry.requestId;
      const backendName = element.entry.backend;
      if (timers.has(requestId) || !backendName) {
        return;
      }
      timers.set(
        requestId,
        setInterval(async () => {
          const endpoint = resolveConfig().endpoints.find((e) => e.name === backendName);
          if (!endpoint) {
            stop(requestId);
            return;
          }
          try {
            const patch = await pollEntry(element.entry, endpoint);
            const stillShown = provider.updateEntry(requestId, patch);
            if (!stillShown || (patch.status && isTerminalStatus(patch.status))) {
              stop(requestId);
            }
          } catch {
            // Transient failure (network blip, token hiccup) - leave the
            // last known values in place and try again next tick.
          }
        }, LIVE_POLL_INTERVAL_MS)
      );
    })
  );

  context.subscriptions.push(
    treeView.onDidCollapseElement(({ element }) => {
      if (element instanceof RequestItem) {
        stop(element.entry.requestId);
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      for (const timer of timers.values()) {
        clearInterval(timer);
      }
      timers.clear();
    },
  });
}

/** Dashboard poll: remote status only - there's no local file data at all
 *  for a dashboard entry. */
const pollDashboardEntry: PollFn = async (entry, endpoint) => {
  const status = await getServiceXApi(endpoint).getTransformStatus(entry.requestId);
  return {
    status: status.status,
    submitTime: status.submitTime,
    finishTime: status.finishTime,
    files: status.files,
    filesCompleted: status.filesCompleted,
    filesFailed: status.filesFailed,
  };
};

/** Cache panel poll: remote status, plus a fresh disk scan - its progress
 *  bar and size row are driven by what's actually downloaded (sizeBytes/
 *  downloadedFiles), which a plain status call alone wouldn't move. */
const pollCacheEntry: PollFn = async (entry, endpoint) => {
  const status = await getServiceXApi(endpoint).getTransformStatus(entry.requestId);
  const stats = entry.dataDir ? directoryStats(entry.dataDir) : undefined;
  return {
    status: status.status,
    submitTime: status.submitTime,
    finishTime: status.finishTime,
    files: status.files,
    filesCompleted: status.filesCompleted,
    filesFailed: status.filesFailed,
    ...(stats ? { sizeBytes: stats.sizeBytes, downloadedFiles: stats.fileCount } : {}),
  };
};

export function activate(context: vscode.ExtensionContext) {
  const cacheTreeProvider = new CacheTreeProvider();
  const treeView = vscode.window.createTreeView('servicexCacheView', {
    treeDataProvider: cacheTreeProvider,
  });
  context.subscriptions.push(treeView);
  vscode.commands.executeCommand('setContext', 'servicex.groupingEnabled', true);
  registerLivePolling(context, treeView, cacheTreeProvider, pollCacheEntry);

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

  const updateFilterMessage = makeUpdateFilterMessage(cacheTreeProvider, treeView);

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

  /**
   * Removes every cached request - the whole panel, not just what a filter
   * currently shows (hence getEntries() rather than the visible rows), which
   * includes cancelled/failed requests that exist only as a directory on
   * disk with no db.json record.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.deleteAllCache', async () => {
      await cacheTreeProvider.ensureLoaded();
      const entries = cacheTreeProvider.getEntries();
      if (entries.length === 0) {
        vscode.window.showInformationMessage('The ServiceX cache is already empty.');
        return;
      }
      const totalSize = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
      const confirm = await vscode.window.showWarningMessage(
        `Delete ALL ${entries.length} cached request(s)` +
          (totalSize > 0 ? `, freeing ${formatBytes(totalSize)}` : '') +
          '? This cannot be undone.',
        { modal: true },
        'Delete All'
      );
      if (confirm !== 'Delete All') {
        return;
      }
      const cachePath = resolveCachePath();
      let count = 0;
      for (const entry of entries) {
        if (deleteCacheRecord(cachePath, entry.requestId)) {
          count++;
        }
      }
      vscode.window.showInformationMessage(`Deleted ${count} cached request(s).`);
      cacheTreeProvider.refresh();
      updateCacheSizeLabel();
    })
  );

  /**
   * Runs the same per-group "Clean" plan across every group at once: keeps
   * each title's most recent completed request and drops the rest, along
   * with every cancelled/failed one.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.cleanAllGroups', async () => {
      await cacheTreeProvider.ensureLoaded();
      const toDelete = groupByTitle(cacheTreeProvider.getEntries()).flatMap((g) => computeCleanPlan(g.entries));
      if (toDelete.length === 0) {
        vscode.window.showInformationMessage('Nothing to clean - every group is already tidy.');
        return;
      }
      const totalSize = toDelete.reduce((sum, e) => sum + e.sizeBytes, 0);
      const confirm = await vscode.window.showWarningMessage(
        `Clean ${toDelete.length} cached request(s) across all groups` +
          (totalSize > 0 ? `, freeing ${formatBytes(totalSize)}` : '') +
          ' (older completed runs plus any cancelled or failed ones), keeping each title\'s most recent ' +
          'completed request?',
        { modal: true },
        'Clean'
      );
      if (confirm !== 'Clean') {
        return;
      }
      const cachePath = resolveCachePath();
      let count = 0;
      for (const entry of toDelete) {
        if (deleteCacheRecord(cachePath, entry.requestId)) {
          count++;
        }
      }
      vscode.window.showInformationMessage(`Cleaned ${count} cached request(s).`);
      cacheTreeProvider.refresh();
      updateCacheSizeLabel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.openFilterMenu', () =>
      showFilterMenu(cacheTreeProvider, updateFilterMessage, 'No cached transform requests to filter yet.')
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.clearAllFilters', () => {
      cacheTreeProvider.clearAllFilters();
      updateFilterMessage();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.openSortMenu', () => showSortMenu(cacheTreeProvider))
  );

  const setGrouping = makeSetGrouping(cacheTreeProvider, 'servicex.groupingEnabled');
  context.subscriptions.push(vscode.commands.registerCommand('servicex.groupByTitle', () => setGrouping(true)));
  context.subscriptions.push(vscode.commands.registerCommand('servicex.ungroup', () => setGrouping(false)));

  // --- Dashboard panel: every transform visible to the configured token on
  // each backend (not just what's downloaded locally). Shares the same
  // grouping/filtering/sorting machinery as the cache panel above via
  // CacheTreeProvider + DASHBOARD_SOURCE, but has no local-file commands
  // (Delete/Clean/Open Cache Folder) since there's no local data to act on.
  const dashboardTreeProvider = new CacheTreeProvider(DASHBOARD_SOURCE);
  const dashboardTreeView = vscode.window.createTreeView('servicexDashboardView', {
    treeDataProvider: dashboardTreeProvider,
  });
  context.subscriptions.push(dashboardTreeView);
  vscode.commands.executeCommand(
    'setContext',
    'servicex.dashboardGroupingEnabled',
    dashboardTreeProvider.isGroupingEnabled()
  );
  registerLivePolling(context, dashboardTreeView, dashboardTreeProvider, pollDashboardEntry);

  const updateDashboardFilterMessage = makeUpdateFilterMessage(dashboardTreeProvider, dashboardTreeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.refreshDashboard', () => dashboardTreeProvider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.openDashboardFilterMenu', () =>
      showFilterMenu(dashboardTreeProvider, updateDashboardFilterMessage, 'No dashboard transforms to filter yet.')
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.clearAllDashboardFilters', () => {
      dashboardTreeProvider.clearAllFilters();
      updateDashboardFilterMessage();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.openDashboardSortMenu', () => showSortMenu(dashboardTreeProvider))
  );

  const setDashboardGrouping = makeSetGrouping(dashboardTreeProvider, 'servicex.dashboardGroupingEnabled');
  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.groupDashboardByTitle', () => setDashboardGrouping(true))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.ungroupDashboard', () => setDashboardGrouping(false))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.cancelTransform', async (item: RequestItem) => {
      if (!item) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Cancel the running transform for '${item.entry.title}' (${item.entry.requestId})?`,
        { modal: true },
        'Cancel Transform'
      );
      if (confirm !== 'Cancel Transform') {
        return;
      }
      const endpoint = endpointForRequest(item.entry, 'cancel the transform');
      if (!endpoint) {
        return;
      }
      try {
        await getServiceXApi(endpoint).cancelTransform(item.entry.requestId);
      } catch (e) {
        vscode.window.showErrorMessage(`Couldn't cancel ${item.entry.requestId}: ${(e as Error).message}`);
        return;
      }
      vscode.window.showInformationMessage(`Cancelled ${item.entry.requestId}.`);
      dashboardTreeProvider.refresh();
    })
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
      updateCacheSizeLabel();
    })
  );

  /**
   * Sets (or clears, on a blank submission) a free-text label for one cached
   * request. Stored in the extension's own `.servicex/labels.json` (see
   * cacheDb.ts) rather than anywhere the servicex Python client reads or
   * writes, since there's no field for this in the client's own db.json
   * schema. Applies straight to the shared provider via updateEntry rather
   * than a full refresh, since nothing about the underlying request itself
   * changed.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.setLabel', async (item: RequestItem) => {
      if (!item) {
        return;
      }
      const input = await vscode.window.showInputBox({
        prompt: `Label for '${item.entry.title}' (${item.entry.requestId})`,
        placeHolder: 'Leave blank to clear the label',
        value: item.entry.label ?? '',
      });
      if (input === undefined) {
        return;
      }
      const label = input.trim() || undefined;
      setLabel(resolveCachePath(), item.entry.requestId, label);
      cacheTreeProvider.updateEntry(item.entry.requestId, { label });
      vscode.window.setStatusBarMessage(
        label ? `Label set for ${item.entry.requestId}` : `Label cleared for ${item.entry.requestId}`,
        3000
      );
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
      const endpoint = endpointForRequest(item.entry, 'open the dashboard');
      if (!endpoint) {
        return;
      }
      const url = `${endpoint.endpoint.replace(/\/+$/, '')}/transformation-request/${item.entry.requestId}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  /**
   * Opens the query that produced a request, in a scratch editor. The query
   * isn't in the local cache - db.json keeps only the hash it was reduced to
   * - so it has to come back from the backend as the transform's `selection`
   * string, then be decoded from whatever encoding its query type uses.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand('servicex.showQuery', async (item: RequestItem) => {
      if (!item) {
        return;
      }
      const endpoint = endpointForRequest(item.entry, 'show the query');
      if (!endpoint) {
        return;
      }

      const scriptPath = path.join(context.extensionPath, 'resources', 'decode_qastle.py');
      let rendered: { content: string; language: string } | undefined;
      try {
        rendered = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Fetching the query for ${item.entry.requestId}...`,
          },
          async () => {
            const api = getServiceXApi(endpoint);
            const status = await api.getTransformStatus(item.entry.requestId);
            if (!status.selection?.trim()) {
              return undefined;
            }
            const decoded = await decodeForDisplay(status.selection, scriptPath);
            return {
              content: renderQueryDocument(
                {
                  requestId: item.entry.requestId,
                  title: item.entry.title,
                  backend: item.entry.backend,
                  codegen: item.entry.codegen,
                  did: status.did,
                  resultFormat: status.resultFormat,
                },
                decoded
              ),
              language: decoded.language,
            };
          }
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Couldn't fetch the query for ${item.entry.requestId}: ${(e as Error).message}`
        );
        return;
      }

      if (!rendered) {
        vscode.window.showInformationMessage(
          `${endpoint.name} didn't return a query for ${item.entry.requestId}.`
        );
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        content: rendered.content,
        language: rendered.language,
      });
      await vscode.window.showTextDocument(document, { preview: false });
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
      const filterWarning = cacheTreeProvider.hasActiveFilter()
        ? ' A filter is currently active - this will still remove every request for ' +
          "this title, including ones that aren't shown right now."
        : '';
      const confirm = await vscode.window.showWarningMessage(
        `Delete ALL ${item.allEntries.length} cached request(s) for '${item.title}'? This cannot be undone.` +
          filterWarning,
        { modal: true },
        'Delete All'
      );
      if (confirm !== 'Delete All') {
        return;
      }
      // Driven by the group's own entries rather than a db.json title
      // lookup: a cancelled request has no db.json record at all (only a
      // directory on disk), so a record-based lookup silently skipped it -
      // and skipped the whole group when db.json had no records to match.
      const cachePath = resolveCachePath();
      let count = 0;
      for (const entry of item.allEntries) {
        if (deleteCacheRecord(cachePath, entry.requestId)) {
          count++;
        }
      }
      vscode.window.showInformationMessage(`Deleted ${count} cached request(s) for '${item.title}'.`);
      cacheTreeProvider.refresh();
      updateCacheSizeLabel();
    })
  );
}

export function deactivate() {}
