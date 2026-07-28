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
