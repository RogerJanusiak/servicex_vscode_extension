import * as configModule from '../config';
import * as cacheDbModule from '../cacheDb';
import * as serviceXApiModule from '../serviceXApi';
import { NotFoundError, TransformStatus } from '../serviceXApi';
import { CacheEntry } from '../cacheTreeProvider';
import { CacheDbRecord } from '../cacheDb';
import { EndpointConfig } from '../config';

// ---------------------------------------------------------------------------
// Generic stub/restore
//
// Tests fake module exports (loadConfig, readCacheRecords, ServiceXApi, the
// vscode.window prompts) by assigning over them. Tracking every original by
// hand in each suite is error-prone - the missing-loadConfig-mock CI failure
// came from exactly that. stub() records the original once; restoreStubs()
// puts everything back in reverse order (so re-stubbing the same key within
// one test still unwinds correctly). Call restoreStubs() from teardown().
// ---------------------------------------------------------------------------

const activeStubs: { obj: Record<string, unknown>; key: string; original: unknown }[] = [];

export function stub<T extends object, K extends keyof T & string>(obj: T, key: K, value: unknown): void {
  const record = obj as Record<string, unknown>;
  activeStubs.push({ obj: record, key, original: record[key] });
  record[key] = value;
}

export function restoreStubs(): void {
  while (activeStubs.length) {
    const s = activeStubs.pop()!;
    s.obj[s.key] = s.original;
  }
}

// ---------------------------------------------------------------------------
// Shared factories
// ---------------------------------------------------------------------------

export function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    requestId: 'req',
    title: 'Title',
    status: 'Complete',
    files: 1,
    filesCompleted: 1,
    filesFailed: 0,
    stale: false,
    sizeBytes: 0,
    ...overrides,
  };
}

export function fakeStatus(overrides: Partial<TransformStatus> = {}): TransformStatus {
  return {
    requestId: 'req',
    status: 'Complete',
    files: 1,
    filesCompleted: 1,
    filesFailed: 0,
    ...overrides,
  };
}

export const DEFAULT_ENDPOINT = { name: 'default', endpoint: 'https://default.example.org', token: 't' };

/** Stubs loadConfig to return a fake config with the given endpoints (default: one endpoint). */
export function stubConfig(endpoints: EndpointConfig[] = [DEFAULT_ENDPOINT]): void {
  stub(configModule, 'loadConfig', () => ({
    endpoints,
    defaultEndpoint: endpoints[0]?.name,
    cachePath: '/fake/cache',
    configFile: '/fake/servicex.yaml',
  }));
}

/** Stubs readCacheRecords to return fixed records (or delegate to a function for call-counting),
 *  wrapped in the { records, corrupted: 0 } shape the real function returns. */
export function stubCacheRecords(records: CacheDbRecord[] | (() => CacheDbRecord[])): void {
  const getRecords = typeof records === 'function' ? records : () => records;
  stub(cacheDbModule, 'readCacheRecords', () => ({ records: getRecords(), corrupted: 0 }));
}

/** Fakes just enough of ServiceXApi to drive CacheTreeProvider.getChildren()
 *  end-to-end without any real network or filesystem access. Routes by the
 *  endpoint URL that CacheTreeProvider constructed it with; a missing id
 *  raises NotFoundError, an Error value is thrown as-is.
 *
 *  `allTransformsData` backs getAllTransforms() (the dashboard source) the
 *  same way `backendData` backs getTransformStatus() (the cache source) -
 *  an endpoint with no entry returns [], and an Error value is thrown as-is
 *  to simulate one backend failing without touching the others. */
export function stubServiceXApi(
  backendData: Record<string, Record<string, TransformStatus | Error>>,
  allTransformsData: Record<string, TransformStatus[] | Error> = {}
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
    async getAllTransforms(): Promise<TransformStatus[]> {
      const result = allTransformsData[this.endpoint] ?? [];
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }
  }
  stub(serviceXApiModule, 'ServiceXApi', FakeServiceXApi);
}
