import * as assert from 'assert';
import * as vscode from 'vscode';
import * as configModule from '../config';
import * as cacheDbModule from '../cacheDb';
import * as serviceXApiModule from '../serviceXApi';
import { NotFoundError, TransformStatus } from '../serviceXApi';
import { RequestItem, TitleGroupItem, CacheEntry } from '../cacheTreeProvider';

const EXTENSION_ID = 'RogerJanusiak.servicex-vscode-extension';

function makeEntry(overrides: Partial<CacheEntry>): CacheEntry {
  return {
    requestId: 'req-1',
    title: 'MyTitle',
    status: 'Complete',
    files: 1,
    filesCompleted: 1,
    filesFailed: 0,
    stale: false,
    ...overrides,
  };
}

/** Same fake as cacheTreeProvider.test.ts - routes getTransformStatus by endpoint URL. */
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

async function activateExtension(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `Extension ${EXTENSION_ID} not found - is it loaded in the test host?`);
  await ext!.activate();
}

suite('extension.ts - activation', () => {
  suiteSetup(activateExtension);

  test('activate() registers all expected commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'servicex.refreshCache',
      'servicex.deleteFromCache',
      'servicex.cleanGroup',
      'servicex.deleteGroup',
      'servicex.copyRequestId',
      'servicex.copyFileList',
      'servicex.openFilterMenu',
      'servicex.clearAllFilters',
      'servicex.openSortMenu',
      'servicex.groupByTitle',
      'servicex.ungroup',
    ]) {
      assert.ok(commands.includes(id), `expected command ${id} to be registered`);
    }
  });
});

suite('extension.ts - command handlers', () => {
  const originalLoadConfig = configModule.loadConfig;
  const originalReadCacheRecords = cacheDbModule.readCacheRecords;
  const originalDeleteCacheRecord = cacheDbModule.deleteCacheRecord;
  const originalDeleteAllForTitle = cacheDbModule.deleteAllForTitle;
  const originalServiceXApi = serviceXApiModule.ServiceXApi;
  const originalShowWarningMessage = vscode.window.showWarningMessage;
  const originalShowInformationMessage = vscode.window.showInformationMessage;
  const originalShowQuickPick = vscode.window.showQuickPick;

  suiteSetup(activateExtension);

  teardown(async () => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = originalLoadConfig;
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = originalReadCacheRecords;
    (cacheDbModule as unknown as { deleteCacheRecord: unknown }).deleteCacheRecord = originalDeleteCacheRecord;
    (cacheDbModule as unknown as { deleteAllForTitle: unknown }).deleteAllForTitle = originalDeleteAllForTitle;
    (serviceXApiModule as unknown as { ServiceXApi: unknown }).ServiceXApi = originalServiceXApi;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = originalShowWarningMessage;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
      originalShowInformationMessage;
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick;
    // The extension keeps a single shared CacheTreeProvider instance for the
    // test process's lifetime - clear any filter a test left active so it
    // doesn't leak into unrelated tests.
    await vscode.commands.executeCommand('servicex.clearAllFilters');
  });

  test('servicex.deleteFromCache does nothing when the user dismisses the confirmation', async () => {
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async () => undefined;
    let deleteCalled = false;
    (cacheDbModule as unknown as { deleteCacheRecord: unknown }).deleteCacheRecord = () => {
      deleteCalled = true;
      return true;
    };

    const item = new RequestItem(makeEntry({ requestId: 'req-1' }));
    await vscode.commands.executeCommand('servicex.deleteFromCache', item);

    assert.strictEqual(deleteCalled, false);
  });

  test('servicex.deleteFromCache deletes the record when confirmed', async () => {
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async () => 'Delete';
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [],
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    let deletedRequestId: string | undefined;
    (cacheDbModule as unknown as { deleteCacheRecord: unknown }).deleteCacheRecord = (
      _cachePath: string,
      requestId: string
    ) => {
      deletedRequestId = requestId;
      return true;
    };
    let infoMessage: string | undefined;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    };

    const item = new RequestItem(makeEntry({ requestId: 'req-1' }));
    await vscode.commands.executeCommand('servicex.deleteFromCache', item);

    assert.strictEqual(deletedRequestId, 'req-1');
    assert.ok(infoMessage?.includes('Deleted cached files for req-1'));
  });

  test('servicex.cleanGroup shows "nothing to clean" without prompting when there is nothing to delete', async () => {
    let warningShown = false;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async () => {
      warningShown = true;
      return 'Delete';
    };
    let infoMessage: string | undefined;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    };

    const only = makeEntry({ requestId: 'only', status: 'Complete' });
    const group = new TitleGroupItem('MyTitle', [only]);
    await vscode.commands.executeCommand('servicex.cleanGroup', group);

    assert.strictEqual(warningShown, false);
    assert.ok(infoMessage?.includes("Nothing to clean for 'MyTitle'"));
  });

  test('servicex.cleanGroup deletes stale/cancelled entries when confirmed', async () => {
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async () => 'Delete';
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [],
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    const deletedIds: string[] = [];
    (cacheDbModule as unknown as { deleteCacheRecord: unknown }).deleteCacheRecord = (
      _cachePath: string,
      requestId: string
    ) => {
      deletedIds.push(requestId);
      return true;
    };
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = () =>
      Promise.resolve(undefined);

    const newest = makeEntry({ requestId: 'newest', status: 'Complete', submitTime: new Date(500) });
    const older = makeEntry({ requestId: 'older', status: 'Complete', submitTime: new Date(100) });
    const cancelled = makeEntry({ requestId: 'cancelled', status: 'Canceled', submitTime: new Date(300) });
    const group = new TitleGroupItem('MyTitle', [newest, older, cancelled]);

    await vscode.commands.executeCommand('servicex.cleanGroup', group);

    assert.deepStrictEqual(deletedIds.sort(), ['cancelled', 'older']);
  });

  test('servicex.cleanGroup sweeps entries hidden by the status filter, not just the visible ones', async () => {
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async () => 'Delete';
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [],
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    const deletedIds: string[] = [];
    (cacheDbModule as unknown as { deleteCacheRecord: unknown }).deleteCacheRecord = (
      _cachePath: string,
      requestId: string
    ) => {
      deletedIds.push(requestId);
      return true;
    };
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = () =>
      Promise.resolve(undefined);

    const newest = makeEntry({ requestId: 'newest', status: 'Complete', submitTime: new Date(500) });
    const older = makeEntry({ requestId: 'older', status: 'Complete', submitTime: new Date(100) });
    const cancelled = makeEntry({ requestId: 'cancelled', status: 'Canceled', submitTime: new Date(300) });
    // Simulate a status filter set to "Complete" only: the group's visible
    // `entries` excludes the cancelled request, but `allEntries` (what a
    // real filtered CacheTreeProvider would attach) still has everything.
    const group = new TitleGroupItem('MyTitle', [newest, older], [newest, older, cancelled]);

    await vscode.commands.executeCommand('servicex.cleanGroup', group);

    assert.deepStrictEqual(
      deletedIds.sort(),
      ['cancelled', 'older'],
      'Clean should sweep the cancelled request even though it was hidden by the active filter'
    );
  });

  test('servicex.cleanGroup warns that hidden requests will still be cleaned when a filter is active', async () => {
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [{ name: 'default', endpoint: 'https://default.example.org', token: 't' }],
      defaultEndpoint: 'default',
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    (cacheDbModule as unknown as { readCacheRecords: unknown }).readCacheRecords = () => [
      { request_id: 'a1', title: 'A', status: 'COMPLETE' },
    ];
    installFakeServiceXApi({
      'https://default.example.org': {
        a1: fakeStatus({ requestId: 'a1', title: 'A', status: 'Complete' }),
      },
    });
    // Drive the Filter... hub: first pick opens the "Status" sub-menu, then
    // pick zero of the available statuses - a non-empty, non-"select all"
    // choice, so the filter ends up active (not cleared).
    let quickPickCall = 0;
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (items: unknown) => {
      quickPickCall++;
      if (quickPickCall === 1) {
        return (items as { action: string }[]).find((i) => i.action === 'status');
      }
      return [];
    };
    await vscode.commands.executeCommand('servicex.openFilterMenu');

    (cacheDbModule as unknown as { deleteCacheRecord: unknown }).deleteCacheRecord = () => true;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = () =>
      Promise.resolve(undefined);
    let capturedMessage: string | undefined;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async (msg: string) => {
      capturedMessage = msg;
      return 'Delete';
    };

    const cancelled = makeEntry({ requestId: 'cancelled', status: 'Canceled' });
    const group = new TitleGroupItem('MyTitle', [], [cancelled]);
    await vscode.commands.executeCommand('servicex.cleanGroup', group);

    assert.ok(
      capturedMessage?.includes('A filter is currently active'),
      `expected the filter warning in: ${capturedMessage}`
    );
  });

  test('servicex.cleanGroup does not mention a filter when none is active', async () => {
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = () =>
      Promise.resolve(undefined);
    (cacheDbModule as unknown as { deleteCacheRecord: unknown }).deleteCacheRecord = () => true;
    let capturedMessage: string | undefined;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async (msg: string) => {
      capturedMessage = msg;
      return 'Delete';
    };

    const cancelled = makeEntry({ requestId: 'cancelled', status: 'Canceled' });
    const group = new TitleGroupItem('MyTitle', [cancelled]);
    await vscode.commands.executeCommand('servicex.cleanGroup', group);

    assert.ok(
      !capturedMessage?.includes('filter is currently active'),
      `did not expect a filter warning in: ${capturedMessage}`
    );
  });

  test('servicex.deleteGroup deletes every request in the group when confirmed', async () => {
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async () => 'Delete All';
    (configModule as unknown as { loadConfig: unknown }).loadConfig = () => ({
      endpoints: [],
      cachePath: '/fake/cache',
      configFile: '/fake/servicex.yaml',
    });
    let deletedTitle: string | undefined;
    (cacheDbModule as unknown as { deleteAllForTitle: unknown }).deleteAllForTitle = (
      _cachePath: string,
      title: string
    ) => {
      deletedTitle = title;
      return 3;
    };
    let infoMessage: string | undefined;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    };

    const group = new TitleGroupItem('MyTitle', [makeEntry({}), makeEntry({}), makeEntry({})]);
    await vscode.commands.executeCommand('servicex.deleteGroup', group);

    assert.strictEqual(deletedTitle, 'MyTitle');
    assert.ok(infoMessage?.includes('Deleted 3 cached request(s)'));
  });

  // vscode.env.clipboard is a genuinely frozen object at runtime (unlike
  // vscode.window's methods above), so these use the real clipboard rather
  // than stubbing it - harmless in a test host, and arguably more faithful.
  test('servicex.copyRequestId copies the request id to the clipboard', async () => {
    await vscode.env.clipboard.writeText('sentinel-before');

    const item = new RequestItem(makeEntry({ requestId: 'req-xyz' }));
    await vscode.commands.executeCommand('servicex.copyRequestId', item);

    assert.strictEqual(await vscode.env.clipboard.readText(), 'req-xyz');
  });

  test('servicex.copyFileList copies newline-joined file paths', async () => {
    await vscode.env.clipboard.writeText('sentinel-before');

    const item = new RequestItem(makeEntry({ fileList: ['/a/file1.root', '/a/file2.root'] }));
    await vscode.commands.executeCommand('servicex.copyFileList', item);

    assert.strictEqual(await vscode.env.clipboard.readText(), '/a/file1.root\n/a/file2.root');
  });

  test('servicex.copyFileList shows an info message instead of copying when there is nothing to copy', async () => {
    await vscode.env.clipboard.writeText('sentinel-before');
    let infoMessage: string | undefined;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    };

    const item = new RequestItem(makeEntry({ requestId: 'req-empty', fileList: undefined }));
    await vscode.commands.executeCommand('servicex.copyFileList', item);

    assert.strictEqual(await vscode.env.clipboard.readText(), 'sentinel-before');
    assert.ok(infoMessage?.includes('No downloaded files to copy for req-empty'));
  });
});
