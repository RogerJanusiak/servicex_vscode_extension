import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readCacheRecords,
  completedRecords,
  submittedRecords,
  deleteCacheRecord,
  deleteAllForTitle,
  directorySize,
  directoryStats,
} from '../cacheDb';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-cachedb-test-'));
}

/** Builds a cache_path with a .servicex/db.json matching the real TinyDB
 *  on-disk shape, plus a real directory+file per completed record so
 *  deletion can be verified against actual filesystem state. */
function buildFixture(
  cachePath: string,
  records: Record<string, Record<string, unknown>>
): void {
  fs.mkdirSync(path.join(cachePath, '.servicex'), { recursive: true });
  for (const rec of Object.values(records)) {
    if (rec.data_dir) {
      fs.mkdirSync(rec.data_dir as string, { recursive: true });
      fs.writeFileSync(path.join(rec.data_dir as string, 'file.root'), 'dummy');
    }
  }
  fs.writeFileSync(
    path.join(cachePath, '.servicex', 'db.json'),
    JSON.stringify({ _default: records })
  );
}

suite('cacheDb.ts', () => {
  let root: string;
  let cachePath: string;

  setup(() => {
    root = mkTmpDir();
    cachePath = path.join(root, 'cache');
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('readCacheRecords returns [] when there is no db.json yet', () => {
    assert.deepStrictEqual(readCacheRecords(cachePath), { records: [], corrupted: 0 });
  });

  test('readCacheRecords reads every record out of the default table', () => {
    buildFixture(cachePath, {
      '1': { request_id: 'a', title: 'A', status: 'COMPLETE' },
      '2': { request_id: 'b', title: 'B', status: 'SUBMITTED' },
    });

    const { records, corrupted } = readCacheRecords(cachePath);

    assert.strictEqual(corrupted, 0);
    assert.strictEqual(records.length, 2);
    assert.deepStrictEqual(
      records.map((r) => r.request_id).sort(),
      ['a', 'b']
    );
  });

  test('readCacheRecords recovers the intact records when db.json is truncated mid-write', () => {
    fs.mkdirSync(path.join(cachePath, '.servicex'), { recursive: true });
    const full = JSON.stringify({
      _default: {
        '1': { request_id: 'a', title: 'A', status: 'COMPLETE' },
        '2': { request_id: 'b', title: 'B', status: 'COMPLETE' },
        '3': { request_id: 'c', title: 'C', status: 'COMPLETE' },
      },
    });
    // Simulate a process killed partway through writing the last record.
    const cut = full.slice(0, full.lastIndexOf('"c"') + 3);
    fs.writeFileSync(path.join(cachePath, '.servicex', 'db.json'), cut);

    const { records, corrupted } = readCacheRecords(cachePath);

    assert.strictEqual(corrupted, 1);
    assert.deepStrictEqual(
      records.map((r) => r.request_id).sort(),
      ['a', 'b']
    );
  });

  test('readCacheRecords returns everything recoverable even when nothing is fully intact', () => {
    fs.mkdirSync(path.join(cachePath, '.servicex'), { recursive: true });
    fs.writeFileSync(path.join(cachePath, '.servicex', 'db.json'), '{"_default": {"1": {"request');

    const { records, corrupted } = readCacheRecords(cachePath);

    assert.deepStrictEqual(records, []);
    assert.strictEqual(corrupted, 1);
  });

  test('readCacheRecords treats an empty db.json as an empty cache, not corruption', () => {
    fs.mkdirSync(path.join(cachePath, '.servicex'), { recursive: true });
    fs.writeFileSync(path.join(cachePath, '.servicex', 'db.json'), '');

    assert.deepStrictEqual(readCacheRecords(cachePath), { records: [], corrupted: 0 });
  });

  test('completedRecords excludes SUBMITTED records', () => {
    const records = [
      { request_id: 'a', status: 'COMPLETE' },
      { request_id: 'b', status: 'SUBMITTED' },
      { request_id: 'c', status: 'CANCELED' },
    ];

    assert.deepStrictEqual(
      completedRecords(records).map((r) => r.request_id),
      ['a', 'c']
    );
  });

  test('submittedRecords includes only SUBMITTED records', () => {
    const records = [
      { request_id: 'a', status: 'COMPLETE' },
      { request_id: 'b', status: 'SUBMITTED' },
    ];

    assert.deepStrictEqual(
      submittedRecords(records).map((r) => r.request_id),
      ['b']
    );
  });

  test('deleteCacheRecord removes the matching directory and db record, leaves others alone', () => {
    const dirA = path.join(cachePath, 'req-a');
    const dirB = path.join(cachePath, 'req-b');
    buildFixture(cachePath, {
      '1': { request_id: 'req-a', title: 'A', status: 'COMPLETE', data_dir: dirA },
      '2': { request_id: 'req-b', title: 'B', status: 'COMPLETE', data_dir: dirB },
    });

    const deleted = deleteCacheRecord(cachePath, 'req-a');

    assert.strictEqual(deleted, true);
    assert.strictEqual(fs.existsSync(dirA), false);
    assert.strictEqual(fs.existsSync(dirB), true);

    const remaining = readCacheRecords(cachePath).records;
    assert.deepStrictEqual(
      remaining.map((r) => r.request_id),
      ['req-b']
    );
  });

  test('deleteCacheRecord handles a SUBMITTED record with no data_dir gracefully', () => {
    buildFixture(cachePath, {
      '1': { request_id: 'req-a', title: 'A', status: 'SUBMITTED' },
    });

    const deleted = deleteCacheRecord(cachePath, 'req-a');

    assert.strictEqual(deleted, true);
    assert.deepStrictEqual(readCacheRecords(cachePath), { records: [], corrupted: 0 });
  });

  test('deleteCacheRecord returns false when the request is not cached', () => {
    buildFixture(cachePath, {
      '1': { request_id: 'req-a', title: 'A', status: 'COMPLETE' },
    });

    assert.strictEqual(deleteCacheRecord(cachePath, 'does-not-exist'), false);
  });

  test('deleteCacheRecord returns false when there is no db.json at all', () => {
    assert.strictEqual(deleteCacheRecord(cachePath, 'anything'), false);
  });

  test('deleteAllForTitle removes every record under a title, completed or submitted, leaves other titles', () => {
    const dirOld = path.join(cachePath, 'old');
    const dirNew = path.join(cachePath, 'new');
    const dirOther = path.join(cachePath, 'other');
    buildFixture(cachePath, {
      '1': { request_id: 'old', title: 'GroupA', status: 'COMPLETE', data_dir: dirOld },
      '2': { request_id: 'new', title: 'GroupA', status: 'COMPLETE', data_dir: dirNew },
      '3': { request_id: 'submitted', title: 'GroupA', status: 'SUBMITTED' },
      '4': { request_id: 'other', title: 'GroupB', status: 'COMPLETE', data_dir: dirOther },
    });

    const count = deleteAllForTitle(cachePath, 'GroupA');

    assert.strictEqual(count, 3);
    assert.strictEqual(fs.existsSync(dirOld), false);
    assert.strictEqual(fs.existsSync(dirNew), false);
    assert.strictEqual(fs.existsSync(dirOther), true);

    const remaining = readCacheRecords(cachePath).records;
    assert.deepStrictEqual(
      remaining.map((r) => r.request_id),
      ['other']
    );
  });

  test('directorySize returns 0 for a path that does not exist', () => {
    assert.strictEqual(directorySize(path.join(cachePath, 'nope')), 0);
  });

  test('directorySize returns 0 for an empty directory', () => {
    fs.mkdirSync(cachePath, { recursive: true });
    assert.strictEqual(directorySize(cachePath), 0);
  });

  test('directorySize sums file sizes in a flat directory', () => {
    fs.mkdirSync(cachePath, { recursive: true });
    fs.writeFileSync(path.join(cachePath, 'a.root'), 'x'.repeat(100));
    fs.writeFileSync(path.join(cachePath, 'b.root'), 'x'.repeat(250));

    assert.strictEqual(directorySize(cachePath), 350);
  });

  test('directorySize recurses into nested subdirectories', () => {
    const nested = path.join(cachePath, 'req-1', 'sub');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(cachePath, 'top.root'), 'x'.repeat(10));
    fs.writeFileSync(path.join(cachePath, 'req-1', 'mid.root'), 'x'.repeat(20));
    fs.writeFileSync(path.join(nested, 'deep.root'), 'x'.repeat(30));

    assert.strictEqual(directorySize(cachePath), 60);
  });

  test('directoryStats returns {0, 0} for a path that does not exist', () => {
    assert.deepStrictEqual(directoryStats(path.join(cachePath, 'nope')), { sizeBytes: 0, fileCount: 0 });
  });

  test('directoryStats counts files and sums their size in one walk, including nested subdirectories', () => {
    const nested = path.join(cachePath, 'req-1', 'sub');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(cachePath, 'top.root'), 'x'.repeat(10));
    fs.writeFileSync(path.join(cachePath, 'req-1', 'mid.root'), 'x'.repeat(20));
    fs.writeFileSync(path.join(nested, 'deep.root'), 'x'.repeat(30));

    assert.deepStrictEqual(directoryStats(cachePath), { sizeBytes: 60, fileCount: 3 });
  });
});
