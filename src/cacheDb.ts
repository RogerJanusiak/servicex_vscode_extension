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

export interface ReadCacheRecordsResult {
  records: CacheDbRecord[];
  /** Number of entries in the default table that couldn't be read and were
   *  skipped - always 0 unless db.json is corrupted. */
  corrupted: number;
}

/**
 * Reads the local TinyDB cache the servicex Python client maintains at
 * <cache_path>/.servicex/db.json. TinyDB stores one JSON object per table
 * (we only ever use the default table), keyed by numeric doc id.
 *
 * db.json is rewritten wholesale on every change, so a process killed
 * mid-write (or a full disk) can leave it truncated. Rather than losing
 * every cached request over one bad write, a parse failure falls back to
 * recovering whatever complete entries it can and reports the rest as
 * corrupted instead of throwing.
 */
export function readCacheRecords(cachePath: string): ReadCacheRecordsResult {
  const dbPath = path.join(cachePath, '.servicex', 'db.json');
  if (!fs.existsSync(dbPath)) {
    return { records: [], corrupted: 0 };
  }

  const text = fs.readFileSync(dbPath, 'utf8');
  if (text.trim() === '') {
    // A fresh cache the servicex Python client hasn't written to yet - not
    // corruption, nothing was ever there to lose.
    return { records: [], corrupted: 0 };
  }
  try {
    const raw = JSON.parse(text);
    const table = raw['_default'] ?? {};
    return { records: Object.values(table) as CacheDbRecord[], corrupted: 0 };
  } catch {
    return recoverDbRecords(text);
  }
}

/**
 * Best-effort recovery for a db.json that failed to parse as a whole. Walks
 * the raw text of the "_default" table by bracket/brace depth (ignoring
 * braces inside strings) so each top-level record can be sliced out and
 * parsed on its own; a record that's incomplete or otherwise unparseable is
 * dropped and counted rather than failing the whole file.
 */
function recoverDbRecords(text: string): ReadCacheRecordsResult {
  const marker = '"_default"';
  const markerIdx = text.indexOf(marker);
  const objStart = markerIdx === -1 ? -1 : text.indexOf('{', markerIdx + marker.length);
  if (objStart === -1) {
    return { records: [], corrupted: 1 };
  }

  const { entries, closed } = splitDbEntries(text, objStart);
  const records: CacheDbRecord[] = [];
  let corrupted = closed ? 0 : 1;
  for (const entryText of entries) {
    try {
      records.push(JSON.parse(entryText) as CacheDbRecord);
    } catch {
      corrupted++;
    }
  }
  return { records, corrupted };
}

/**
 * Scans a `{...}` object's raw text starting at `objStart` (the position of
 * its opening brace) and slices out the text of each top-level value, e.g.
 * given `{"1": {...}, "2": {...}}` returns the two `{...}` value snippets.
 * Depth tracking means a record's own nested objects/arrays don't confuse
 * the boundary detection. `closed` is false when the text ends before the
 * object's matching closing brace is reached (i.e. it was truncated).
 */
function splitDbEntries(text: string, objStart: number): { entries: string[]; closed: boolean } {
  const entries: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let entryStart = -1;

  for (let i = objStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (depth === 1 && entryStart === -1) {
        entryStart = i;
      }
      depth++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return { entries, closed: true };
      }
      if (depth === 1 && entryStart !== -1) {
        entries.push(text.slice(entryStart, i + 1));
        entryStart = -1;
      }
    }
  }
  return { entries, closed: false };
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
  const matches = readCacheRecords(cachePath).records.filter((r) => r.request_id && r.title === title);
  let count = 0;
  for (const r of matches) {
    if (r.request_id && deleteCacheRecord(cachePath, r.request_id)) {
      count++;
    }
  }
  return count;
}

/**
 * Total size in bytes of every regular file under `dirPath`, recursively.
 * Returns 0 for a path that doesn't exist (e.g. a SUBMITTED request with no
 * data_dir yet, or a cache directory that hasn't been created). Skips
 * entries that vanish mid-walk (e.g. a concurrent delete) rather than
 * throwing.
 */
export function directorySize(dirPath: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(fullPath);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(fullPath).size;
      } catch {
        // Raced with a concurrent delete - just skip it.
      }
    }
  }
  return total;
}
