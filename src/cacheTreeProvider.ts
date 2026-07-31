import * as vscode from 'vscode';
import { loadConfig, orderedEndpoints } from './config';
import { ServiceXApi, NotFoundError, TransformStatus } from './serviceXApi';
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
  /** Local directory holding this request's downloaded files - undefined
   *  for a still-SUBMITTED request with nothing downloaded yet. */
  dataDir?: string;
  /** Code generator this query was submitted with (e.g. "atlasr22",
   *  "uproot-raw", "python"), from the local cache record - the backend's
   *  transform status doesn't report it. Shown in the header of the query
   *  document; undefined when there's no local record to read it from. */
  codegen?: string;
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

export type SortBy = 'title' | 'date' | 'files' | 'size';
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
  if (sortBy === 'size') {
    return a.sizeBytes - b.sizeBytes;
  }
  return (a.submitTime?.getTime() ?? 0) - (b.submitTime?.getTime() ?? 0);
}

/** Sorts a flat list of entries by title (A→Z/Z→A), submit date, total file count, or size on disk. */
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
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Every real formatted date/time is the same length (fixed-width numeric
// fields), so this reference sample - not the "-" placeholder for a missing
// date - is what determines the padded width below.
const DATE_TIME_WIDTH = formatDateTime(new Date(2000, 0, 1, 0, 0)).length;

/**
 * Pads a formatted submit date (or the "-" placeholder for a missing one) up
 * to the width of a real date/time, so the "->" before the finish date lands
 * in the same column on every row. Uses non-breaking spaces - plain spaces
 * get collapsed by the tree view's rendering.
 */
function padDateTime(formatted: string): string {
  return formatted.padEnd(DATE_TIME_WIDTH, ' ');
}

/** Combined size on disk of every entry in a group. */
function groupSizeBytes(entries: CacheEntry[]): number {
  return entries.reduce((sum, e) => sum + e.sizeBytes, 0);
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
    public readonly allEntries: CacheEntry[] = entries,
    contextValue = 'servicexTitleGroup'
  ) {
    super(title, vscode.TreeItemCollapsibleState.Expanded);
    const totalSize = groupSizeBytes(entries);
    this.description =
      `${entries.length} request${entries.length === 1 ? '' : 's'}` +
      (totalSize > 0 ? ` · ${formatBytes(totalSize)}` : '');
    this.contextValue = contextValue;
  }
}

/**
 * Top-level "tab" grouping every entry from one backend - inserted above the
 * usual title-grouped/flat structure only when a source opts into it
 * (`CacheTreeSource.groupByBackend`) and more than one backend is actually
 * present, e.g. the dashboard panel querying several configured endpoints at
 * once. A single-backend setup (the common case for the cache panel) never
 * shows this extra layer.
 */
export class BackendGroupItem extends vscode.TreeItem {
  /** @param error When this backend failed to load, the error message - shown
   *    right on the row (not just buried in a warning toast) and again as
   *    this tab's only child when expanded. */
  constructor(
    public readonly backend: string,
    public readonly entries: CacheEntry[],
    public readonly error?: string
  ) {
    super(backend, vscode.TreeItemCollapsibleState.Expanded);
    if (error) {
      this.description = 'Error loading transforms';
      this.tooltip = error;
      this.iconPath = new vscode.ThemeIcon('error');
    } else {
      this.description = `${entries.length} request${entries.length === 1 ? '' : 's'}`;
      this.iconPath = new vscode.ThemeIcon('server');
    }
    this.contextValue = 'servicexBackendGroup';
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

/**
 * Shows only status and dates right away - everything else (request ID,
 * file counts, size, backend, downloaded files) is available by expanding
 * the row into its RequestDetailItem children, rather than crowding the
 * collapsed row.
 */
export class RequestItem extends vscode.TreeItem {
  constructor(public readonly entry: CacheEntry, options?: { showTitle?: boolean; contextValue?: string }) {
    super(entry.status, vscode.TreeItemCollapsibleState.Collapsed);
    this.description =
      (options?.showTitle ? `${entry.title} · ` : '') +
      `${padDateTime(formatDateTime(entry.submitTime))} → ${formatDateTime(entry.finishTime)}`;
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
    this.contextValue = options?.contextValue ?? 'servicexCacheRequest';
  }
}

/** A single read-only fact about a request - shown as a child when its RequestItem is expanded. */
export class RequestDetailItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'servicexRequestDetail';
  }
}

/**
 * Everything about a request besides status/dates (already visible on the
 * collapsed row), one fact per row: request ID and file counts always,
 * size/backend/downloaded-files only when there's something to say.
 */
export function buildRequestDetails(entry: CacheEntry): RequestDetailItem[] {
  const details = [
    new RequestDetailItem(`Request ID: ${entry.requestId}`),
    new RequestDetailItem(
      `Files: Complete ${entry.filesCompleted} · Failed ${entry.filesFailed} · Total ${entry.files}`
    ),
  ];
  if (entry.fileList?.length) {
    details.push(new RequestDetailItem(`Downloaded files: ${entry.fileList.length}`));
  }
  if (entry.sizeBytes > 0) {
    details.push(new RequestDetailItem(`Size on disk: ${formatBytes(entry.sizeBytes)}`));
  }
  if (entry.backend) {
    details.push(new RequestDetailItem(`Backend: ${entry.backend}`));
  }
  return details;
}

type CacheNode = BackendGroupItem | TitleGroupItem | RequestItem | RequestDetailItem | MessageItem;

/** One backend a source considered, independent of whether it actually
 *  contributed any entries - the difference between "queried fine, just
 *  happens to have nothing" and "failed to load" (with why) is exactly what
 *  lets a BackendGroupItem tab stay visible and explain itself either way,
 *  instead of a failed backend just silently vanishing from the tree. */
export interface BackendStatus {
  name: string;
  error?: string;
}

export interface FetchResult {
  entries: CacheEntry[];
  /** Every backend the source considered, for sources that opt into
   *  `groupByBackend` - drives which BackendGroupItem tabs exist, so a
   *  backend with zero entries (empty or errored) still gets one. Omitted
   *  entirely by sources that don't use backend tabs. */
  backends?: BackendStatus[];
}

/**
 * Where a CacheTreeProvider's entries come from and how it should present
 * them - lets the same tree (grouping, filtering, sorting, backend tabs) back
 * both the local-cache panel and the dashboard panel, which differ only in
 * how entries are fetched and which context-menu actions make sense for them.
 */
export interface CacheTreeSource {
  fetchEntries: () => Promise<FetchResult>;
  /** contextValue stamped on every RequestItem this source produces - selects
   *  which per-request context-menu commands package.json shows for it. */
  itemContextValue: string;
  /** contextValue stamped on every TitleGroupItem this source produces. */
  groupContextValue: string;
  /** Shown when there are no entries at all. */
  emptyMessage: string;
  /** Shown when entries exist but every one is hidden by the active filters. */
  noMatchMessage: string;
  /** Insert a top-level per-backend "tab" layer above the usual title-grouped/
   *  flat structure - only takes effect once the fetch considered more than
   *  one backend, so a single-backend setup is unaffected. A backend with no
   *  entries (empty or errored) still gets its own tab rather than vanishing. */
  groupByBackend?: boolean;
  /** Whether the tree groups by title initially. Defaults to true (matching
   *  the cache panel's long-standing behavior) when unset. */
  defaultGroupingEnabled?: boolean;
}

export class CacheTreeProvider implements vscode.TreeDataProvider<CacheNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootNodes: CacheNode[] = [];
  private rawEntries: CacheEntry[] = [];
  private backendStatuses: BackendStatus[] = [];
  private loaded = false;

  private statusFilter?: Set<string>;
  private backendFilter?: Set<string>;
  private failureFilter: FailureFilter = 'all';
  private dateFilter?: { from?: Date; to?: Date };

  private sortBy: SortBy = 'date';
  private sortDirection: SortDirection = 'desc';
  private groupingEnabled: boolean;

  constructor(private readonly source: CacheTreeSource = DEFAULT_CACHE_SOURCE) {
    this.groupingEnabled = source.defaultGroupingEnabled ?? true;
  }

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
   * Builds the title-grouped/flat node list for one set of filtered entries -
   * used directly at the root when there's no backend-tab layer, and again
   * inside each BackendGroupItem's children when there is one. `rawForGroup`
   * is the unfiltered entries to derive each TitleGroupItem's `allEntries`
   * from (so "Clean" still sees everything for that title/backend regardless
   * of active filters), scoped to just that backend when tabbed.
   */
  private buildEntryNodes(filtered: CacheEntry[], rawForGroup: CacheEntry[]): CacheNode[] {
    if (this.groupingEnabled) {
      const rawByTitle = new Map<string, CacheEntry[]>();
      for (const e of rawForGroup) {
        const bucket = rawByTitle.get(e.title);
        if (bucket) {
          bucket.push(e);
        } else {
          rawByTitle.set(e.title, [e]);
        }
      }
      return groupByTitle(filtered, this.sortBy, this.sortDirection).map(
        (g) => new TitleGroupItem(g.title, g.entries, rawByTitle.get(g.title), this.source.groupContextValue)
      );
    }
    return sortEntries(filtered, this.sortBy, this.sortDirection).map(
      (e) => new RequestItem(e, { showTitle: true, contextValue: this.source.itemContextValue })
    );
  }

  /**
   * Rebuilds the visible root nodes from the currently filtered/sorted
   * entries. When the source opts into backend tabs and the fetch considered
   * more than one backend, the root becomes one BackendGroupItem per backend
   * - every configured one, not just those with matching entries, so a
   * backend that came back empty or failed still gets a tab instead of
   * silently disappearing - instead of going straight to the usual
   * title-grouped/flat structure. Each tab's own children are built lazily in
   * getChildren() via the same buildEntryNodes() helper.
   */
  private rebuildTree(): void {
    const filtered = this.filteredEntries();

    this.rootNodes =
      this.source.groupByBackend && this.backendStatuses.length > 1
        ? this.backendStatuses.map(
            (b) => new BackendGroupItem(b.name, filtered.filter((e) => e.backend === b.name), b.error)
          )
        : this.buildEntryNodes(filtered, this.rawEntries);
  }

  getTreeItem(element: CacheNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CacheNode): Promise<CacheNode[]> {
    if (element instanceof BackendGroupItem) {
      if (element.error) {
        return [new MessageItem(element.error, 'error')];
      }
      const nodes = this.buildEntryNodes(
        element.entries,
        this.rawEntries.filter((e) => e.backend === element.backend)
      );
      return nodes.length ? nodes : [new MessageItem(`No transforms found on ${element.backend}.`)];
    }
    if (element instanceof TitleGroupItem) {
      return element.entries.map((e) => new RequestItem(e, { contextValue: this.source.itemContextValue }));
    }
    if (element instanceof RequestItem) {
      return buildRequestDetails(element.entry);
    }
    if (element) {
      return [];
    }

    if (!this.loaded) {
      try {
        const result = await this.source.fetchEntries();
        this.rawEntries = result.entries;
        this.backendStatuses = result.backends ?? [];
        this.rebuildTree();
      } catch (e) {
        this.rawEntries = [];
        this.backendStatuses = [];
        this.loaded = true;
        return [new MessageItem(`Error: ${(e as Error).message}`, 'error')];
      }
      this.loaded = true;
    }

    if (this.rootNodes.length) {
      return this.rootNodes;
    }
    return [new MessageItem(this.hasActiveFilter() ? this.source.noMatchMessage : this.source.emptyMessage)];
  }
}

/**
 * Default entry source for the local-cache panel: cross-references db.json
 * against live backend status, exactly as CacheTreeProvider always did
 * before dashboard support existed. Used whenever a CacheTreeProvider is
 * constructed with no explicit source (including every existing call site
 * and test), so this is the only source with no backend-tab layer of its own
 * - a request being found on a fallback backend is the rare exception here,
 * not the norm the way it is for the dashboard source.
 */
export const DEFAULT_CACHE_SOURCE: CacheTreeSource = {
  fetchEntries: fetchCacheEntries,
  itemContextValue: 'servicexCacheRequest',
  groupContextValue: 'servicexTitleGroup',
  emptyMessage: 'No cached transform requests found.',
  noMatchMessage: 'No cached requests match the current filters.',
};

async function fetchCacheEntries(): Promise<FetchResult> {
  const settings = vscode.workspace.getConfiguration('servicex');
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const config = loadConfig(settings.get<string>('configPath') || undefined, workspaceFolder);
  const endpoints = orderedEndpoints(config, settings.get<string>('backend') || undefined);
  const namedApis = endpoints.map((e) => ({
    name: e.name,
    api: new ServiceXApi(e.endpoint, e.token),
  }));

  const { records, corrupted } = readCacheRecords(config.cachePath);
  if (corrupted > 0) {
    vscode.window.showWarningMessage(
      `ServiceX: ${corrupted} ${corrupted === 1 ? 'entry' : 'entries'} in the local cache database ` +
        `(db.json) could not be read and ${corrupted === 1 ? 'was' : 'were'} skipped. The rest of the ` +
        'cache loaded normally.'
    );
  }
  const localByRequestId = new Map<string, CacheDbRecord>();
  for (const r of [...completedRecords(records), ...submittedRecords(records)]) {
    if (r.request_id) {
      localByRequestId.set(r.request_id, r);
    }
  }

  const entries = await Promise.all(
    Array.from(localByRequestId.entries()).map(([requestId, local]) => fetchOneEntry(namedApis, requestId, local))
  );
  return { entries };
}

/**
 * Entry source for the dashboard panel: every transform visible to the
 * configured token on each backend (ServiceXApi.getAllTransforms, the same
 * call the web dashboard itself makes), not just ones that happen to be
 * downloaded locally - so unlike the cache panel there's no local file data
 * (fileList/dataDir/sizeBytes/codegen) and no per-request fallback between
 * backends, since a transform's own backend already reported it directly.
 * Queries every configured endpoint unconditionally (regardless of the
 * `servicex.backend` setting, which only picks a *default* for the cache
 * panel's single-request fallback order) and tolerates one backend failing
 * without losing the others' results.
 */
export const DASHBOARD_SOURCE: CacheTreeSource = {
  fetchEntries: fetchDashboardEntries,
  itemContextValue: 'servicexDashboardRequest',
  groupContextValue: 'servicexDashboardTitleGroup',
  emptyMessage: 'No transforms found on the dashboard.',
  noMatchMessage: 'No dashboard transforms match the current filters.',
  groupByBackend: true,
  defaultGroupingEnabled: false,
};

/**
 * A facility can have far more transforms on the dashboard than were ever
 * downloaded locally, since it's every transform the token can see there -
 * not just the user's own cache. Capping each backend to its most recent
 * entries independently (rather than one global cap) keeps every configured
 * facility represented instead of a single busy one crowding out the rest.
 */
const DASHBOARD_ENTRIES_PER_BACKEND_LIMIT = 30;

function mostRecentFirst(statuses: TransformStatus[]): TransformStatus[] {
  return [...statuses].sort((a, b) => (b.submitTime?.getTime() ?? 0) - (a.submitTime?.getTime() ?? 0));
}

async function fetchDashboardEntries(): Promise<FetchResult> {
  const settings = vscode.workspace.getConfiguration('servicex');
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const config = loadConfig(settings.get<string>('configPath') || undefined, workspaceFolder);

  const results = await Promise.all(
    config.endpoints.map(async (e) => {
      try {
        const statuses = await new ServiceXApi(e.endpoint, e.token).getAllTransforms();
        return {
          name: e.name,
          statuses: mostRecentFirst(statuses).slice(0, DASHBOARD_ENTRIES_PER_BACKEND_LIMIT),
          error: undefined as Error | undefined,
        };
      } catch (err) {
        return { name: e.name, statuses: [] as TransformStatus[], error: err as Error };
      }
    })
  );

  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    vscode.window.showWarningMessage(
      `ServiceX: couldn't load dashboard transforms from ${failed.map((f) => f.name).join(', ')}: ` +
        failed.map((f) => f.error!.message).join('; ')
    );
  }

  return {
    entries: results.flatMap(({ name, statuses }) => statuses.map((s) => dashboardEntry(s, name))),
    // Every configured backend, not just ones that returned entries - so
    // BackendGroupItem can give a failed or genuinely-empty backend its own
    // tab instead of it just disappearing from the tree.
    backends: results.map((r) => ({ name: r.name, error: r.error?.message })),
  };
}

function dashboardEntry(remote: TransformStatus, backend: string): CacheEntry {
  return {
    requestId: remote.requestId,
    title: remote.title || 'No Title',
    status: remote.status,
    submitTime: remote.submitTime,
    finishTime: remote.finishTime,
    files: remote.files,
    filesCompleted: remote.filesCompleted,
    filesFailed: remote.filesFailed,
    stale: false,
    backend,
    sizeBytes: 0,
  };
}

function localFileList(local: CacheDbRecord): string[] | undefined {
  return Array.isArray(local.file_list) ? (local.file_list as string[]) : undefined;
}

/** The local directory holding a request's downloaded files - undefined for a SUBMITTED record. */
function localDataDir(local: CacheDbRecord): string | undefined {
  return typeof local.data_dir === 'string' ? local.data_dir : undefined;
}

function localCodegen(local: CacheDbRecord): string | undefined {
  return typeof local.codegen === 'string' ? local.codegen : undefined;
}

/** Size on disk of a request's downloaded files - 0 for a SUBMITTED record, which has no data_dir yet. */
function localSizeBytes(local: CacheDbRecord): number {
  const dataDir = localDataDir(local);
  return dataDir ? directorySize(dataDir) : 0;
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
        dataDir: localDataDir(local),
        codegen: localCodegen(local),
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
    dataDir: localDataDir(local),
    codegen: localCodegen(local),
  };
}

/**
 * Group entries with the same title together (entries within a group are
 * always ordered newest-first). Groups themselves are ordered by title, by
 * their most recent submit time, by the most recent entry's total file
 * count, or by the group's combined size on disk, per `sortBy`/`direction`.
 * Mirrors core._group_by_title in the Python CLI when using the defaults.
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
    // "size" sorts groups by their combined size on disk (matching the total
    // shown in the group's badge) rather than a single representative entry
    // - unlike date/files, per-request sizes in a group genuinely add up to
    // something meaningful.
    const cmp =
      sortBy === 'size'
        ? groupSizeBytes(a.groupEntries) - groupSizeBytes(b.groupEntries)
        : compareEntries(a.groupEntries[0], b.groupEntries[0], sortBy);
    return direction === 'asc' ? cmp : -cmp;
  });

  return groups.map((g) => new TitleGroupItem(g.title, g.groupEntries));
}
