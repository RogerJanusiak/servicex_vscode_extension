import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  BackendGroupItem,
  CacheTreeProvider,
  DASHBOARD_SOURCE,
  MessageItem,
  RequestDetailItem,
  RequestItem,
  TitleGroupItem,
  buildRequestDetails,
  clearServiceXApiCache,
  computeCleanPlan,
  filterEntries,
  formatBytes,
  getServiceXApi,
  groupByTitle,
  isTerminalStatus,
  sortEntries,
} from '../cacheTreeProvider';
import * as configModule from '../config';
import {
  stub,
  restoreStubs,
  makeEntry,
  fakeStatus,
  stubConfig,
  stubCacheRecords,
  stubServiceXApi,
  StubServiceXApiOptions,
  DEFAULT_ENDPOINT,
} from './testUtils';

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

  test('sortBy "size" orders groups by their combined size on disk, not just the most recent entry', () => {
    // "Spread"'s most recent entry alone (5 B) is smaller than "Single"'s
    // only entry (25 B) - but its total across both entries (30 B) is
    // larger. Group size must sum, unlike the "files"/"date" dimensions
    // above which use only the most recent entry as a stand-in.
    const spreadOld = makeEntry({ requestId: 'spread-old', title: 'Spread', sizeBytes: 25, submitTime: new Date(100) });
    const spreadNew = makeEntry({ requestId: 'spread-new', title: 'Spread', sizeBytes: 5, submitTime: new Date(500) });
    const single = makeEntry({ requestId: 'single', title: 'Single', sizeBytes: 25, submitTime: new Date(200) });

    const descending = groupByTitle([spreadOld, spreadNew, single], 'size', 'desc');
    assert.deepStrictEqual(descending.map((g) => g.title), ['Spread', 'Single']);

    const ascending = groupByTitle([spreadOld, spreadNew, single], 'size', 'asc');
    assert.deepStrictEqual(ascending.map((g) => g.title), ['Single', 'Spread']);
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

  test('sorts by size on disk, largest-first (desc) and smallest-first (asc)', () => {
    const small = makeEntry({ requestId: 'small', sizeBytes: 1024 });
    const large = makeEntry({ requestId: 'large', sizeBytes: 1024 * 1024 });

    assert.deepStrictEqual(sortEntries([small, large], 'size', 'desc').map((e) => e.requestId), ['large', 'small']);
    assert.deepStrictEqual(sortEntries([large, small], 'size', 'asc').map((e) => e.requestId), ['small', 'large']);
  });

  test('does not mutate the input array', () => {
    const a = makeEntry({ requestId: 'a', title: 'Alpha' });
    const b = makeEntry({ requestId: 'b', title: 'Bravo' });
    const input = [b, a];

    sortEntries(input, 'title', 'asc');

    assert.deepStrictEqual(input.map((e) => e.requestId), ['b', 'a']);
  });
});

suite('cacheTreeProvider.ts - formatBytes', () => {
  test('formats zero and sub-byte inputs as "0 B"', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(-5), '0 B');
  });

  test('formats bytes with no decimal place', () => {
    assert.strictEqual(formatBytes(1), '1 B');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1023), '1023 B');
  });

  test('switches to KB at 1024 bytes, with one decimal place', () => {
    assert.strictEqual(formatBytes(1024), '1.0 KB');
    assert.strictEqual(formatBytes(1536), '1.5 KB');
  });

  test('switches to MB and GB at the right powers of 1024', () => {
    assert.strictEqual(formatBytes(1024 * 1024), '1.0 MB');
    assert.strictEqual(formatBytes(128.4 * 1024 * 1024), '128.4 MB');
    assert.strictEqual(formatBytes(1024 * 1024 * 1024), '1.0 GB');
  });

  test('caps out at TB rather than inventing a larger unit', () => {
    assert.strictEqual(formatBytes(1024 ** 4), '1.0 TB');
    assert.strictEqual(formatBytes(1024 ** 5), '1024.0 TB');
  });
});

suite('cacheTreeProvider.ts - TreeItem rendering', () => {
  test('TitleGroupItem shows a request count and the right contextValue', () => {
    const item = new TitleGroupItem('MyTitle', [makeEntry(), makeEntry()]);

    assert.strictEqual(item.label, 'MyTitle');
    assert.strictEqual(item.description, '2 requests');
    assert.strictEqual(item.contextValue, 'servicexTitleGroup');
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  });

  test('TitleGroupItem uses singular wording for exactly one request', () => {
    const item = new TitleGroupItem('MyTitle', [makeEntry()]);
    assert.strictEqual(item.description, '1 request');
  });

  test('TitleGroupItem appends the total size on disk when any entry has one', () => {
    const withSize = new TitleGroupItem('MyTitle', [
      makeEntry({ requestId: 'a', sizeBytes: 1024 }),
      makeEntry({ requestId: 'b', sizeBytes: 512 }),
    ]);
    assert.strictEqual(withSize.description, '2 requests · 1.5 KB');

    const withoutSize = new TitleGroupItem('MyTitle', [makeEntry({ sizeBytes: 0 })]);
    assert.strictEqual(withoutSize.description, '1 request');
  });

  test('TitleGroupItem/BackendGroupItem/RequestItem carry a stable id so a soft refresh does not collapse them', () => {
    // Two separately-constructed items for the same underlying data (e.g.
    // one built before a refresh, one after) must produce the same id -
    // that's what lets VS Code recognize them as "the same" node and keep
    // it expanded across the periodic refresh the live-polling loop fires.
    const entryA = makeEntry({ requestId: 'req-1', backend: 'uchicago' });
    const entryB = makeEntry({ requestId: 'req-1', backend: 'uchicago', status: 'Running' });
    assert.strictEqual(new RequestItem(entryA).id, new RequestItem(entryB).id);
    assert.strictEqual(new RequestItem(entryA).id, 'request:req-1');

    const group1 = new TitleGroupItem('MyTitle', [entryA]);
    const group2 = new TitleGroupItem('MyTitle', [entryB]);
    assert.strictEqual(group1.id, group2.id);
    assert.strictEqual(group1.id, 'uchicago:MyTitle');

    const backend1 = new BackendGroupItem('uchicago', [entryA]);
    const backend2 = new BackendGroupItem('uchicago', [entryB], 'some error');
    assert.strictEqual(backend1.id, backend2.id);
    assert.strictEqual(backend1.id, 'backend:uchicago');
  });

  test('RequestItem is collapsed by default, showing only status and dates - no files/size/backend', () => {
    const entry = makeEntry({
      status: 'Complete',
      filesCompleted: 8,
      filesFailed: 2,
      files: 10,
      sizeBytes: 1024 * 1024,
      backend: 'testing3',
      submitTime: new Date(2026, 0, 1),
      finishTime: new Date(2026, 0, 2),
    });

    const item = new RequestItem(entry);

    assert.strictEqual(item.label, 'Complete');
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.ok(item.description?.toString().includes('→'), 'expected the submit → finish date range');
    assert.ok(!item.description?.toString().includes('Complete 8'), 'file counts should not be in the collapsed row');
    assert.ok(!item.description?.toString().includes('MB'), 'size should not be in the collapsed row');
    assert.ok(!item.description?.toString().includes('via'), 'backend should not be in the collapsed row');
    assert.strictEqual(item.contextValue, 'servicexCacheRequest');
  });

  test('RequestItem prefixes the title in its description only when asked to (ungrouped view)', () => {
    const entry = makeEntry({ title: 'MyRequest' });

    assert.ok(!new RequestItem(entry).description?.toString().includes('MyRequest'));
    assert.ok(new RequestItem(entry, { showTitle: true }).description?.toString().includes('MyRequest'));
  });

  test('RequestItem pads a missing submit date so "→" lines up with rows that have one', () => {
    const withBothDates = new RequestItem(
      makeEntry({ submitTime: new Date(2026, 0, 15, 14, 30), finishTime: new Date(2026, 0, 16, 9, 5) })
    );
    const withNoSubmitDate = new RequestItem(makeEntry({ submitTime: undefined, finishTime: undefined }));

    const arrowColumn = (description: string) => description.indexOf('→');

    assert.ok(arrowColumn(withBothDates.description!.toString()) > 0);
    assert.strictEqual(
      arrowColumn(withBothDates.description!.toString()),
      arrowColumn(withNoSubmitDate.description!.toString())
    );
  });

  test('RequestItem shows the backend in its tooltip when set, and a warning icon when stale', () => {
    const entry = makeEntry({ backend: 'testing3', stale: true });

    const item = new RequestItem(entry);

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

  test('RequestItem tooltip mentions size on disk only when something has downloaded', () => {
    const withSize = new RequestItem(makeEntry({ sizeBytes: 1024 * 1024 }));
    const withoutSize = new RequestItem(makeEntry({ sizeBytes: 0 }));

    assert.ok(withSize.tooltip?.toString().includes('Size on disk: 1.0 MB'));
    assert.ok(!withoutSize.tooltip?.toString().includes('Size on disk'));
  });

  test('RequestItem shows a label in its description and tooltip when set, omits both when unset', () => {
    const labeled = new RequestItem(makeEntry({ label: 'signal region A' }));
    const unlabeled = new RequestItem(makeEntry({ label: undefined }));

    assert.ok(labeled.description?.toString().startsWith('signal region A · '));
    assert.ok(labeled.tooltip?.toString().includes('Label: signal region A'));
    assert.ok(!unlabeled.description?.toString().includes('·'));
    assert.ok(!unlabeled.tooltip?.toString().includes('Label:'));
  });

  test('RequestItem puts the label before the title in the description when both are shown', () => {
    const item = new RequestItem(makeEntry({ label: 'signal region A', title: 'MyRequest' }), { showTitle: true });

    const description = item.description!.toString();
    assert.ok(description.indexOf('signal region A') < description.indexOf('MyRequest'));
  });

  test('buildRequestDetails always includes request ID and file counts', () => {
    const details = buildRequestDetails(
      makeEntry({ requestId: 'req-42', filesCompleted: 8, filesFailed: 2, files: 10 })
    );

    assert.deepStrictEqual(
      details.map((d) => d.label),
      ['Request ID: req-42', 'Files: Complete 8 · Failed 2 · Total 10']
    );
    assert.ok(details.every((d) => d.contextValue === 'servicexRequestDetail'));
    assert.ok(details.every((d) => d.collapsibleState === vscode.TreeItemCollapsibleState.None));
  });

  test('buildRequestDetails adds downloaded-files/size/backend rows only when there is something to say', () => {
    const bare = buildRequestDetails(makeEntry({ sizeBytes: 0, backend: undefined, fileList: undefined }));
    assert.deepStrictEqual(
      bare.map((d) => d.label),
      ['Request ID: req', 'Files: Complete 1 · Failed 0 · Total 1']
    );

    const full = buildRequestDetails(
      makeEntry({ sizeBytes: 2048, backend: 'uchicago', fileList: ['/a', '/b', '/c'] })
    );
    // Downloaded files sits right below the transformed-files line, ahead
    // of size/backend.
    assert.deepStrictEqual(
      full.map((d) => d.label),
      [
        'Request ID: req',
        'Files: Complete 1 · Failed 0 · Total 1',
        'Downloaded files: 3',
        'Size on disk: 2.0 KB',
        'Backend: uchicago',
      ]
    );
  });

  test('buildRequestDetails shows a progress bar driven by filesCompleted', () => {
    const details = buildRequestDetails(
      makeEntry({ status: 'Running', filesCompleted: 15, filesFailed: 0, files: 20 })
    );

    assert.deepStrictEqual(
      details.map((d) => d.label),
      [
        'Request ID: req',
        'Files: Complete 15 · Failed 0 · Total 20',
        'Progress: ███████████████░░░░░ 75% (15/20 files)',
      ]
    );
  });

  test('buildRequestDetails prefers downloadedFiles over filesCompleted for the progress bar', () => {
    // filesCompleted (transformed server-side) and downloadedFiles (landed
    // on local disk) deliberately disagree here: a cache-panel user is
    // waiting on the download, so the bar must follow the latter.
    const details = buildRequestDetails(
      makeEntry({ status: 'Running', filesCompleted: 15, downloadedFiles: 5, files: 20 })
    );

    assert.ok(
      details.some((d) => d.label === 'Progress: █████░░░░░░░░░░░░░░░ 25% (5/20 files downloaded)')
    );
  });

  test('buildRequestDetails omits the progress bar for a terminal status', () => {
    const details = buildRequestDetails(makeEntry({ status: 'Complete', filesCompleted: 20, files: 20 }));

    assert.ok(!details.some((d) => d.label?.toString().startsWith('Progress:')));
  });

  test('buildRequestDetails omits the progress bar while the file count is still unknown', () => {
    const details = buildRequestDetails(makeEntry({ status: 'Submitted', filesCompleted: 0, files: 0 }));

    assert.ok(!details.some((d) => d.label?.toString().startsWith('Progress:')));
  });

  test('isTerminalStatus recognizes Complete, Canceled, Fatal, and Bad Dataset as terminal', () => {
    for (const status of ['Complete', 'Canceled', 'Fatal', 'Bad Dataset']) {
      assert.strictEqual(isTerminalStatus(status), true, status);
    }
  });

  test('isTerminalStatus treats in-progress and unrecognized statuses as non-terminal', () => {
    for (const status of ['Running', 'Submitted', 'Lookup', 'Pending Lookup', 'Something New']) {
      assert.strictEqual(isTerminalStatus(status), false, status);
    }
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

suite('cacheTreeProvider.ts - CacheTreeProvider.getChildren (integration)', () => {
  teardown(restoreStubs);

  test('shows a friendly message when the config file cannot be found', async () => {
    stub(configModule, 'loadConfig', () => {
      throw new Error("Can't find a .servicex or servicex.yaml config file");
    });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();

    assert.strictEqual(roots.length, 1);
    assert.ok(roots[0] instanceof MessageItem);
    assert.ok((roots[0] as MessageItem).label?.toString().includes("Can't find a .servicex"));
  });

  test('shows a friendly message when the local cache is empty', async () => {
    stubConfig();
    stubCacheRecords([]);

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();

    assert.strictEqual(roots.length, 1);
    assert.ok(roots[0] instanceof MessageItem);
    assert.strictEqual((roots[0] as MessageItem).label, 'No cached transform requests found.');
  });

  test('groups fetched entries by title and expands correctly', async () => {
    stubConfig();
    stubCacheRecords([
      { request_id: 'a1', title: 'A', status: 'COMPLETE' },
      { request_id: 'b1', title: 'B', status: 'COMPLETE' },
    ]);
    stubServiceXApi({
      'https://default.example.org': {
        a1: fakeStatus({ requestId: 'a1', title: 'A', submitTime: new Date(100) }),
        b1: fakeStatus({ requestId: 'b1', title: 'B', submitTime: new Date(200) }),
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

    // Expanding that RequestItem in turn shows its detail rows.
    const details = await provider.getChildren(children[0]);
    assert.ok(details.every((d) => d instanceof RequestDetailItem));
    assert.ok((details as RequestDetailItem[]).some((d) => d.label === 'Request ID: b1'));
  });

  test('falls back to a secondary backend and tags every entry once any fallback happens', async () => {
    stubConfig([
      { name: 'primary', endpoint: 'https://primary.example.org', token: 't1' },
      { name: 'secondary', endpoint: 'https://secondary.example.org', token: 't2' },
    ]);
    stubCacheRecords([
      { request_id: 'on-primary', title: 'OnPrimary', status: 'COMPLETE' },
      { request_id: 'on-secondary', title: 'OnSecondary', status: 'COMPLETE' },
    ]);
    stubServiceXApi({
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

  test('keeps entry.backend populated (for filtering) even when everything is on the same single backend', async () => {
    stubConfig([
      { name: 'primary', endpoint: 'https://primary.example.org', token: 't1' },
      { name: 'secondary', endpoint: 'https://secondary.example.org', token: 't2' },
    ]);
    stubCacheRecords([{ request_id: 'a1', title: 'A', status: 'COMPLETE' }]);
    stubServiceXApi({
      'https://primary.example.org': {
        a1: fakeStatus({ requestId: 'a1', title: 'A' }),
      },
      'https://secondary.example.org': {},
    });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();
    const entries = (await provider.getChildren(roots[0])) as RequestItem[];

    assert.strictEqual(entries[0].entry.backend, 'primary');
    // The collapsed row never shows backend (or any other detail) regardless
    // of how many backends are configured - it only ever shows in the
    // expanded detail rows (see buildRequestDetails tests) or the backend
    // filter picker.
    assert.ok(!entries[0].description?.toString().includes('via'));
  });

  test('marks a request not found on any backend as stale with a clear status', async () => {
    stubConfig();
    stubCacheRecords([{ request_id: 'missing', title: 'Ghost', status: 'COMPLETE' }]);
    stubServiceXApi({ 'https://default.example.org': {} });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();
    const entries = (await provider.getChildren(roots[0])) as RequestItem[];

    assert.strictEqual(entries[0].entry.stale, true);
    assert.strictEqual(entries[0].entry.status, 'Not found on any backend');
  });

  test("computes an entry's sizeBytes, downloadedFiles, and dataDir from its local data_dir, all empty when it has none", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-size-test-'));
    try {
      fs.writeFileSync(path.join(dataDir, 'file1.root'), 'x'.repeat(1024));
      fs.writeFileSync(path.join(dataDir, 'file2.root'), 'x'.repeat(2048));

      stubConfig();
      stubCacheRecords([
        { request_id: 'downloaded', title: 'A', status: 'COMPLETE', data_dir: dataDir },
        { request_id: 'submitted', title: 'B', status: 'SUBMITTED' },
      ]);
      stubServiceXApi({
        'https://default.example.org': {
          downloaded: fakeStatus({ requestId: 'downloaded', title: 'A' }),
          submitted: fakeStatus({ requestId: 'submitted', title: 'B', status: 'Running' }),
        },
      });

      const provider = new CacheTreeProvider();
      const roots = (await provider.getChildren()) as TitleGroupItem[];
      const allEntries = (await Promise.all(roots.map((r) => provider.getChildren(r))))
        .flat()
        .map((n) => (n as RequestItem).entry);
      const byId = new Map(allEntries.map((e) => [e.requestId, e]));

      assert.strictEqual(byId.get('downloaded')?.sizeBytes, 3072);
      assert.strictEqual(byId.get('downloaded')?.dataDir, dataDir);
      assert.strictEqual(byId.get('downloaded')?.downloadedFiles, 2);
      // A record with no data_dir yet still gets the derived download path
      // (<cache_path>/<request_id>, matching the servicex client) - it just
      // doesn't exist on disk here, so both counts read as 0.
      assert.strictEqual(byId.get('submitted')?.dataDir, path.join('/fake/cache', 'submitted'));
      assert.strictEqual(byId.get('submitted')?.sizeBytes, 0);
      assert.strictEqual(byId.get('submitted')?.downloadedFiles, 0);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('applies a label from .servicex/labels.json onto the matching entry, leaving unlabeled entries alone', async () => {
    const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-labels-test-'));
    try {
      fs.mkdirSync(path.join(cachePath, '.servicex'), { recursive: true });
      fs.writeFileSync(
        path.join(cachePath, '.servicex', 'labels.json'),
        JSON.stringify({ labeled: 'signal region A' })
      );

      stub(configModule, 'loadConfig', () => ({
        endpoints: [DEFAULT_ENDPOINT],
        defaultEndpoint: DEFAULT_ENDPOINT.name,
        cachePath,
        configFile: '/fake/servicex.yaml',
      }));
      stubCacheRecords([
        { request_id: 'labeled', title: 'A', status: 'COMPLETE' },
        { request_id: 'unlabeled', title: 'B', status: 'COMPLETE' },
      ]);
      stubServiceXApi({
        'https://default.example.org': {
          labeled: fakeStatus({ requestId: 'labeled', title: 'A' }),
          unlabeled: fakeStatus({ requestId: 'unlabeled', title: 'B' }),
        },
      });

      const provider = new CacheTreeProvider();
      const roots = (await provider.getChildren()) as TitleGroupItem[];
      const allEntries = (await Promise.all(roots.map((r) => provider.getChildren(r))))
        .flat()
        .map((n) => (n as RequestItem).entry);
      const byId = new Map(allEntries.map((e) => [e.requestId, e]));

      assert.strictEqual(byId.get('labeled')?.label, 'signal region A');
      assert.strictEqual(byId.get('unlabeled')?.label, undefined);
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true });
    }
  });

  test('a still-running cache entry counts files already downloaded into the derived path, despite no data_dir in its record', async () => {
    // The real shape of a mid-download entry: the servicex client's record
    // has no data_dir yet (only written once the download fully finishes),
    // but it has already created <cache_path>/<request_id> and is filling
    // it file by file. filesCompleted (8, transformed server-side) and the
    // 3 files actually on disk deliberately disagree, to prove the bar
    // follows what's been downloaded.
    const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-derived-test-'));
    try {
      const downloadDir = path.join(cachePath, 'r1');
      fs.mkdirSync(downloadDir, { recursive: true });
      fs.writeFileSync(path.join(downloadDir, 'file1.root'), 'x');
      fs.writeFileSync(path.join(downloadDir, 'file2.root'), 'x');
      fs.writeFileSync(path.join(downloadDir, 'file3.root'), 'x');

      stub(configModule, 'loadConfig', () => ({
        endpoints: [DEFAULT_ENDPOINT],
        defaultEndpoint: DEFAULT_ENDPOINT.name,
        cachePath,
        configFile: '/fake/servicex.yaml',
      }));
      stubCacheRecords([{ request_id: 'r1', title: 'A', status: 'SUBMITTED' }]);
      stubServiceXApi({
        'https://default.example.org': {
          r1: fakeStatus({ requestId: 'r1', title: 'A', status: 'Running', files: 10, filesCompleted: 8 }),
        },
      });

      const provider = new CacheTreeProvider();
      const roots = (await provider.getChildren()) as TitleGroupItem[];
      const [item] = (await provider.getChildren(roots[0])) as RequestItem[];
      assert.strictEqual(item.entry.dataDir, downloadDir);
      assert.strictEqual(item.entry.downloadedFiles, 3);

      const details = await provider.getChildren(item);

      assert.ok(details.some((d) => d.label === 'Progress: ██████░░░░░░░░░░░░░░ 30% (3/10 files downloaded)'));
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true });
    }
  });

  test('lists a directory with no db.json record at all, resolving its real title/status from the backend', async () => {
    // The cancelled-transform case: the client made <cache_path>/<id> but
    // never wrote a record, so before this the directory was invisible to
    // the panel (and undeletable). The directory name IS the request id, so
    // the backend can still say what it was.
    const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-orphan-test-'));
    try {
      fs.mkdirSync(path.join(cachePath, '.servicex'), { recursive: true });
      const orphanDir = path.join(cachePath, 'cancelled-1');
      fs.mkdirSync(orphanDir, { recursive: true });
      fs.writeFileSync(path.join(orphanDir, 'partial.root'), 'x'.repeat(512));

      stub(configModule, 'loadConfig', () => ({
        endpoints: [DEFAULT_ENDPOINT],
        defaultEndpoint: DEFAULT_ENDPOINT.name,
        cachePath,
        configFile: '/fake/servicex.yaml',
      }));
      stubCacheRecords([]);
      stubServiceXApi({
        'https://default.example.org': {
          'cancelled-1': fakeStatus({ requestId: 'cancelled-1', title: 'MyQuery', status: 'Canceled' }),
        },
      });

      const provider = new CacheTreeProvider();
      const roots = (await provider.getChildren()) as TitleGroupItem[];
      const [item] = (await provider.getChildren(roots[0])) as RequestItem[];

      assert.strictEqual(item.entry.requestId, 'cancelled-1');
      assert.strictEqual(item.entry.title, 'MyQuery');
      assert.strictEqual(item.entry.status, 'Canceled');
      assert.strictEqual(item.entry.sizeBytes, 512);
      assert.strictEqual(item.entry.downloadedFiles, 1);

      // ...and its downloaded-file count comes from disk rather than from
      // the (nonexistent) record's file_list.
      const details = await provider.getChildren(item);
      assert.ok(details.some((d) => (d as RequestDetailItem).label === 'Downloaded files: 1'));
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true });
    }
  });

  test('a directory whose request the backend no longer knows still shows, marked stale', async () => {
    const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-orphan-unknown-'));
    try {
      fs.mkdirSync(path.join(cachePath, 'long-gone'), { recursive: true });

      stub(configModule, 'loadConfig', () => ({
        endpoints: [DEFAULT_ENDPOINT],
        defaultEndpoint: DEFAULT_ENDPOINT.name,
        cachePath,
        configFile: '/fake/servicex.yaml',
      }));
      stubCacheRecords([]);
      stubServiceXApi({ 'https://default.example.org': {} });

      const provider = new CacheTreeProvider();
      const roots = (await provider.getChildren()) as TitleGroupItem[];
      const [item] = (await provider.getChildren(roots[0])) as RequestItem[];

      assert.strictEqual(item.entry.requestId, 'long-gone');
      assert.strictEqual(item.entry.stale, true);
      assert.strictEqual(item.entry.status, 'Not found on any backend');
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true });
    }
  });

  test('a directory that also has a db.json record is listed once, not twice', async () => {
    const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-dedupe-test-'));
    try {
      fs.mkdirSync(path.join(cachePath, 'r1'), { recursive: true });

      stub(configModule, 'loadConfig', () => ({
        endpoints: [DEFAULT_ENDPOINT],
        defaultEndpoint: DEFAULT_ENDPOINT.name,
        cachePath,
        configFile: '/fake/servicex.yaml',
      }));
      stubCacheRecords([{ request_id: 'r1', title: 'A', status: 'COMPLETE' }]);
      stubServiceXApi({
        'https://default.example.org': { r1: fakeStatus({ requestId: 'r1', title: 'A' }) },
      });

      const provider = new CacheTreeProvider();
      const roots = (await provider.getChildren()) as TitleGroupItem[];
      const entries = (await provider.getChildren(roots[0])) as RequestItem[];

      assert.strictEqual(roots.length, 1);
      assert.strictEqual(entries.length, 1);
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true });
    }
  });

  test('surfaces a non-NotFound backend error directly instead of trying other backends', async () => {
    stubConfig([
      { name: 'primary', endpoint: 'https://primary.example.org', token: 't1' },
      { name: 'secondary', endpoint: 'https://secondary.example.org', token: 't2' },
    ]);
    stubCacheRecords([{ request_id: 'a1', title: 'A', status: 'COMPLETE' }]);
    stubServiceXApi({
      'https://primary.example.org': {
        a1: new Error('ServiceX WebAPI error 500'),
      },
      // The request also exists on the secondary - but a non-NotFound
      // failure (auth, network, server error) must surface directly, not
      // silently fall through to another backend.
      'https://secondary.example.org': {
        a1: fakeStatus({ requestId: 'a1', title: 'A' }),
      },
    });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();
    const entries = (await provider.getChildren(roots[0])) as RequestItem[];

    assert.strictEqual(entries[0].entry.stale, true);
    assert.strictEqual(entries[0].entry.status, 'Error: ServiceX WebAPI error 500');
  });

  test('refresh() forces the next getChildren() call to re-fetch', async () => {
    let fetchCount = 0;
    stubConfig();
    stubCacheRecords(() => {
      fetchCount++;
      return [];
    });

    const provider = new CacheTreeProvider();
    await provider.getChildren();
    await provider.getChildren();
    assert.strictEqual(fetchCount, 1, 'second call before refresh() should reuse cached results');

    provider.refresh();
    await provider.getChildren();
    assert.strictEqual(fetchCount, 2, 'call after refresh() should re-fetch');
  });

  test('expanding a RequestItem always resolves current data, even a stale instance from before a refresh', async () => {
    // Mutate the same backendData object between refreshes rather than
    // re-stubbing: getServiceXApi (correctly) reuses one cached instance
    // for the life of the test, so a fresh stubServiceXApi() call wouldn't
    // actually reach it.
    stubConfig();
    stubCacheRecords([{ request_id: 'r1', title: 'A', status: 'SUBMITTED', data_dir: undefined }]);
    const backendData = {
      'https://default.example.org': {
        r1: fakeStatus({ requestId: 'r1', title: 'A', status: 'Running', files: 10, filesCompleted: 2 }),
      },
    };
    stubServiceXApi(backendData);

    const provider = new CacheTreeProvider();
    const roots = (await provider.getChildren()) as TitleGroupItem[];
    const [staleItem] = (await provider.getChildren(roots[0])) as RequestItem[];
    assert.strictEqual(staleItem.entry.filesCompleted, 2);

    // Simulate the backend reporting more progress on a subsequent refresh -
    // staleItem itself is never re-constructed.
    backendData['https://default.example.org'].r1 = fakeStatus({
      requestId: 'r1',
      title: 'A',
      status: 'Running',
      files: 10,
      filesCompleted: 9,
    });
    provider.refresh();
    await provider.getChildren();

    // Expanding the SAME (stale) RequestItem object VS Code might have held
    // onto must still show the new numbers, not the ones baked into it when
    // it was first constructed.
    const details = await provider.getChildren(staleItem);
    assert.ok(
      details.some((d) => (d as RequestDetailItem).label === 'Files: Complete 9 · Failed 0 · Total 10')
    );
  });
});

suite('cacheTreeProvider.ts - CacheTreeProvider status filter', () => {
  teardown(restoreStubs);

  async function makeLoadedProvider(fetchCounter?: { count: number }): Promise<CacheTreeProvider> {
    stubConfig();
    stubCacheRecords(() => {
      if (fetchCounter) {
        fetchCounter.count++;
      }
      return [
        { request_id: 'a1', title: 'A', status: 'COMPLETE' },
        { request_id: 'b1', title: 'B', status: 'FATAL' },
      ];
    });
    stubServiceXApi({
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
    stubConfig();
    stubCacheRecords([
      { request_id: 'a1', title: 'A', status: 'COMPLETE' },
      { request_id: 'a2', title: 'A', status: 'CANCELED' },
    ]);
    stubServiceXApi({
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
  teardown(restoreStubs);

  /**
   * Three requests spread across two backends, with distinct titles, submit
   * dates, and file counts, and one with failed files - enough variety to
   * exercise every filter/sort dimension.
   */
  async function makeRichProvider(): Promise<CacheTreeProvider> {
    stubConfig([
      { name: 'uchicago', endpoint: 'https://uchicago.example.org', token: 't1' },
      { name: 'testing3', endpoint: 'https://testing3.example.org', token: 't2' },
    ]);
    stubCacheRecords([
      { request_id: 'zebra1', title: 'Zebra', status: 'COMPLETE' },
      { request_id: 'apple1', title: 'Apple', status: 'COMPLETE' },
      { request_id: 'mango1', title: 'Mango', status: 'FATAL' },
    ]);
    stubServiceXApi({
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

  test('setSort("size", ...) sorts by size on disk - summed per group when grouped, per-entry when flat', async () => {
    const dirs = [
      fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-sort-size-a1-')),
      fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-sort-size-a2-')),
      fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-sort-size-b1-')),
    ];
    try {
      // GroupA: two requests totalling 40 B (15 + 25). GroupB: one request
      // at 30 B - individually larger than either of GroupA's entries, but
      // GroupA's combined total still wins the "largest first" sort.
      fs.writeFileSync(path.join(dirs[0], 'f.root'), 'x'.repeat(15));
      fs.writeFileSync(path.join(dirs[1], 'f.root'), 'x'.repeat(25));
      fs.writeFileSync(path.join(dirs[2], 'f.root'), 'x'.repeat(30));

      stubConfig();
      stubCacheRecords([
        { request_id: 'a1', title: 'GroupA', status: 'COMPLETE', data_dir: dirs[0] },
        { request_id: 'a2', title: 'GroupA', status: 'COMPLETE', data_dir: dirs[1] },
        { request_id: 'b1', title: 'GroupB', status: 'COMPLETE', data_dir: dirs[2] },
      ]);
      stubServiceXApi({
        'https://default.example.org': {
          a1: fakeStatus({ requestId: 'a1', title: 'GroupA' }),
          a2: fakeStatus({ requestId: 'a2', title: 'GroupA' }),
          b1: fakeStatus({ requestId: 'b1', title: 'GroupB' }),
        },
      });

      const provider = new CacheTreeProvider();
      await provider.getChildren();

      provider.setSort('size', 'desc');
      const groupedRoots = (await provider.getChildren()) as TitleGroupItem[];
      assert.deepStrictEqual(groupedRoots.map((g) => g.title), ['GroupA', 'GroupB']);

      provider.setGroupingEnabled(false);
      const flatRoots = (await provider.getChildren()) as RequestItem[];
      assert.deepStrictEqual(
        flatRoots.map((r) => r.entry.requestId),
        ['b1', 'a2', 'a1']
      );
      // b1=30, a2=25, a1=15 individually - flat mode has no group to sum, so
      // this order flips relative to the grouped assertion above, which is
      // exactly the point: "size" means something different in each mode.
    } finally {
      for (const dir of dirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
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

suite('cacheTreeProvider.ts - CacheTreeProvider.updateEntry', () => {
  teardown(restoreStubs);

  test('merges the patch into the matching entry and re-renders without a fetch', async () => {
    stubConfig();
    stubServiceXApi(
      {},
      { 'https://default.example.org': [fakeStatus({ requestId: 'a1', title: 'A', status: 'Running', files: 10, filesCompleted: 2 })] }
    );
    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const [before] = (await provider.getChildren()) as RequestItem[];
    assert.strictEqual(before.entry.filesCompleted, 2);

    const updated = provider.updateEntry('a1', { filesCompleted: 7, status: 'Running' });

    assert.strictEqual(updated, true);
    const [after] = (await provider.getChildren()) as RequestItem[];
    assert.strictEqual(after.entry.filesCompleted, 7);
    // A different object each render, but the same stable id - this is
    // exactly what lets VS Code keep the row expanded across the update.
    assert.strictEqual(after.id, before.id);
  });

  test('leaves every other entry untouched', async () => {
    stubConfig();
    stubServiceXApi(
      {},
      {
        'https://default.example.org': [
          fakeStatus({ requestId: 'a1', title: 'A', filesCompleted: 1 }),
          fakeStatus({ requestId: 'b1', title: 'B', filesCompleted: 1 }),
        ],
      }
    );
    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    await provider.getChildren();

    provider.updateEntry('a1', { filesCompleted: 99 });

    const roots = (await provider.getChildren()) as RequestItem[];
    const byId = new Map(roots.map((r) => [r.entry.requestId, r.entry]));
    assert.strictEqual(byId.get('a1')?.filesCompleted, 99);
    assert.strictEqual(byId.get('b1')?.filesCompleted, 1);
  });

  test('returns false and changes nothing when the requestId is not currently loaded', async () => {
    stubConfig();
    stubServiceXApi({}, { 'https://default.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })] });
    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    await provider.getChildren();

    const updated = provider.updateEntry('does-not-exist', { filesCompleted: 5 });

    assert.strictEqual(updated, false);
  });
});

suite('cacheTreeProvider.ts - DASHBOARD_SOURCE', () => {
  teardown(restoreStubs);

  test('fetches every configured endpoint unconditionally, with no local file data', async () => {
    stubConfig([
      { name: 'alpha', endpoint: 'https://alpha.example.org', token: 't1' },
      { name: 'beta', endpoint: 'https://beta.example.org', token: 't2' },
    ]);
    stubServiceXApi(
      {},
      {
        'https://alpha.example.org': [fakeStatus({ requestId: 'a1', title: 'A', status: 'Complete' })],
        'https://beta.example.org': [fakeStatus({ requestId: 'b1', title: 'B', status: 'Running' })],
      }
    );

    const { entries, backends } = await DASHBOARD_SOURCE.fetchEntries();

    assert.strictEqual(entries.length, 2);
    const byId = new Map(entries.map((e) => [e.requestId, e]));
    assert.strictEqual(byId.get('a1')?.backend, 'alpha');
    assert.strictEqual(byId.get('b1')?.backend, 'beta');
    // No local db.json involved - none of these fields can be populated.
    assert.strictEqual(byId.get('a1')?.fileList, undefined);
    assert.strictEqual(byId.get('a1')?.dataDir, undefined);
    assert.strictEqual(byId.get('a1')?.sizeBytes, 0);
    // Every configured backend is reported, with no error - drives the
    // BackendGroupItem tabs regardless of which ones actually had entries.
    assert.deepStrictEqual(backends, [
      { name: 'alpha', error: undefined },
      { name: 'beta', error: undefined },
    ]);
  });

  test('warns about a failed backend, still returns the others, and reports its error for the tab', async () => {
    stubConfig([
      { name: 'alpha', endpoint: 'https://alpha.example.org', token: 't1' },
      { name: 'beta', endpoint: 'https://beta.example.org', token: 't2' },
    ]);
    stubServiceXApi(
      {},
      {
        'https://alpha.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })],
        'https://beta.example.org': new Error('backend unreachable'),
      }
    );
    let warning: string | undefined;
    stub(vscode.window, 'showWarningMessage', (msg: string) => {
      warning = msg;
      return Promise.resolve(undefined);
    });

    const { entries, backends } = await DASHBOARD_SOURCE.fetchEntries();

    assert.deepStrictEqual(entries.map((e) => e.requestId), ['a1']);
    assert.ok(warning?.includes('beta'));
    assert.ok(warning?.includes('backend unreachable'));
    assert.deepStrictEqual(backends, [
      { name: 'alpha', error: undefined },
      { name: 'beta', error: 'backend unreachable' },
    ]);
  });

  test('caps each backend independently at its 30 most recent transforms', async () => {
    stubConfig([
      { name: 'busy', endpoint: 'https://busy.example.org', token: 't1' },
      { name: 'quiet', endpoint: 'https://quiet.example.org', token: 't2' },
    ]);
    const busyStatuses = Array.from({ length: 50 }, (_, i) =>
      fakeStatus({ requestId: `busy-${i}`, title: `T${i}`, submitTime: new Date(i * 1000) })
    );
    stubServiceXApi(
      {},
      {
        'https://busy.example.org': busyStatuses,
        'https://quiet.example.org': [fakeStatus({ requestId: 'quiet-1', title: 'Q', submitTime: new Date(0) })],
      }
    );

    const { entries } = await DASHBOARD_SOURCE.fetchEntries();

    const busyEntries = entries.filter((e) => e.backend === 'busy');
    const quietEntries = entries.filter((e) => e.backend === 'quiet');
    assert.strictEqual(busyEntries.length, 30);
    assert.strictEqual(quietEntries.length, 1, "a quiet backend's small result set must not be squeezed out");
    // The kept 30 must be the most recently submitted ones, not the first 30 returned.
    assert.deepStrictEqual(
      busyEntries.map((e) => e.requestId).sort(),
      busyStatuses
        .slice(20)
        .map((s) => s.requestId)
        .sort()
    );
  });

  test('a dashboard provider defaults to ungrouped, unlike the cache panel', async () => {
    stubConfig();
    stubServiceXApi({}, { 'https://default.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })] });

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const roots = await provider.getChildren();

    assert.ok(roots[0] instanceof RequestItem);
    assert.strictEqual((roots[0] as RequestItem).contextValue, 'servicexDashboardRequest');
  });

  test('provider built with DASHBOARD_SOURCE stamps dashboard contextValues once grouped', async () => {
    stubConfig();
    stubServiceXApi({}, { 'https://default.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })] });

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    provider.setGroupingEnabled(true);
    const roots = await provider.getChildren();

    assert.ok(roots[0] instanceof TitleGroupItem);
    assert.strictEqual((roots[0] as TitleGroupItem).contextValue, 'servicexDashboardTitleGroup');
    const children = (await provider.getChildren(roots[0])) as RequestItem[];
    assert.strictEqual(children[0].contextValue, 'servicexDashboardRequest');
  });

  test('provider built with DASHBOARD_SOURCE shows the dashboard-specific empty message', async () => {
    stubConfig();
    stubServiceXApi({}, {});

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const roots = await provider.getChildren();

    assert.strictEqual(roots.length, 1);
    assert.strictEqual((roots[0] as MessageItem).label, 'No transforms found on the dashboard.');
  });

  test('splits into one BackendGroupItem tab per backend once more than one has entries', async () => {
    stubConfig([
      { name: 'alpha', endpoint: 'https://alpha.example.org', token: 't1' },
      { name: 'beta', endpoint: 'https://beta.example.org', token: 't2' },
    ]);
    stubServiceXApi(
      {},
      {
        'https://alpha.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })],
        'https://beta.example.org': [fakeStatus({ requestId: 'b1', title: 'B' })],
      }
    );

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const roots = await provider.getChildren();

    assert.strictEqual(roots.length, 2);
    assert.ok(roots.every((r) => r instanceof BackendGroupItem));
    assert.deepStrictEqual(
      (roots as BackendGroupItem[]).map((r) => r.backend).sort(),
      ['alpha', 'beta']
    );

    // Ungrouped by default (see the dedicated grouping-default test) - each
    // tab's own children are flat RequestItems, not further title-grouped.
    const alphaTab = (roots as BackendGroupItem[]).find((r) => r.backend === 'alpha')!;
    const alphaChildren = (await provider.getChildren(alphaTab)) as RequestItem[];
    assert.strictEqual(alphaChildren.length, 1);
    assert.ok(alphaChildren[0] instanceof RequestItem);
    assert.strictEqual(alphaChildren[0].entry.requestId, 'a1');
  });

  test('does not tab a single configured backend, even though groupByBackend is set', async () => {
    stubConfig();
    stubServiceXApi({}, { 'https://default.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })] });

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const roots = await provider.getChildren();

    assert.ok(roots.every((r) => !(r instanceof BackendGroupItem)));
  });

  test('a backend with zero transforms still gets its own tab, showing an empty state', async () => {
    stubConfig([
      { name: 'uchicago', endpoint: 'https://uchicago.example.org', token: 't1' },
      { name: 'af-af', endpoint: 'https://af-af.example.org', token: 't2' },
    ]);
    stubServiceXApi(
      {},
      {
        'https://uchicago.example.org': [],
        'https://af-af.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })],
      }
    );

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const roots = (await provider.getChildren()) as BackendGroupItem[];

    assert.strictEqual(roots.length, 2);
    const uchicagoTab = roots.find((r) => r.backend === 'uchicago')!;
    assert.strictEqual(uchicagoTab.error, undefined);
    const uchicagoChildren = await provider.getChildren(uchicagoTab);
    assert.strictEqual(uchicagoChildren.length, 1);
    assert.ok(uchicagoChildren[0] instanceof MessageItem);
    assert.strictEqual((uchicagoChildren[0] as MessageItem).label, 'No transforms found on uchicago.');
  });

  test('a backend that failed to load still gets its own tab, showing the actual error', async () => {
    stubConfig([
      { name: 'uchicago', endpoint: 'https://uchicago.example.org', token: 't1' },
      { name: 'af-af', endpoint: 'https://af-af.example.org', token: 't2' },
    ]);
    stubServiceXApi(
      {},
      {
        'https://uchicago.example.org': new Error('ServiceX WebAPI error 401'),
        'https://af-af.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })],
      }
    );
    stub(vscode.window, 'showWarningMessage', () => Promise.resolve(undefined));

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const roots = (await provider.getChildren()) as BackendGroupItem[];

    assert.strictEqual(roots.length, 2);
    const uchicagoTab = roots.find((r) => r.backend === 'uchicago')!;
    assert.strictEqual(uchicagoTab.error, 'ServiceX WebAPI error 401');
    assert.strictEqual(uchicagoTab.description, 'Error loading transforms');
    assert.strictEqual(uchicagoTab.tooltip, 'ServiceX WebAPI error 401');
    assert.strictEqual((uchicagoTab.iconPath as vscode.ThemeIcon).id, 'error');

    const uchicagoChildren = await provider.getChildren(uchicagoTab);
    assert.strictEqual(uchicagoChildren.length, 1);
    assert.ok(uchicagoChildren[0] instanceof MessageItem);
    assert.strictEqual((uchicagoChildren[0] as MessageItem).label, 'ServiceX WebAPI error 401');
  });

  test('the cache-panel default source never tabs by backend, even with a fallback in play', async () => {
    stubConfig([
      { name: 'primary', endpoint: 'https://primary.example.org', token: 't1' },
      { name: 'secondary', endpoint: 'https://secondary.example.org', token: 't2' },
    ]);
    stubCacheRecords([
      { request_id: 'on-primary', title: 'OnPrimary', status: 'COMPLETE' },
      { request_id: 'on-secondary', title: 'OnSecondary', status: 'COMPLETE' },
    ]);
    stubServiceXApi({
      'https://primary.example.org': {
        'on-primary': fakeStatus({ requestId: 'on-primary', title: 'OnPrimary' }),
      },
      'https://secondary.example.org': {
        'on-secondary': fakeStatus({ requestId: 'on-secondary', title: 'OnSecondary' }),
      },
    });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();

    assert.ok(roots.every((r) => !(r instanceof BackendGroupItem)));
  });

  test('a running dashboard entry gets the running contextValue; a terminal one does not', async () => {
    stubConfig();
    stubServiceXApi(
      {},
      {
        'https://default.example.org': [
          fakeStatus({ requestId: 'running-1', title: 'A', status: 'Running' }),
          fakeStatus({ requestId: 'done-1', title: 'B', status: 'Complete' }),
        ],
      }
    );

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const roots = (await provider.getChildren()) as RequestItem[];

    const byId = new Map(roots.map((r) => [r.entry.requestId, r]));
    assert.strictEqual(byId.get('running-1')?.contextValue, 'servicexDashboardRequest-running');
    assert.strictEqual(byId.get('done-1')?.contextValue, 'servicexDashboardRequest');
  });

  test('the cache panel never uses a running contextValue, even for a Running entry', async () => {
    stubConfig();
    stubCacheRecords([{ request_id: 'r1', title: 'A', status: 'SUBMITTED' }]);
    stubServiceXApi({
      'https://default.example.org': { r1: fakeStatus({ requestId: 'r1', title: 'A', status: 'Running' }) },
    });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();
    const [entry] = (await provider.getChildren(roots[0])) as RequestItem[];

    assert.strictEqual(entry.contextValue, 'servicexCacheRequest');
  });

  test('expanding a dashboard entry fetches and appends its current size', async () => {
    stubConfig();
    stubServiceXApi(
      {},
      { 'https://default.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })] },
      { sizeByRequestId: { a1: 2048 } }
    );

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const [root] = (await provider.getChildren()) as RequestItem[];
    const details = await provider.getChildren(root);

    assert.ok(details.some((d) => (d as RequestDetailItem).label === 'Size: 2.0 KB'));
  });

  test('a terminal entry\'s size is memoized - re-expanding it never refetches', async () => {
    stubConfig();
    stubServiceXApi(
      {},
      { 'https://default.example.org': [fakeStatus({ requestId: 'a1', title: 'A', status: 'Complete' })] },
      { sizeByRequestId: { a1: 2048 } }
    );

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const [root] = (await provider.getChildren()) as RequestItem[];
    const firstDetails = await provider.getChildren(root);
    assert.ok(firstDetails.some((d) => (d as RequestDetailItem).label === 'Size: 2.0 KB'));

    // Re-stub with a different size (and no config at all, so a live fetch
    // would fail outright) - a genuinely cached value must still win.
    stubServiceXApi({}, {}, { sizeByRequestId: { a1: 999999 } });
    const secondDetails = await provider.getChildren(root);

    assert.ok(secondDetails.some((d) => (d as RequestDetailItem).label === 'Size: 2.0 KB'));
    assert.ok(!secondDetails.some((d) => (d as RequestDetailItem).label?.toString().includes('999999')));
  });

  test('a non-terminal entry\'s size is never memoized - re-expanding it refetches every time', async () => {
    // Mutate the same options object between expansions rather than
    // re-stubbing: getServiceXApi (correctly) reuses one cached instance
    // for the life of the test, so a fresh stubServiceXApi() call wouldn't
    // actually reach it - this is exactly why the size fetch itself must be
    // what changes on the second expand, not the underlying fake.
    stubConfig();
    const options: StubServiceXApiOptions = { sizeByRequestId: { a1: 100 } };
    stubServiceXApi(
      {},
      { 'https://default.example.org': [fakeStatus({ requestId: 'a1', title: 'A', status: 'Running' })] },
      options
    );

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const [root] = (await provider.getChildren()) as RequestItem[];
    const firstDetails = await provider.getChildren(root);
    assert.ok(firstDetails.some((d) => (d as RequestDetailItem).label === 'Size: 100 B'));

    options.sizeByRequestId = { a1: 200 };
    const secondDetails = await provider.getChildren(root);

    assert.ok(secondDetails.some((d) => (d as RequestDetailItem).label === 'Size: 200 B'));
  });

  test('expanding a dashboard entry omits the size row when the backend has no capability for it', async () => {
    stubConfig();
    stubServiceXApi({}, { 'https://default.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })] });

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const [root] = (await provider.getChildren()) as RequestItem[];
    const details = await provider.getChildren(root);

    assert.ok(!details.some((d) => (d as RequestDetailItem).label?.toString().startsWith('Size:')));
  });

  test('expanding a dashboard entry omits the size row (rather than erroring) when the size fetch fails', async () => {
    stubConfig();
    stubServiceXApi(
      {},
      { 'https://default.example.org': [fakeStatus({ requestId: 'a1', title: 'A' })] },
      { sizeByRequestId: { a1: new Error('boom') } }
    );

    const provider = new CacheTreeProvider(DASHBOARD_SOURCE);
    const [root] = (await provider.getChildren()) as RequestItem[];
    const details = await provider.getChildren(root);

    assert.ok(!details.some((d) => (d as RequestDetailItem).label?.toString().startsWith('Size:')));
  });

  test('expanding a cache-panel entry never fetches size (no fetchTransformSize on that source)', async () => {
    stubConfig();
    stubCacheRecords([{ request_id: 'a1', title: 'A', status: 'COMPLETE' }]);
    stubServiceXApi({
      'https://default.example.org': { a1: fakeStatus({ requestId: 'a1', title: 'A' }) },
    });

    const provider = new CacheTreeProvider();
    const roots = await provider.getChildren();
    const [entry] = (await provider.getChildren(roots[0])) as RequestItem[];
    const details = await provider.getChildren(entry);

    assert.ok(!details.some((d) => (d as RequestDetailItem).label?.toString().startsWith('Size:')));
  });
});

suite('cacheTreeProvider.ts - getServiceXApi', () => {
  teardown(clearServiceXApiCache);

  test('returns the same instance for the same endpoint and token', () => {
    const endpoint = { name: 'a', endpoint: 'https://a.example.org', token: 't1' };

    const first = getServiceXApi(endpoint);
    const second = getServiceXApi({ ...endpoint });

    assert.strictEqual(first, second);
  });

  test('returns a different instance for a different token on the same endpoint', () => {
    const first = getServiceXApi({ name: 'a', endpoint: 'https://a.example.org', token: 't1' });
    const second = getServiceXApi({ name: 'a', endpoint: 'https://a.example.org', token: 't2' });

    assert.notStrictEqual(first, second);
  });

  test('returns a different instance for a different endpoint URL', () => {
    const first = getServiceXApi({ name: 'a', endpoint: 'https://a.example.org', token: 't1' });
    const second = getServiceXApi({ name: 'b', endpoint: 'https://b.example.org', token: 't1' });

    assert.notStrictEqual(first, second);
  });

  test('clearServiceXApiCache forces a fresh instance on the next call', () => {
    const endpoint = { name: 'a', endpoint: 'https://a.example.org', token: 't1' };
    const first = getServiceXApi(endpoint);

    clearServiceXApiCache();
    const second = getServiceXApi(endpoint);

    assert.notStrictEqual(first, second);
  });
});
