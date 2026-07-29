import * as vscode from 'vscode';
import { loadConfig, orderedEndpoints } from './config';
import { ServiceXApi, NotFoundError } from './serviceXApi';
import { readCacheRecords, completedRecords, submittedRecords, CacheDbRecord } from './cacheDb';

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
  /** Name of the backend the request was actually found on, only set when
   *  that isn't the default/selected backend (i.e. a fallback was used). */
  backend?: string;
  /** Locally downloaded file paths for this request, from the local cache
   *  record - undefined/empty if nothing has been downloaded yet. */
  fileList?: string[];
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
  constructor(public readonly title: string, public readonly entries: CacheEntry[]) {
    super(title, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${entries.length} request${entries.length === 1 ? '' : 's'}`;
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
class MessageItem extends vscode.TreeItem {
  constructor(message: string, icon?: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
  }
}

export class RequestItem extends vscode.TreeItem {
  constructor(public readonly entry: CacheEntry) {
    super(entry.status, vscode.TreeItemCollapsibleState.None);
    this.description =
      `${formatDateTime(entry.submitTime)} → ${formatDateTime(entry.finishTime)} · ` +
      `Files: Complete ${entry.filesCompleted} · Failed ${entry.filesFailed} · Total ${entry.files}` +
      (entry.backend ? ` · via ${entry.backend}` : '');
    this.tooltip = [
      `Request ID: ${entry.requestId}`,
      `Status: ${entry.status}`,
      `Submitted: ${formatDateTime(entry.submitTime)}`,
      `Finished: ${formatDateTime(entry.finishTime)}`,
      `Files Complete: ${entry.filesCompleted}`,
      `Files Failed: ${entry.filesFailed}`,
      `Files Total: ${entry.files}`,
      ...(entry.backend ? [`Backend: ${entry.backend}`] : []),
      ...(entry.fileList?.length ? [`Downloaded files: ${entry.fileList.length}`] : []),
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

  private groups: TitleGroupItem[] = [];
  private loaded = false;

  refresh(): void {
    this.loaded = false;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CacheNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CacheNode): Promise<CacheNode[]> {
    if (element instanceof TitleGroupItem) {
      return element.entries.map((e) => new RequestItem(e));
    }
    if (element) {
      return [];
    }

    if (!this.loaded) {
      try {
        this.groups = groupByTitle(await this.fetchEntries());
      } catch (e) {
        this.groups = [];
        this.loaded = true;
        return [new MessageItem(`Error: ${(e as Error).message}`, 'error')];
      }
      this.loaded = true;
    }

    return this.groups.length ? this.groups : [new MessageItem('No cached transform requests found.')];
  }

  private async fetchEntries(): Promise<CacheEntry[]> {
    const settings = vscode.workspace.getConfiguration('servicex');
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const config = loadConfig(settings.get<string>('configPath') || undefined, workspaceFolder);
    const endpoints = orderedEndpoints(config, settings.get<string>('backend') || undefined);
    const defaultBackendName = endpoints[0].name;
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

    const entries = await Promise.all(
      Array.from(localByRequestId.entries()).map(([requestId, local]) =>
        fetchOneEntry(namedApis, requestId, local)
      )
    );

    // Only show which backend each request came from if at least one of
    // them actually needed a fallback - otherwise it's just noise, since
    // every row would say the same (default) backend.
    const anyNonDefault = entries.some((e) => e.backend && e.backend !== defaultBackendName);
    if (!anyNonDefault) {
      for (const e of entries) {
        e.backend = undefined;
      }
    }

    return entries;
  }
}

function localFileList(local: CacheDbRecord): string[] | undefined {
  return Array.isArray(local.file_list) ? (local.file_list as string[]) : undefined;
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
  };
}

/**
 * Group entries with the same title together, then sort within each group
 * by submit time (newest first). Groups themselves are ordered by their most
 * recent submit time. Mirrors core._group_by_title in the Python CLI.
 */
function groupByTitle(entries: CacheEntry[]): TitleGroupItem[] {
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

  groups.sort(
    (a, b) => (b.groupEntries[0].submitTime?.getTime() ?? 0) - (a.groupEntries[0].submitTime?.getTime() ?? 0)
  );

  return groups.map((g) => new TitleGroupItem(g.title, g.groupEntries));
}
