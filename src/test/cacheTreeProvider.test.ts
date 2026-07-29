import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  CacheEntry,
  CacheTreeProvider,
  MessageItem,
  RequestItem,
  TitleGroupItem,
  computeCleanPlan,
  filterEntries,
  groupByTitle,
  sortEntries,
} from '../cacheTreeProvider';
import * as configModule from '../config';
import * as cacheDbModule from '../cacheDb';
import * as serviceXApiModule from '../serviceXApi';
import { NotFoundError, TransformStatus } from '../serviceXApi';

function makeEntry(overrides: Partial<CacheEntry>): CacheEntry {
  return {
    requestId: 'req',
    title: 'Title',
    status: 'Complete',
    files: 1,
    filesCompleted: 1,
    filesFailed: 0,
    stale: false,
    ...overrides,
  };
}

suite('cacheTreeProvider.ts - computeCleanPlan', () => {
  test('keeps the newest Complete request, removes older Complete ones', () => {
    const newer = makeEntry({ requestId: 'newer', submitTime: new Date(500) });
    const older = makeEntry({ requestId: 'older', submitTime: new Date(100) });

    const toDelete = computeCleanPlan([newer, older]);

    assert.deepStrictEqual(toDelete.map((e) => e.requestId), ['older']);
  });

  test('removes every Cancelled and Fatal request regardless of age', () => {
    const newest = makeEntry({ requestId: 'complete', status: 'Complete', submitTime: new Date(500) });
    const cancelled = makeEntry({ requestId: 'cancelled', status: 'Canceled', submitTime: new Date(600) });
    const failed = makeEntry({ requestId: 'failed', status: 'Fatal', submitTime: new Date(700) });
    const running = makeEntry({ requestId: 'running', status: 'Running', submitTime: new Date(800) });

    const toDelete = computeCleanPlan([newest, cancelled, failed, running]).map((e) => e.requestId).sort();

    assert.deepStrictEqual(toDelete, ['cancelled', 'failed']);
  });

  test('returns nothing to delete when there is only one Complete request and nothing else', () => {
    const only = makeEntry({ requestId: 'only' });
    assert.deepStrictEqual(computeCleanPlan([only]), []);
  });
});

suite('cacheTreeProvider.ts - groupByTitle', () => {
  test('groups same-title entries together and sorts within the group newest first', () => {
    const a1 = makeEntry({ requestId: 'a1', title: 'A', submitTime: new Date(100) });
    const b1 = makeEntry({ requestId: 'b1', title: 'B', submitTime: new Date(300) });
    const a2 = makeEntry({ requestId: 'a2', title: 'A', submitTime: new Date(500) });

    const groups = groupByTitle([a1, b1, a2]);

    // "A"'s most recent submission (500) is later than "B"'s (300), so "A"
    // sorts first even though "B" was interleaved between A's two requests.
    assert.deepStrictEqual(
      groups.map((g) => ({ title: g.title, ids: g.entries.map((e) => e.requestId) })),
      [
        { title: 'A', ids: ['a2', 'a1'] },
        { title: 'B', ids: ['b1'] },
      ]
    );
  });

  test('sortBy "date" with direction "asc" puts the least-recently-updated group first', () => {
    const a1 = makeEntry({ requestId: 'a1', title: 'A', submitTime: new Date(100) });
    const b1 = makeEntry({ requestId: 'b1', title: 'B', submitTime: new Date(300) });

    const groups = groupByTitle([a1, b1], 'date', 'asc');

    assert.deepStrictEqual(
      groups.map((g) => g.title),
      ['A', 'B']
    );
  });

  test('sortBy "title" orders groups alphabetically regardless of submit time', () => {
    const b1 = makeEntry({ requestId: 'b1', title: 'B', submitTime: new Date(500) });
    const a1 = makeEntry({ requestId: 'a1', title: 'A', submitTime: new Date(100) });

    const ascending = groupByTitle([b1, a1], 'title', 'asc');
    assert.deepStrictEqual(ascending.map((g) => g.title), ['A', 'B']);

    const descending = groupByTitle([b1, a1], 'title', 'desc');
    assert.deepStrictEqual(descending.map((g) => g.title), ['B', 'A']);
  });

  test('a title sort does not change the newest-first order of entries within a group', () => {
    const older = makeEntry({ requestId: 'older', title: 'A', submitTime: new Date(100) });
    const newer = makeEntry({ requestId: 'newer', title: 'A', submitTime: new Date(500) });

    const groups = groupByTitle([older, newer], 'title', 'asc');

    assert.deepStrictEqual(
      groups[0].entries.map((e) => e.requestId),
      ['newer', 'older']
    );
  });

  test('sortBy "files" orders groups by their most recent entry\'s total file count', () => {
    // "Few"'s most recent entry has fewer files than "Many"'s most recent entry.
    const manyOld = makeEntry({ requestId: 'many-old', title: 'Many', files: 5, submitTime: new Date(100) });
    const manyNew = makeEntry({ requestId: 'many-new', title: 'Many', files: 50, submitTime: new Date(500) });
    const few = makeEntry({ requestId: 'few', title: 'Few', files: 10, submitTime: new Date(200) });

    const ascending = groupByTitle([manyOld, manyNew, few], 'files', 'asc');
    assert.deepStrictEqual(ascending.map((g) => g.title), ['Few', 'Many']);

    const descending = groupByTitle([manyOld, manyNew, few], 'files', 'desc');
    assert.deepStrictEqual(descending.map((g) => g.title), ['Many', 'Few']);
  });
});

suite('cacheTreeProvider.ts - filterEntries', () => {
  test('filters by status', () => {
    const complete = makeEntry({ requestId: 'c', status: 'Complete' });
    const fatal = makeEntry({ requestId: 'f', status: 'Fatal' });

    const result = filterEntries([complete, fatal], { status: new Set(['Fatal']) });

    assert.deepStrictEqual(result.map((e) => e.requestId), ['f']);
  });

  test('filters by backend, excluding entries with no known backend', () => {
    const uchicago = makeEntry({ requestId: 'u', backend: 'uchicago' });
    const testing3 = makeEntry({ requestId: 't', backend: 'testing3' });
    const unknown = makeEntry({ requestId: 'n', backend: undefined });

    const result = filterEntries([uchicago, testing3, unknown], { backend: new Set(['uchicago']) });

    assert.deepStrictEqual(result.map((e) => e.requestId), ['u']);
  });

  test('filters by failures: withFailures, withoutFailures, and all', () => {
    const failed = makeEntry({ requestId: 'failed', filesFailed: 2 });
    const clean = makeEntry({ requestId: 'clean', filesFailed: 0 });

    assert.deepStrictEqual(
      filterEntries([failed, clean], { failures: 'withFailures' }).map((e) => e.requestId),
      ['failed']
    );
    assert.deepStrictEqual(
      filterEntries([failed, clean], { failures: 'withoutFailures' }).map((e) => e.requestId),
      ['clean']
    );
    assert.deepStrictEqual(
      filterEntries([failed, clean], { failures: 'all' }).map((e) => e.requestId).sort(),
      ['clean', 'failed']
    );
  });

  test('filters by date range, excluding entries with no submitTime', () => {
    const inRange = makeEntry({ requestId: 'in', submitTime: new Date('2026-01-15') });
    const tooEarly = makeEntry({ requestId: 'early', submitTime: new Date('2026-01-01') });
    const tooLate = makeEntry({ requestId: 'late', submitTime: new Date('2026-02-01') });
    const noDate = makeEntry({ requestId: 'none', submitTime: undefined });

    const result = filterEntries([inRange, tooEarly, tooLate, noDate], {
      dateFrom: new Date('2026-01-10'),
      dateTo: new Date('2026-01-20'),
    });

    assert.deepStrictEqual(result.map((e) => e.requestId), ['in']);
  });

  test('combines multiple filter dimensions with AND semantics', () => {
    const match = makeEntry({ requestId: 'match', status: 'Fatal', backend: 'uchicago', filesFailed: 1 });
    const wrongStatus = makeEntry({ requestId: 'wrong-status', status: 'Complete', backend: 'uchicago', filesFailed: 1 });
    const wrongBackend = makeEntry({ requestId: 'wrong-backend', status: 'Fatal', backend: 'testing3', filesFailed: 1 });

    const result = filterEntries([match, wrongStatus, wrongBackend], {
      status: new Set(['Fatal']),
      backend: new Set(['uchicago']),
      failures: 'withFailures',
    });

    assert.deepStrictEqual(result.map((e) => e.requestId), ['match']);
  });
});

suite('cacheTreeProvider.ts - sortEntries', () => {
  test('sorts by title ascending and descending', () => {
    const a = makeEntry({ requestId: 'a', title: 'Alpha' });
    const b = makeEntry({ requestId: 'b', title: 'Bravo' });

    assert.deepStrictEqual(sortEntries([b, a], 'title', 'asc').map((e) => e.requestId), ['a', 'b']);
    assert.deepStrictEqual(sortEntries([a, b], 'title', 'desc').map((e) => e.requestId), ['b', 'a']);
  });

  test('sorts by date newest-first (desc) and oldest-first (asc)', () => {
    const older = makeEntry({ requestId: 'older', submitTime: new Date(100) });
    const newer = makeEntry({ requestId: 'newer', submitTime: new Date(500) });

    assert.deepStrictEqual(sortEntries([older, newer], 'date', 'desc').map((e) => e.requestId), ['newer', 'older']);
    assert.deepStrictEqual(sortEntries([newer, older], 'date', 'asc').map((e) => e.requestId), ['older', 'newer']);
  });

  test('sorts by total file count, most-first (desc) and fewest-first (asc)', () => {
    const few = makeEntry({ requestId: 'few', files: 3 });
    const many = makeEntry({ requestId: 'many', files: 300 });

    assert.deepStrictEqual(sortEntries([few, many], 'files', 'desc').map((e) => e.requestId), ['many', 'few']);
    assert.deepStrictEqual(sortEntries([many, few], 'files', 'asc').map((e) => e.requestId), ['few', 'many']);
  });

  test('does not mutate the input array', () => {
    const a = makeEntry({ requestId: 'a', title: 'Alpha' });
    const b = makeEntry({ requestId: 'b', title: 'Bravo' });
    const input = [b, a];

    sortEntries(input, 'title', 'asc');

    assert.deepStrictEqual(input.map((e) => e.requestId), ['b', 'a']);
  });
});

suite('cacheTreeProvider.ts - TreeItem rendering', () => {
  test('TitleGroupItem shows a request count and the right contextValue', () => {
    const item = new TitleGroupItem('MyTitle', [makeEntry({}), makeEntry({})]);

    assert.strictEqual(item.label, 'MyTitle');
    assert.strictEqual(item.description, '2 requests');
    assert.strictEqual(item.contextValue, 'servicexTitleGroup');
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  });

  test('TitleGroupItem uses singular wording for exactly one request', () => {
    const item = new TitleGroupItem('MyTitle', [makeEntry({})]);
    assert.strictEqual(item.description, '1 request');
  });

  test('RequestItem shows file counts, no backend/stale marker for a normal entry', () => {
    const entry = makeEntry({
      status: 'Complete',
      filesCompleted: 8,
      filesFailed: 2,
      files: 10,
    });

    const item = new RequestItem(entry);

    assert.strictEqual(item.label, 'Complete');
    assert.ok(item.description?.toString().includes('Complete 8'));
    assert.ok(item.description?.toString().includes('Failed 2'));
    assert.ok(item.description?.toString().includes('Total 10'));
    assert.ok(!item.description?.toString().includes('via'));
    assert.strictEqual(item.iconPath, undefined);
    assert.strictEqual(item.contextValue, 'servicexCacheRequest');
  });

  test('RequestItem shows the backend when set, and a warning icon when stale', () => {
    const entry = makeEntry({ backend: 'testing3', stale: true });

    const item = new RequestItem(entry);

    assert.ok(item.description?.toString().includes('via testing3'));
    assert.ok(item.tooltip?.toString().includes('Backend: testing3'));
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'warning');
  });

  test('RequestItem tooltip mentions downloaded file count only when there are any', () => {
    const withFiles = new RequestItem(makeEntry({ fileList: ['/a', '/b'] }));
    const withoutFiles = new RequestItem(makeEntry({ fileList: undefined }));

    assert.ok(withFiles.tooltip?.toString().includes('Downloaded files: 2'));
    assert.ok(!withoutFiles.tooltip?.toString().includes('Downloaded files'));
  });

  test('MessageItem carries only a label, optionally with an icon', () => {
    const plain = new MessageItem('Nothing here');
    const withIcon = new MessageItem('Something broke', 'error');

    assert.strictEqual(plain.label, 'Nothing here');
    assert.strictEqual(plain.iconPath, undefined);
    assert.ok(withIcon.iconPath instanceof vscode.ThemeIcon);
    assert.strictEqual((withIcon.iconPath as vscode.ThemeIcon).id, 'error');
  });
});

/** Fakes just enough of ServiceXApi to drive CacheTreeProvider.getChildren()
 *  end-to-end without any real network or filesystem access. Routes by the
 *  endpoint URL that CacheTreeProvider constructed it with. */
function installFakeServiceXApi(
  backendData: Record<string, Record<string, TransformStatus | Error>>
): void {
  class FakeServiceXApi {
    constructor(private readonly endpoint: string) {}
    async getTransformStatus(requestId: string): Promise<TransformStatus> {
      const result = backendData[this.endpoint]?.[requestId];
      if (!result) {
        throw new NotFoundError(`${requestId} not found on ${this.endpoint}`);
      }
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }
  }
  (serviceXApiModule as unknown as { ServiceXApi: unknown }).ServiceXApi = FakeServiceXApi;
}

function fakeStatus(overrides: Partial<TransformStatus>): TransformStatus {
  return {
    requestId: 'req',
    status: 'Complete',
    files: 1,
    filesCompleted: 1,
    filesFailed: 0,
    ...overrides,
  };
}

suite('cacheTreeProvider.ts - CacheTreeProvider.getChildren (integration)', () => {
  const originalLoadConfig = configModule.loadConfig;
  const originalReadCacheRecords = cacheDbModule.readCacheRecords;
  const originalServiceXApi = serviceXApiModule.ServiceXApi;

  teardown(() => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = originalLoadConfig;
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = originalReadCacheRecords;
    (serviceXApiModule as unknown as { ServiceXApi: unknown }).ServiceXApi = originalServiceXApi;
  });

  test('shows a friendly message when the config file cannot be found', async () => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => {
      throw new Error("Can't find a .servicex or servicex.yaml config file");
    };

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();

    assert.strictEqual(roots.length, 1);
    assert.ok(roots[0] instanceof MessageItem);
    assert.ok((roots[0] as MessageItem).label?.toString().includes("Can't find a .servicex"));
  });

  test('shows a friendly message when the local cache is empty', async () => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [{ name: 'default', endpoint: 'https://default.example.org', token: 't' }],
      defaultEndpoint: 'default',
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = () => [];

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();

    assert.strictEqual(roots.length, 1);
    assert.ok(roots[0] instanceof MessageItem);
    assert.strictEqual((roots[0] as MessageItem).label, 'No cached transform requests found.');
  });

  test('groups fetched entries by title and expands correctly', async () => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [{ name: 'default', endpoint: 'https://default.example.org', token: 't' }],
      defaultEndpoint: 'default',
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = () => [
      { request_id: 'a1', title: 'A', status: 'COMPLETE' },
      { request_id: 'b1', title: 'B', status: 'COMPLETE' },
    ];
    installFakeServiceXApi({
      'https://default.example.org': {
        a1: fakeStatus({ requestId: 'a1', title: 'A', submitTime: new Date(100) } as any),
        b1: fakeStatus({ requestId: 'b1', title: 'B', submitTime: new Date(200) } as any),
      },
    });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();

    assert.strictEqual(roots.length, 2);
    assert.ok(roots[0] instanceof TitleGroupItem);
    // "B" was submitted later than "A", so it should sort first.
    assert.strictEqual((roots[0] as TitleGroupItem).title, 'B');

    const children = await provider.getChildren(roots[0]);
    assert.strictEqual(children.length, 1);
    assert.ok(children[0] instanceof RequestItem);
    assert.strictEqual((children[0] as RequestItem).entry.requestId, 'b1');
  });

  test('falls back to a secondary backend and tags every entry once any fallback happens', async () => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [
        { name: 'primary', endpoint: 'https://primary.example.org', token: 't1' },
        { name: 'secondary', endpoint: 'https://secondary.example.org', token: 't2' },
      ],
      defaultEndpoint: 'primary',
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = () => [
      { request_id: 'on-primary', title: 'OnPrimary', status: 'COMPLETE' },
      { request_id: 'on-secondary', title: 'OnSecondary', status: 'COMPLETE' },
    ];
    installFakeServiceXApi({
      'https://primary.example.org': {
        'on-primary': fakeStatus({ requestId: 'on-primary', title: 'OnPrimary' }),
        // 'on-secondary' is absent here -> NotFoundError -> falls through.
      },
      'https://secondary.example.org': {
        'on-secondary': fakeStatus({ requestId: 'on-secondary', title: 'OnSecondary' }),
      },
    });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();
    const allEntries = (
      await Promise.all(roots.map((r) => provider.getChildren(r)))
    ).flat() as RequestItem[];

    const byId = new Map(allEntries.map((r) => [r.entry.requestId, r.entry]));

    // Since "on-secondary" needed the fallback, every entry should now show
    // its backend explicitly - including the one that was on the default.
    assert.strictEqual(byId.get('on-primary')?.backend, 'primary');
    assert.strictEqual(byId.get('on-secondary')?.backend, 'secondary');
  });

  test('keeps entry.backend populated (for filtering) but hides the "via" tag when only one backend is in play', async () => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [
        { name: 'primary', endpoint: 'https://primary.example.org', token: 't1' },
        { name: 'secondary', endpoint: 'https://secondary.example.org', token: 't2' },
      ],
      defaultEndpoint: 'primary',
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = () => [
      { request_id: 'a1', title: 'A', status: 'COMPLETE' },
    ];
    installFakeServiceXApi({
      'https://primary.example.org': {
        a1: fakeStatus({ requestId: 'a1', title: 'A' }),
      },
      'https://secondary.example.org': {},
    });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();
    const entries = (await provider.getChildren(roots[0])) as RequestItem[];

    // The actual backend is always tracked now (so it can be filtered on)...
    assert.strictEqual(entries[0].entry.backend, 'primary');
    // ...but since every entry is on the same single backend, the rendered
    // row shouldn't bother calling it out - that'd just be noise.
    assert.ok(!entries[0].description?.toString().includes('via'));
  });

  test('marks a request not found on any backend as stale with a clear status', async () => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [{ name: 'default', endpoint: 'https://default.example.org', token: 't' }],
      defaultEndpoint: 'default',
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = () => [
      { request_id: 'missing', title: 'Ghost', status: 'COMPLETE' },
    ];
    installFakeServiceXApi({ 'https://default.example.org': {} });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();
    const entries = (await provider.getChildren(roots[0])) as RequestItem[];

    assert.strictEqual(entries[0].entry.stale, true);
    assert.strictEqual(entries[0].entry.status, 'Not found on any backend');
  });

  test('refresh() forces the next getChildren() call to re-fetch', async () => {
    let fetchCount = 0;
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [{ name: 'default', endpoint: 'https://default.example.org', token: 't' }],
      defaultEndpoint: 'default',
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = () => {
      fetchCount++;
      return [];
    };

    const provider = new CacheTreeProvider();
    await provider.getChildren();
    await provider.getChildren();
    assert.strictEqual(fetchCount, 1, 'second call before refresh() should reuse cached results');

    provider.refresh();
    await provider.getChildren();
    assert.strictEqual(fetchCount, 2, 'call after refresh() should re-fetch');
  });
});

suite('cacheTreeProvider.ts - CacheTreeProvider status filter', () => {
  const originalLoadConfig = configModule.loadConfig;
  const originalReadCacheRecords = cacheDbModule.readCacheRecords;
  const originalServiceXApi = serviceXApiModule.ServiceXApi;

  teardown(() => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = originalLoadConfig;
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = originalReadCacheRecords;
    (serviceXApiModule as unknown as { ServiceXApi: unknown }).ServiceXApi = originalServiceXApi;
  });

  async function makeLoadedProvider(fetchCounter?: { count: number }): Promise<CacheTreeProvider> {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [{ name: 'default', endpoint: 'https://default.example.org', token: 't' }],
      defaultEndpoint: 'default',
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = () => {
      if (fetchCounter) {
        fetchCounter.count++;
      }
      return [
        { request_id: 'a1', title: 'A', status: 'COMPLETE' },
        { request_id: 'b1', title: 'B', status: 'FATAL' },
      ];
    };
    installFakeServiceXApi({
      'https://default.example.org': {
        a1: fakeStatus({ requestId: 'a1', title: 'A', status: 'Complete' }),
        b1: fakeStatus({ requestId: 'b1', title: 'B', status: 'Fatal' }),
      },
    });

    const provider = new CacheTreeProvider();
    await provider.getChildren();
    return provider;
  }

  test('getAvailableStatuses lists distinct statuses from the loaded entries', async () => {
    const provider = await makeLoadedProvider();
    assert.deepStrictEqual(provider.getAvailableStatuses(), ['Complete', 'Fatal']);
  });

  test('setStatusFilter narrows the tree without re-fetching', async () => {
    const fetchCounter = { count: 0 };
    const provider = await makeLoadedProvider(fetchCounter);

    provider.setStatusFilter(new Set(['Fatal']));
    const roots = await provider.getChildren();

    assert.strictEqual(fetchCounter.count, 1, 'filtering should not trigger a re-fetch');
    assert.strictEqual(roots.length, 1);
    assert.strictEqual((roots[0] as TitleGroupItem).title, 'B');
  });

  test('setStatusFilter(undefined) restores every entry', async () => {
    const provider = await makeLoadedProvider();

    provider.setStatusFilter(new Set(['Fatal']));
    provider.setStatusFilter(undefined);
    const roots = await provider.getChildren();

    assert.strictEqual(roots.length, 2);
    assert.strictEqual(provider.getStatusFilter(), undefined);
  });

  test('shows a filter-specific empty message when nothing matches', async () => {
    const provider = await makeLoadedProvider();

    provider.setStatusFilter(new Set(['Canceled']));
    const roots = await provider.getChildren();

    assert.strictEqual(roots.length, 1);
    assert.ok(roots[0] instanceof MessageItem);
    assert.strictEqual((roots[0] as MessageItem).label, 'No cached requests match the current filters.');
  });

  test('ensureLoaded fetches once but is a no-op once loaded', async () => {
    const fetchCounter = { count: 0 };
    const provider = await makeLoadedProvider(fetchCounter);

    await provider.ensureLoaded();
    await provider.ensureLoaded();

    assert.strictEqual(fetchCounter.count, 1);
  });

  test('TitleGroupItem.allEntries keeps the full group even when the filter hides some of it', async () => {
    // a1/a2 share a title so filtering can hide one but not the other.
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [{ name: 'default', endpoint: 'https://default.example.org', token: 't' }],
      defaultEndpoint: 'default',
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = () => [
      { request_id: 'a1', title: 'A', status: 'COMPLETE' },
      { request_id: 'a2', title: 'A', status: 'CANCELED' },
    ];
    installFakeServiceXApi({
      'https://default.example.org': {
        a1: fakeStatus({ requestId: 'a1', title: 'A', status: 'Complete' }),
        a2: fakeStatus({ requestId: 'a2', title: 'A', status: 'Canceled' }),
      },
    });

    const provider = new CacheTreeProvider();
    await provider.getChildren();

    provider.setStatusFilter(new Set(['Complete']));
    const roots = await provider.getChildren();
    const group = roots[0] as TitleGroupItem;

    assert.strictEqual(group.entries.length, 1, 'only the visible (Complete) entry should show as a child');
    assert.strictEqual(group.entries[0].requestId, 'a1');
    assert.deepStrictEqual(
      group.allEntries.map((e) => e.requestId).sort(),
      ['a1', 'a2'],
      'allEntries should still carry the request hidden by the filter, for Clean to act on'
    );
  });
});

suite('cacheTreeProvider.ts - CacheTreeProvider backend/failure/date filters, sort, and grouping', () => {
  const originalLoadConfig = configModule.loadConfig;
  const originalReadCacheRecords = cacheDbModule.readCacheRecords;
  const originalServiceXApi = serviceXApiModule.ServiceXApi;

  teardown(() => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = originalLoadConfig;
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = originalReadCacheRecords;
    (serviceXApiModule as unknown as { ServiceXApi: unknown }).ServiceXApi = originalServiceXApi;
  });

  /**
   * Three requests spread across two backends, with distinct titles, submit
   * dates, and one with failed files - enough variety to exercise every new
   * filter/sort dimension.
   */
  async function makeRichProvider(): Promise<CacheTreeProvider> {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [
        { name: 'uchicago', endpoint: 'https://uchicago.example.org', token: 't1' },
        { name: 'testing3', endpoint: 'https://testing3.example.org', token: 't2' },
      ],
      defaultEndpoint: 'uchicago',
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = () => [
      { request_id: 'zebra1', title: 'Zebra', status: 'COMPLETE' },
      { request_id: 'apple1', title: 'Apple', status: 'COMPLETE' },
      { request_id: 'mango1', title: 'Mango', status: 'FATAL' },
    ];
    installFakeServiceXApi({
      'https://uchicago.example.org': {
        zebra1: fakeStatus({
          requestId: 'zebra1',
          title: 'Zebra',
          status: 'Complete',
          submitTime: new Date('2026-01-05'),
          filesFailed: 0,
          files: 10,
        }),
        apple1: fakeStatus({
          requestId: 'apple1',
          title: 'Apple',
          status: 'Complete',
          submitTime: new Date('2026-01-20'),
          filesFailed: 1,
          files: 100,
        }),
      },
      'https://testing3.example.org': {
        mango1: fakeStatus({
          requestId: 'mango1',
          title: 'Mango',
          status: 'Fatal',
          submitTime: new Date('2026-01-10'),
          filesFailed: 3,
          files: 50,
        }),
      },
    });

    const provider = new CacheTreeProvider();
    await provider.getChildren();
    return provider;
  }

  test('getAvailableBackends lists distinct backends from the loaded entries', async () => {
    const provider = await makeRichProvider();
    assert.deepStrictEqual(provider.getAvailableBackends(), ['testing3', 'uchicago']);
  });

  test('setBackendFilter narrows the tree to the chosen backend(s)', async () => {
    const provider = await makeRichProvider();

    provider.setBackendFilter(new Set(['testing3']));
    const roots = (await provider.getChildren()) as TitleGroupItem[];

    assert.deepStrictEqual(roots.map((g) => g.title), ['Mango']);
    assert.ok(provider.hasActiveFilter());
  });

  test('setFailureFilter narrows to entries with/without failed files', async () => {
    const provider = await makeRichProvider();

    provider.setFailureFilter('withFailures');
    const withFailures = (await provider.getChildren()) as TitleGroupItem[];
    assert.deepStrictEqual(withFailures.map((g) => g.title).sort(), ['Apple', 'Mango']);

    provider.setFailureFilter('withoutFailures');
    const withoutFailures = (await provider.getChildren()) as TitleGroupItem[];
    assert.deepStrictEqual(withoutFailures.map((g) => g.title), ['Zebra']);

    provider.setFailureFilter('all');
    assert.strictEqual(provider.hasActiveFilter(), false);
  });

  test('setDateFilter narrows to entries submitted within range', async () => {
    const provider = await makeRichProvider();

    provider.setDateFilter({ from: new Date('2026-01-08'), to: new Date('2026-01-15') });
    const roots = (await provider.getChildren()) as TitleGroupItem[];

    assert.deepStrictEqual(roots.map((g) => g.title), ['Mango']);
  });

  test('setDateFilter(undefined) clears it', async () => {
    const provider = await makeRichProvider();

    provider.setDateFilter({ from: new Date('2026-01-08'), to: new Date('2026-01-15') });
    provider.setDateFilter(undefined);

    assert.strictEqual(provider.getDateFilter(), undefined);
    assert.strictEqual(provider.hasActiveFilter(), false);
  });

  test('clearAllFilters resets status, backend, failures, and date together', async () => {
    const provider = await makeRichProvider();
    provider.setStatusFilter(new Set(['Fatal']));
    provider.setBackendFilter(new Set(['testing3']));
    provider.setFailureFilter('withFailures');
    provider.setDateFilter({ from: new Date('2026-01-01') });

    provider.clearAllFilters();

    assert.strictEqual(provider.hasActiveFilter(), false);
    const roots = (await provider.getChildren()) as TitleGroupItem[];
    assert.strictEqual(roots.length, 3);
  });

  test('setSort("title", "asc") orders groups alphabetically', async () => {
    const provider = await makeRichProvider();

    provider.setSort('title', 'asc');
    const roots = (await provider.getChildren()) as TitleGroupItem[];

    assert.deepStrictEqual(roots.map((g) => g.title), ['Apple', 'Mango', 'Zebra']);
  });

  test('setSort("date", "asc") orders groups oldest-first', async () => {
    const provider = await makeRichProvider();

    provider.setSort('date', 'asc');
    const roots = (await provider.getChildren()) as TitleGroupItem[];

    assert.deepStrictEqual(roots.map((g) => g.title), ['Zebra', 'Mango', 'Apple']);
  });

  test('setSort("files", "desc") orders groups by total file count, most first', async () => {
    const provider = await makeRichProvider();

    // Zebra: 10 files, Mango: 50 files, Apple: 100 files.
    provider.setSort('files', 'desc');
    const roots = (await provider.getChildren()) as TitleGroupItem[];

    assert.deepStrictEqual(roots.map((g) => g.title), ['Apple', 'Mango', 'Zebra']);
  });

  test('setGroupingEnabled(false) + setSort("files", "asc") sorts the flat list fewest-files-first', async () => {
    const provider = await makeRichProvider();

    provider.setGroupingEnabled(false);
    provider.setSort('files', 'asc');
    const roots = (await provider.getChildren()) as RequestItem[];

    assert.deepStrictEqual(roots.map((r) => r.entry.title), ['Zebra', 'Mango', 'Apple']);
  });

  test('setGroupingEnabled(false) renders a flat, title-labeled list instead of groups', async () => {
    const provider = await makeRichProvider();

    provider.setGroupingEnabled(false);
    const roots = await provider.getChildren();

    assert.strictEqual(provider.isGroupingEnabled(), false);
    assert.ok(roots.every((r) => r instanceof RequestItem));
    const requestItems = roots as RequestItem[];
    assert.deepStrictEqual(
      requestItems.map((r) => r.entry.requestId).sort(),
      ['apple1', 'mango1', 'zebra1']
    );
    // Ungrouped rows must show the title since there's no parent group node to convey it.
    assert.ok(requestItems.every((r) => r.description?.toString().includes(r.entry.title)));
  });

  test('setGroupingEnabled(false) + setSort("title", "asc") sorts the flat list by title', async () => {
    const provider = await makeRichProvider();

    provider.setGroupingEnabled(false);
    provider.setSort('title', 'asc');
    const roots = (await provider.getChildren()) as RequestItem[];

    assert.deepStrictEqual(roots.map((r) => r.entry.title), ['Apple', 'Mango', 'Zebra']);
  });

  test('re-enabling grouping restores the grouped view with the current sort applied', async () => {
    const provider = await makeRichProvider();

    provider.setSort('title', 'asc');
    provider.setGroupingEnabled(false);
    provider.setGroupingEnabled(true);
    const roots = (await provider.getChildren()) as TitleGroupItem[];

    assert.ok(roots.every((r) => r instanceof TitleGroupItem));
    assert.deepStrictEqual(roots.map((g) => g.title), ['Apple', 'Mango', 'Zebra']);
  });
});
