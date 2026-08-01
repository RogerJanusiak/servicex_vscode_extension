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
 * Every per-request directory the servicex client has created under
 * `cachePath`, by request id. The client mkdirs `<cache_path>/<request_id>`
 * as soon as it first polls a transform's status, but only writes a db.json
 * record once the whole download finishes - so a cancelled or failed
 * transform leaves a directory here with no record at all. Listing the
 * directory itself is the only way to see (and clean up) those.
 */
export function listCacheDirectories(cachePath: string): string[] {
  try {
    return fs
      .readdirSync(cachePath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '.servicex')
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Delete one request's downloaded files and its db.json record. Mirrors
 * ServiceXClient.delete_transform_from_cache in the Python client: looks the
 * record up by request_id and removes its data_dir from disk, then removes
 * the db.json entry.
 *
 * Also removes `<cachePath>/<requestId>` - the path the client derives when
 * it creates the download directory - so this cleans up a request whose
 * record never recorded a data_dir (still SUBMITTED) or has no record at all
 * (cancelled/failed, where the directory would otherwise be stranded with no
 * way to delete it). Returns whether anything was actually removed.
 */
export function deleteCacheRecord(cachePath: string, requestId: string): boolean {
  const dbPath = path.join(cachePath, '.servicex', 'db.json');
  const dataDirs = new Set<string>([path.join(cachePath, requestId)]);
  let found = false;

  if (fs.existsSync(dbPath)) {
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const table = raw['_default'] ?? {};
    for (const key of Object.keys(table)) {
      if (table[key]?.request_id === requestId) {
        if (typeof table[key].data_dir === 'string') {
          dataDirs.add(table[key].data_dir);
        }
        delete table[key];
        found = true;
      }
    }
    if (found) {
      raw['_default'] = table;
      fs.writeFileSync(dbPath, JSON.stringify(raw));
    }
  }

  for (const dir of dataDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      found = true;
    }
  }
  return found;
}

/**
 * Every regular file under `dirPath`, recursively, as paths relative to it -
 * what's actually been downloaded for a request, read from disk rather than
 * from the db.json record's file_list (which doesn't exist at all for a
 * still-running request, or for a cancelled one whose record is gone).
 * Sorted for a stable display order; empty for a path that doesn't exist.
 */
export function listDirectoryFiles(dirPath: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listDirectoryFiles(path.join(dirPath, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

export interface DirectoryStats {
  sizeBytes: number;
  fileCount: number;
}

/**
 * Total size and file count of every regular file under `dirPath`,
 * recursively, in a single walk - used wherever both numbers are wanted
 * (e.g. a cache entry's "downloaded so far" progress needs both) so nothing
 * has to walk the same directory tree twice. Both are 0 for a path that
 * doesn't exist (e.g. a SUBMITTED request with no data_dir yet, or a cache
 * directory that hasn't been created). Skips entries that vanish mid-walk
 * (e.g. a concurrent delete) rather than throwing.
 */
export function directoryStats(dirPath: string): DirectoryStats {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return { sizeBytes: 0, fileCount: 0 };
  }

  let sizeBytes = 0;
  let fileCount = 0;
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = directoryStats(fullPath);
      sizeBytes += nested.sizeBytes;
      fileCount += nested.fileCount;
    } else if (entry.isFile()) {
      fileCount++;
      try {
        sizeBytes += fs.statSync(fullPath).size;
      } catch {
        // Raced with a concurrent delete - just skip it.
      }
    }
  }
  return { sizeBytes, fileCount };
}

/** Total size in bytes of every regular file under `dirPath` - see directoryStats(). */
export function directorySize(dirPath: string): number {
  return directoryStats(dirPath).sizeBytes;
}
