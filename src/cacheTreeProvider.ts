import * as vscode from 'vscode';
import { loadConfig, orderedEndpoints } from './config';
import { ServiceXApi, NotFoundError } from './serviceXApi';
import { readCacheRecords, completedRecords, submittedRecords, directorySize, CacheDbRecord } from './cacheDb';

export interface CacheEntry {
  requestId: string;
  title: string;
  status: string;
  submitTime?: Date;
  finishTime?: Date;
  files: number;
  filesCompleted: number;
  filesFailed: number;
  stale: boolean;
  /** Name of the backend the request was actually found on; undefined only
   *  when it wasn't found on any configured backend. */
  backend?: string;
  /** Locally downloaded file paths for this request, from the local cache
   *  record - undefined/empty if nothing has been downloaded yet. */
  fileList?: string[];
  /** Size on disk of this request's downloaded files, in bytes - 0 if
   *  nothing has been downloaded yet (e.g. still SUBMITTED). */
  sizeBytes: number;
}

/** Formats a byte count as a human-readable size, e.g. "512 B", "1.5 KB", "128.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

export type SortBy = 'title' | 'date' | 'files';
export type SortDirection = 'asc' | 'desc';
export type FailureFilter = 'all' | 'withFailures' | 'withoutFailures';

export interface EntryFilters {
  status?: Set<string>;
  backend?: Set<string>;
  failures?: FailureFilter;
  dateFrom?: Date;
  dateTo?: Date;
}

/** Applies every active filter dimension to a flat list of entries. */
export function filterEntries(entries: CacheEntry[], filters: EntryFilters): CacheEntry[] {
  return entries.filter((e) => {
    if (filters.status && !filters.status.has(e.status)) {
      return false;
    }
    if (filters.backend && (!e.backend || !filters.backend.has(e.backend))) {
      return false;
    }
    if (filters.failures === 'withFailures' && e.filesFailed <= 0) {
      return false;
    }
    if (filters.failures === 'withoutFailures' && e.filesFailed > 0) {
      return false;
    }
    if (filters.dateFrom || filters.dateTo) {
      if (!e.submitTime) {
        return false;
      }
      if (filters.dateFrom && e.submitTime < filters.dateFrom) {
        return false;
      }
      if (filters.dateTo && e.submitTime > filters.dateTo) {
        return false;
      }
    }
    return true;
  });
}

function compareEntries(a: CacheEntry, b: CacheEntry, sortBy: SortBy): number {
  if (sortBy === 'title') {
    return a.title.localeCompare(b.title);
  }
  if (sortBy === 'files') {
    return a.files - b.files;
  }
  return (a.submitTime?.getTime() ?? 0) - (b.submitTime?.getTime() ?? 0);
}

/** Sorts a flat list of entries by title (A→Z/Z→A), submit date, or total file count. */
export function sortEntries(entries: CacheEntry[], sortBy: SortBy, direction: SortDirection): CacheEntry[] {
  const sorted = [...entries];
  sorted.sort((a, b) => (direction === 'asc' ? compareEntries(a, b, sortBy) : compareEntries(b, a, sortBy)));
  return sorted;
}

function formatDateTime(value?: Date): string {
  if (!value) {
    return '-';
  }
  return value.toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export class TitleGroupItem extends vscode.TreeItem {
  /**
   * @param entries Entries to display as children (and count in the badge) -
   *   the currently filtered/visible set.
   * @param allEntries The full, unfiltered set of entries for this title,
   *   used for operations like "Clean" that must consider cache hygiene
   *   regardless of what filters happen to be active. Defaults to `entries`
   *   when there is no active filter.
   */
  constructor(
    public readonly title: string,
    public readonly entries: CacheEntry[],
    public readonly allEntries: CacheEntry[] = entries
  ) {
    super(title, vscode.TreeItemCollapsibleState.Expanded);
    const totalSize = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
    this.description =
      `${entries.length} request${entries.length === 1 ? '' : 's'}` +
      (totalSize > 0 ? ` · ${formatBytes(totalSize)}` : '');
    this.contextValue = 'servicexTitleGroup';
  }
}

/**
 * Decide which cached requests in a title group should be removed by
 * "Clean": every Cancelled or Failed request (regardless of age), plus every
 * Complete request except the most recently submitted one.
 *
 * Deliberately based on the group's already-fetched CacheEntry[] (backend
 * status) rather than the local db.json's status field - a request can sit
 * cached locally as "SUBMITTED" indefinitely if nothing ever polled it again
 * after it finished (or failed) server-side, so the local status alone
 * can't be trusted to identify these.
 */
export function computeCleanPlan(entries: CacheEntry[]): CacheEntry[] {
  const complete = entries.filter((e) => e.status === 'Complete');
  complete.sort((a, b) => (b.submitTime?.getTime() ?? 0) - (a.submitTime?.getTime() ?? 0));
  const staleComplete = complete.slice(1);

  const cancelledOrFailed = entries.filter((e) => e.status === 'Canceled' || e.status === 'Fatal');

  return [...staleComplete, ...cancelledOrFailed];
}

/** A plain informational row with no children - used for empty/error states. */
export class MessageItem extends vscode.TreeItem {
  constructor(message: string, icon?: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
  }
}

export class RequestItem extends vscode.TreeItem {
  constructor(
    public readonly entry: CacheEntry,
    options?: { showTitle?: boolean; showBackend?: boolean }
  ) {
    super(entry.status, vscode.TreeItemCollapsibleState.None);
    const showBackend = (options?.showBackend ?? true) && !!entry.backend;
    this.description =
      (options?.showTitle ? `${entry.title} · ` : '') +
      `${formatDateTime(entry.submitTime)} → ${formatDateTime(entry.finishTime)} · ` +
      `Files: Complete ${entry.filesCompleted} · Failed ${entry.filesFailed} · Total ${entry.files}` +
      (entry.sizeBytes > 0 ? ` · ${formatBytes(entry.sizeBytes)}` : '') +
      (showBackend ? ` · via ${entry.backend}` : '');
    this.tooltip = [
      `Title: ${entry.title}`,
      `Request ID: ${entry.requestId}`,
      `Status: ${entry.status}`,
      `Submitted: ${formatDateTime(entry.submitTime)}`,
      `Finished: ${formatDateTime(entry.finishTime)}`,
      `Files Complete: ${entry.filesCompleted}`,
      `Files Failed: ${entry.filesFailed}`,
      `Files Total: ${entry.files}`,
      ...(entry.backend ? [`Backend: ${entry.backend}`] : []),
      ...(entry.fileList?.length ? [`Downloaded files: ${entry.fileList.length}`] : []),
      ...(entry.sizeBytes > 0 ? [`Size on disk: ${formatBytes(entry.sizeBytes)}`] : []),
    ].join('\n');
    if (entry.stale) {
      this.iconPath = new vscode.ThemeIcon('warning');
    }
    this.contextValue = 'servicexCacheRequest';
  }
}

type CacheNode = TitleGroupItem | RequestItem | MessageItem;

export class CacheTreeProvider implements vscode.TreeDataProvider<CacheNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNodes: CacheNode[] = [];
  private rawEntries: CacheEntry[] = [];
  private loaded = false;

  private statusFilter?: Set<string>;
  private backendFilter?: Set<string>;
  private failureFilter: FailureFilter = 'all';
  private dateFilter?: { from?: Date; to?: Date };

  private sortBy: SortBy = 'date';
  private sortDirection: SortDirection = 'desc';
  private groupingEnabled = true;

  /** Only show "via <backend>" on rows when more than one backend is actually in play. */
  private showBackendTag = false;

  refresh(): void {
    this.loaded = false;
    this._onDidChangeTreeData.fire();
  }

  /** Loads entries if they haven't been fetched yet, without forcing a re-fetch. */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.getChildren();
    }
  }

  /** Distinct statuses among the currently loaded entries, for building a filter picker. */
  getAvailableStatuses(): string[] {
    return Array.from(new Set(this.rawEntries.map((e) => e.status))).sort();
  }

  /** Distinct backend names among the currently loaded entries, for building a filter picker. */
  getAvailableBackends(): string[] {
    return Array.from(new Set(this.rawEntries.map((e) => e.backend).filter((b): b is string => !!b))).sort();
  }

  getStatusFilter(): Set<string> | undefined {
    return this.statusFilter;
  }

  /** Restrict the tree to entries whose status is in `statuses`; undefined shows every status. */
  setStatusFilter(statuses: Set<string> | undefined): void {
    this.statusFilter = statuses;
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  getBackendFilter(): Set<string> | undefined {
    return this.backendFilter;
  }

  /** Restrict the tree to entries found on one of `backends`; undefined shows every backend. */
  setBackendFilter(backends: Set<string> | undefined): void {
    this.backendFilter = backends;
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  getFailureFilter(): FailureFilter {
    return this.failureFilter;
  }

  /** Restrict the tree to entries with/without failed files, or show both. */
  setFailureFilter(filter: FailureFilter): void {
    this.failureFilter = filter;
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  getDateFilter(): { from?: Date; to?: Date } | undefined {
    return this.dateFilter;
  }

  /** Restrict the tree to entries submitted within [from, to] (either bound optional); undefined clears it. */
  setDateFilter(range: { from?: Date; to?: Date } | undefined): void {
    this.dateFilter = range && (range.from || range.to) ? range : undefined;
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  hasActiveFilter(): boolean {
    return !!this.statusFilter || !!this.backendFilter || this.failureFilter !== 'all' || !!this.dateFilter;
  }

  clearAllFilters(): void {
    this.statusFilter = undefined;
    this.backendFilter = undefined;
    this.failureFilter = 'all';
    this.dateFilter = undefined;
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  getSort(): { sortBy: SortBy; direction: SortDirection } {
    return { sortBy: this.sortBy, direction: this.sortDirection };
  }

  setSort(sortBy: SortBy, direction: SortDirection): void {
    this.sortBy = sortBy;
    this.sortDirection = direction;
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  isGroupingEnabled(): boolean {
    return this.groupingEnabled;
  }

  setGroupingEnabled(enabled: boolean): void {
    this.groupingEnabled = enabled;
    this.rebuildTree();
    this._onDidChangeTreeData.fire();
  }

  private filteredEntries(): CacheEntry[] {
    return filterEntries(this.rawEntries, {
      status: this.statusFilter,
      backend: this.backendFilter,
      failures: this.failureFilter,
      dateFrom: this.dateFilter?.from,
      dateTo: this.dateFilter?.to,
    });
  }

  /**
   * Rebuilds the visible root nodes from the currently filtered/sorted
   * entries. When grouped, each TitleGroupItem's `allEntries` is still the
   * full unfiltered group - so "Clean" keeps sweeping stale/cancelled/failed
   * requests even when a filter is hiding them from view.
   */
  private rebuildTree(): void {
    this.showBackendTag = this.getAvailableBackends().length > 1;
    const filtered = this.filteredEntries();

    if (this.groupingEnabled) {
      const rawByTitle = new Map<string, CacheEntry[]>();
      for (const e of this.rawEntries) {
        const bucket = rawByTitle.get(e.title);
        if (bucket) {
          bucket.push(e);
        } else {
          rawByTitle.set(e.title, [e]);
        }
      }
      this.rootNodes = groupByTitle(filtered, this.sortBy, this.sortDirection).map(
        (g) => new TitleGroupItem(g.title, g.entries, rawByTitle.get(g.title))
      );
    } else {
      this.rootNodes = sortEntries(filtered, this.sortBy, this.sortDirection).map(
        (e) => new RequestItem(e, { showTitle: true, showBackend: this.showBackendTag })
      );
    }
  }

  getTreeItem(element: CacheNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CacheNode): Promise<CacheNode[]> {
    if (element instanceof TitleGroupItem) {
      return element.entries.map((e) => new RequestItem(e, { showBackend: this.showBackendTag }));
    }
    if (element) {
      return [];
    }

    if (!this.loaded) {
      try {
        this.rawEntries = await this.fetchEntries();
        this.rebuildTree();
      } catch (e) {
        this.rawEntries = [];
        this.loaded = true;
        return [new MessageItem(`Error: ${(e as Error).message}`, 'error')];
      }
      this.loaded = true;
    }

    if (this.rootNodes.length) {
      return this.rootNodes;
    }
    return [
      new MessageItem(
        this.hasActiveFilter()
          ? 'No cached requests match the current filters.'
          : 'No cached transform requests found.'
      ),
    ];
  }

  private async fetchEntries(): Promise<CacheEntry[]> {
    const settings = vscode.workspace.getConfiguration('servicex');
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const config = loadConfig(settings.get<string>('configPath') || undefined, workspaceFolder);
    const endpoints = orderedEndpoints(config, settings.get<string>('backend') || undefined);
    const namedApis = endpoints.map((e) => ({
      name: e.name,
      api: new ServiceXApi(e.endpoint, e.token),
    }));

    const records = readCacheRecords(config.cachePath);
    const localByRequestId = new Map<string, CacheDbRecord>();
    for (const r of [...completedRecords(records), ...submittedRecords(records)]) {
      if (r.request_id) {
        localByRequestId.set(r.request_id, r);
      }
    }

    return Promise.all(
      Array.from(localByRequestId.entries()).map(([requestId, local]) => fetchOneEntry(namedApis, requestId, local))
    );
  }
}

function localFileList(local: CacheDbRecord): string[] | undefined {
  return Array.isArray(local.file_list) ? (local.file_list as string[]) : undefined;
}

/** Size on disk of a request's downloaded files - 0 for a SUBMITTED record, which has no data_dir yet. */
function localSizeBytes(local: CacheDbRecord): number {
  return typeof local.data_dir === 'string' ? directorySize(local.data_dir) : 0;
}

async function fetchOneEntry(
  apis: { name: string; api: ServiceXApi }[],
  requestId: string,
  local: CacheDbRecord
): Promise<CacheEntry> {
  let lastError: unknown;

  for (const { name, api } of apis) {
    try {
      const remote = await api.getTransformStatus(requestId);
      return {
        requestId,
        title: remote.title || local.title || 'No Title',
        status: remote.status,
        submitTime: remote.submitTime,
        finishTime: remote.finishTime,
        files: remote.files,
        filesCompleted: remote.filesCompleted,
        filesFailed: remote.filesFailed,
        stale: false,
        backend: name,
        fileList: localFileList(local),
        sizeBytes: localSizeBytes(local),
      };
    } catch (e) {
      lastError = e;
      if (e instanceof NotFoundError) {
        // Not on this backend - try the next configured one before giving up.
        continue;
      }
      // Any other failure (auth, network, server error) - don't keep trying
      // other backends for it, surface it directly.
      break;
    }
  }

  return {
    requestId,
    title: local.title || 'No Title',
    status:
      lastError instanceof NotFoundError
        ? 'Not found on any backend'
        : `Error: ${(lastError as Error).message}`,
    submitTime: local.submit_time ? new Date(local.submit_time) : undefined,
    finishTime: undefined,
    files: 0,
    filesCompleted: 0,
    filesFailed: 0,
    stale: true,
    fileList: localFileList(local),
    sizeBytes: localSizeBytes(local),
  };
}

/**
 * Group entries with the same title together (entries within a group are
 * always ordered newest-first). Groups themselves are ordered by title, by
 * their most recent submit time, or by the most recent entry's total file
 * count, per `sortBy`/`direction`. Mirrors core._group_by_title in the Python
 * CLI when using the defaults.
 */
export function groupByTitle(
  entries: CacheEntry[],
  sortBy: SortBy = 'date',
  direction: SortDirection = 'desc'
): TitleGroupItem[] {
  const byTitle = new Map<string, CacheEntry[]>();
  for (const e of entries) {
    const bucket = byTitle.get(e.title);
    if (bucket) {
      bucket.push(e);
    } else {
      byTitle.set(e.title, [e]);
    }
  }

  const groups = Array.from(byTitle.entries()).map(([title, groupEntries]) => {
    groupEntries.sort((a, b) => (b.submitTime?.getTime() ?? 0) - (a.submitTime?.getTime() ?? 0));
    return { title, groupEntries };
  });

  groups.sort((a, b) => {
    const cmp = compareEntries(a.groupEntries[0], b.groupEntries[0], sortBy);
    return direction === 'asc' ? cmp : -cmp;
  });

  return groups.map((g) => new TitleGroupItem(g.title, g.groupEntries));
}
