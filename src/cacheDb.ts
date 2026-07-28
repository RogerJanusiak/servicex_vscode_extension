import * as fs from 'fs';
import * as path from 'path';

export interface CacheDbRecord {
  hash?: string;
  title?: string;
  request_id?: string;
  status?: string;
  submit_time?: string;
  [key: string]: unknown;
}

/**
 * Reads the local TinyDB cache the servicex Python client maintains at
 * <cache_path>/.servicex/db.json. TinyDB stores one JSON object per table
 * (we only ever use the default table), keyed by numeric doc id.
 */
export function readCacheRecords(cachePath: string): CacheDbRecord[] {
  const dbPath = path.join(cachePath, '.servicex', 'db.json');
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const table = raw['_default'] ?? {};
  return Object.values(table) as CacheDbRecord[];
}

/** Records for requests that have finished downloading (mirrors QueryCache.cached_queries). */
export function completedRecords(records: CacheDbRecord[]): CacheDbRecord[] {
  return records.filter((r) => r.request_id && r.status !== 'SUBMITTED');
}

/** Records still awaiting download (mirrors QueryCache.queries_in_state("SUBMITTED")). */
export function submittedRecords(records: CacheDbRecord[]): CacheDbRecord[] {
  return records.filter((r) => r.request_id && r.status === 'SUBMITTED');
}

/**
 * Delete one request's downloaded files and its db.json record. Mirrors
 * ServiceXClient.delete_transform_from_cache in the Python client: looks the
 * record up by request_id, removes its data_dir from disk (if any - a still-
 * SUBMITTED record has none), then removes the db.json entry. Returns
 * whether a matching record was actually found and removed.
 */
export function deleteCacheRecord(cachePath: string, requestId: string): boolean {
  const dbPath = path.join(cachePath, '.servicex', 'db.json');
  if (!fs.existsSync(dbPath)) {
    return false;
  }

  const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const table = raw['_default'] ?? {};

  let dataDir: string | undefined;
  let found = false;
  for (const key of Object.keys(table)) {
    if (table[key]?.request_id === requestId) {
      dataDir = table[key].data_dir as string | undefined;
      delete table[key];
      found = true;
    }
  }
  if (!found) {
    return false;
  }

  raw['_default'] = table;
  fs.writeFileSync(dbPath, JSON.stringify(raw));
  if (dataDir) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return true;
}

/**
 * Delete every locally cached request with the given title, completed or
 * still SUBMITTED - i.e. the entire group as shown in the tree.
 */
export function deleteAllForTitle(cachePath: string, title: string): number {
  const matches = readCacheRecords(cachePath).filter((r) => r.request_id && r.title === title);
  let count = 0;
  for (const r of matches) {
    if (r.request_id && deleteCacheRecord(cachePath, r.request_id)) {
      count++;
    }
  }
  return count;
}
