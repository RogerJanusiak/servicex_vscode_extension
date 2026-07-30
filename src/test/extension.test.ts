import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as configModule from '../config';
import * as cacheDbModule from '../cacheDb';
import { RequestItem, TitleGroupItem } from '../cacheTreeProvider';
import {
  stub,
  restoreStubs,
  makeEntry,
  fakeStatus,
  stubConfig,
  stubCacheRecords,
  stubServiceXApi,
} from './testUtils';

const EXTENSION_ID = 'RogerJanusiak.servicex-vscode-extension';

async function activateExtension(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `Extension ${EXTENSION_ID} not found - is it loaded in the test host?`);
  // activate() eagerly computes the cache-size badge once at startup, before
  // any per-test stub exists. Stub loadConfig for that one moment so it
  // can't wander off and read whatever real .servicex/servicex.yaml happens
  // to be findable on the host machine - activation itself must stay
  // hermetic, same as every other test in this file.
  stub(configModule, 'loadConfig', () => {
    throw new Error('no config in test activation');
  });
  await ext!.activate();
  restoreStubs();
}

/** Stubs the fetch pipeline with two backends and two requests (one Fatal with
 *  failed files on testing3), then forces the extension's shared provider to
 *  re-fetch from those stubs - so each test starts from known data no matter
 *  what ran before it. */
async function loadFakeCache(): Promise<void> {
  stubConfig([
    { name: 'uchicago', endpoint: 'https://uchicago.example.org', token: 't1' },
    { name: 'testing3', endpoint: 'https://testing3.example.org', token: 't2' },
  ]);
  stubCacheRecords([
    { request_id: 'u1', title: 'OnUchicago', status: 'COMPLETE' },
    { request_id: 't1', title: 'OnTesting3', status: 'FATAL' },
  ]);
  stubServiceXApi({
    'https://uchicago.example.org': {
      u1: fakeStatus({ requestId: 'u1', title: 'OnUchicago', status: 'Complete' }),
    },
    'https://testing3.example.org': {
      t1: fakeStatus({ requestId: 't1', title: 'OnTesting3', status: 'Fatal', filesFailed: 2 }),
    },
  });
  await vscode.commands.executeCommand('servicex.refreshCache');
}

/** Stubs showQuickPick to answer the Filter... hub with the given action, then
 *  answer the sub-prompt (if any) with `subResult`. */
function driveFilterMenu(action: string, subResult?: unknown): void {
  let call = 0;
  stub(vscode.window, 'showQuickPick', async (items: unknown) => {
    call++;
    if (call === 1) {
      return (items as { action: string }[]).find((i) => i.action === action);
    }
    return subResult;
  });
}

/** Runs Clean on `group` with the confirmation auto-accepted and returns the
 *  warning text it showed - the observable that proves whether the extension's
 *  shared provider currently has an active filter. */
async function captureCleanWarning(group: TitleGroupItem): Promise<string | undefined> {
  let captured: string | undefined;
  stub(vscode.window, 'showInformationMessage', () => Promise.resolve(undefined));
  stub(cacheDbModule, 'deleteCacheRecord', () => true);
  stub(vscode.window, 'showWarningMessage', async (msg: string) => {
    captured = msg;
    return 'Delete';
  });
  await vscode.commands.executeCommand('servicex.cleanGroup', group);
  return captured;
}

function cancelledGroup(): TitleGroupItem {
  const cancelled = makeEntry({ requestId: 'cancelled', status: 'Canceled' });
  return new TitleGroupItem('MyTitle', [cancelled]);
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
      'servicex.openDashboard',
      'servicex.openCacheFolder',
      'servicex.openCacheRootFolder',
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
  suiteSetup(activateExtension);

  // The extension keeps one shared CacheTreeProvider for the whole test
  // process, so teardown must reset every piece of state a test can touch
  // through commands: stubs, filters, grouping, and sort.
  teardown(async () => {
    restoreStubs();
    await vscode.commands.executeCommand('servicex.clearAllFilters');
    await vscode.commands.executeCommand('servicex.groupByTitle');
    stub(vscode.window, 'showQuickPick', async (items: unknown) =>
      (items as { sortBy: string; direction: string }[]).find(
        (i) => i.sortBy === 'date' && i.direction === 'desc'
      )
    );
    await vscode.commands.executeCommand('servicex.openSortMenu');
    restoreStubs();
  });

  test('servicex.deleteFromCache does nothing when the user dismisses the confirmation', async () => {
    stub(vscode.window, 'showWarningMessage', async () => undefined);
    let deleteCalled = false;
    stub(cacheDbModule, 'deleteCacheRecord', () => {
      deleteCalled = true;
      return true;
    });

    const item = new RequestItem(makeEntry({ requestId: 'req-1' }));
    await vscode.commands.executeCommand('servicex.deleteFromCache', item);

    assert.strictEqual(deleteCalled, false);
  });

  test('servicex.deleteFromCache deletes the record when confirmed', async () => {
    stubConfig();
    stub(vscode.window, 'showWarningMessage', async () => 'Delete');
    let deletedRequestId: string | undefined;
    stub(cacheDbModule, 'deleteCacheRecord', (_cachePath: string, requestId: string) => {
      deletedRequestId = requestId;
      return true;
    });
    let infoMessage: string | undefined;
    stub(vscode.window, 'showInformationMessage', (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    });

    const item = new RequestItem(makeEntry({ requestId: 'req-1' }));
    await vscode.commands.executeCommand('servicex.deleteFromCache', item);

    assert.strictEqual(deletedRequestId, 'req-1');
    assert.ok(infoMessage?.includes('Deleted cached files for req-1'));
  });

  test('servicex.cleanGroup shows "nothing to clean" without prompting when there is nothing to delete', async () => {
    let warningShown = false;
    stub(vscode.window, 'showWarningMessage', async () => {
      warningShown = true;
      return 'Delete';
    });
    let infoMessage: string | undefined;
    stub(vscode.window, 'showInformationMessage', (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    });

    const only = makeEntry({ requestId: 'only', status: 'Complete' });
    const group = new TitleGroupItem('MyTitle', [only]);
    await vscode.commands.executeCommand('servicex.cleanGroup', group);

    assert.strictEqual(warningShown, false);
    assert.ok(infoMessage?.includes("Nothing to clean for 'MyTitle'"));
  });

  test('servicex.cleanGroup deletes stale/cancelled entries when confirmed', async () => {
    stubConfig();
    stub(vscode.window, 'showWarningMessage', async () => 'Delete');
    const deletedIds: string[] = [];
    stub(cacheDbModule, 'deleteCacheRecord', (_cachePath: string, requestId: string) => {
      deletedIds.push(requestId);
      return true;
    });
    stub(vscode.window, 'showInformationMessage', () => Promise.resolve(undefined));

    const newest = makeEntry({ requestId: 'newest', status: 'Complete', submitTime: new Date(500) });
    const older = makeEntry({ requestId: 'older', status: 'Complete', submitTime: new Date(100) });
    const cancelled = makeEntry({ requestId: 'cancelled', status: 'Canceled', submitTime: new Date(300) });
    const group = new TitleGroupItem('MyTitle', [newest, older, cancelled]);

    await vscode.commands.executeCommand('servicex.cleanGroup', group);

    assert.deepStrictEqual(deletedIds.sort(), ['cancelled', 'older']);
  });

  test('servicex.cleanGroup sweeps entries hidden by an active filter, not just the visible ones', async () => {
    stubConfig();
    stub(vscode.window, 'showWarningMessage', async () => 'Delete');
    const deletedIds: string[] = [];
    stub(cacheDbModule, 'deleteCacheRecord', (_cachePath: string, requestId: string) => {
      deletedIds.push(requestId);
      return true;
    });
    stub(vscode.window, 'showInformationMessage', () => Promise.resolve(undefined));

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

  test('servicex.cleanGroup does not mention a filter when none is active', async () => {
    stubConfig();

    const message = await captureCleanWarning(cancelledGroup());

    assert.ok(message, 'expected the confirmation prompt to be shown');
    assert.ok(
      !message!.includes('filter is currently active'),
      `did not expect a filter warning in: ${message}`
    );
  });

  test('a status filter chosen through the Filter menu triggers the cleanGroup warning', async () => {
    await loadFakeCache();
    // Deselect everything - a non-empty, non-"select all" choice, so the
    // filter ends up active rather than cleared.
    driveFilterMenu('status', []);
    await vscode.commands.executeCommand('servicex.openFilterMenu');

    const message = await captureCleanWarning(cancelledGroup());

    assert.ok(
      message?.includes('A filter is currently active'),
      `expected the filter warning in: ${message}`
    );
  });

  test('a backend filter chosen through the Filter menu triggers the cleanGroup warning', async () => {
    await loadFakeCache();
    driveFilterMenu('backend', [{ label: 'testing3' }]);
    await vscode.commands.executeCommand('servicex.openFilterMenu');

    const message = await captureCleanWarning(cancelledGroup());

    assert.ok(
      message?.includes('A filter is currently active'),
      `expected the filter warning in: ${message}`
    );
  });

  test('a failure filter chosen through the Filter menu triggers the cleanGroup warning', async () => {
    await loadFakeCache();
    driveFilterMenu('failures', { label: 'With Failures Only', value: 'withFailures' });
    await vscode.commands.executeCommand('servicex.openFilterMenu');

    const message = await captureCleanWarning(cancelledGroup());

    assert.ok(
      message?.includes('A filter is currently active'),
      `expected the filter warning in: ${message}`
    );
  });

  test('a date filter chosen through the Filter menu triggers the cleanGroup warning', async () => {
    await loadFakeCache();
    driveFilterMenu('date', 'Today');
    await vscode.commands.executeCommand('servicex.openFilterMenu');

    const message = await captureCleanWarning(cancelledGroup());

    assert.ok(
      message?.includes('A filter is currently active'),
      `expected the filter warning in: ${message}`
    );
  });

  test("the Filter menu's Clear All Filters entry removes every active filter", async () => {
    await loadFakeCache();
    driveFilterMenu('status', []);
    await vscode.commands.executeCommand('servicex.openFilterMenu');
    restoreStubs();
    stubConfig();

    driveFilterMenu('clear');
    await vscode.commands.executeCommand('servicex.openFilterMenu');

    const message = await captureCleanWarning(cancelledGroup());
    assert.ok(
      !message?.includes('filter is currently active'),
      `did not expect a filter warning in: ${message}`
    );
  });

  test('servicex.clearAllFilters removes every active filter', async () => {
    await loadFakeCache();
    driveFilterMenu('status', []);
    await vscode.commands.executeCommand('servicex.openFilterMenu');

    await vscode.commands.executeCommand('servicex.clearAllFilters');

    const message = await captureCleanWarning(cancelledGroup());
    assert.ok(
      !message?.includes('filter is currently active'),
      `did not expect a filter warning in: ${message}`
    );
  });

  test('dismissing the Filter menu hub leaves filters untouched', async () => {
    stubConfig();
    stub(vscode.window, 'showQuickPick', async () => undefined);
    await vscode.commands.executeCommand('servicex.openFilterMenu');

    const message = await captureCleanWarning(cancelledGroup());
    assert.ok(
      !message?.includes('filter is currently active'),
      `did not expect a filter warning in: ${message}`
    );
  });

  test('the Filter menu shows an info message instead of the status picker when the cache is empty', async () => {
    stubConfig();
    stubCacheRecords([]);
    stubServiceXApi({});
    await vscode.commands.executeCommand('servicex.refreshCache');

    let infoMessage: string | undefined;
    stub(vscode.window, 'showInformationMessage', (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    });
    driveFilterMenu('status');
    await vscode.commands.executeCommand('servicex.openFilterMenu');

    assert.ok(infoMessage?.includes('No cached transform requests to filter yet'));
  });

  test('the Sort menu offers all six orderings and marks the current one', async () => {
    let captured: { label: string; description?: string }[] = [];
    stub(vscode.window, 'showQuickPick', async (items: unknown) => {
      captured = items as { label: string; description?: string }[];
      return undefined;
    });

    await vscode.commands.executeCommand('servicex.openSortMenu');

    assert.deepStrictEqual(
      captured.map((i) => i.label),
      [
        'Title (A → Z)',
        'Title (Z → A)',
        'Date (Newest First)',
        'Date (Oldest First)',
        'Total Files (Most First)',
        'Total Files (Fewest First)',
      ]
    );
    // Teardown resets the shared provider to the default sort, so that is
    // what must carry the "current" marker here.
    assert.deepStrictEqual(
      captured.filter((i) => i.description === 'current').map((i) => i.label),
      ['Date (Newest First)']
    );
  });

  test('picking a sort applies it: the next Sort menu marks the new choice as current', async () => {
    stub(vscode.window, 'showQuickPick', async (items: unknown) =>
      (items as { label: string }[]).find((i) => i.label === 'Title (A → Z)')
    );
    await vscode.commands.executeCommand('servicex.openSortMenu');
    restoreStubs();

    let captured: { label: string; description?: string }[] = [];
    stub(vscode.window, 'showQuickPick', async (items: unknown) => {
      captured = items as { label: string; description?: string }[];
      return undefined;
    });
    await vscode.commands.executeCommand('servicex.openSortMenu');

    assert.deepStrictEqual(
      captured.filter((i) => i.description === 'current').map((i) => i.label),
      ['Title (A → Z)']
    );
  });

  test('servicex.ungroup and servicex.groupByTitle execute cleanly', async () => {
    // The grouped/ungrouped rendering itself is covered by the provider
    // tests; VS Code offers no API to read back a tree view's contents or a
    // context key, so at the command level this covers the wiring only.
    await vscode.commands.executeCommand('servicex.ungroup');
    await vscode.commands.executeCommand('servicex.groupByTitle');
  });

  test('servicex.deleteGroup deletes every request in the group when confirmed', async () => {
    stubConfig();
    stub(vscode.window, 'showWarningMessage', async () => 'Delete All');
    let deletedTitle: string | undefined;
    stub(cacheDbModule, 'deleteAllForTitle', (_cachePath: string, title: string) => {
      deletedTitle = title;
      return 3;
    });
    let infoMessage: string | undefined;
    stub(vscode.window, 'showInformationMessage', (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    });

    const group = new TitleGroupItem('MyTitle', [makeEntry(), makeEntry(), makeEntry()]);
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
    stub(vscode.window, 'showInformationMessage', (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    });

    const item = new RequestItem(makeEntry({ requestId: 'req-empty', fileList: undefined }));
    await vscode.commands.executeCommand('servicex.copyFileList', item);

    assert.strictEqual(await vscode.env.clipboard.readText(), 'sentinel-before');
    assert.ok(infoMessage?.includes('No downloaded files to copy for req-empty'));
  });

  test('servicex.openDashboard opens the transformation-request page for the entry\'s backend', async () => {
    stubConfig([
      { name: 'uchicago', endpoint: 'https://servicex.af.uchicago.edu/', token: 't1' },
      { name: 'testing3', endpoint: 'https://testing3.example.org', token: 't2' },
    ]);
    let openedUrl: string | undefined;
    stub(vscode.env, 'openExternal', async (uri: vscode.Uri) => {
      openedUrl = uri.toString();
      return true;
    });

    const item = new RequestItem(makeEntry({ requestId: 'req-1', backend: 'uchicago' }));
    await vscode.commands.executeCommand('servicex.openDashboard', item);

    // The endpoint's trailing slash must not produce a doubled slash in the URL.
    assert.strictEqual(openedUrl, 'https://servicex.af.uchicago.edu/transformation-request/req-1');
  });

  test('servicex.openDashboard shows an info message instead when the entry has no known backend', async () => {
    let openCalled = false;
    stub(vscode.env, 'openExternal', async () => {
      openCalled = true;
      return true;
    });
    let infoMessage: string | undefined;
    stub(vscode.window, 'showInformationMessage', (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    });

    const item = new RequestItem(makeEntry({ requestId: 'req-stale', backend: undefined }));
    await vscode.commands.executeCommand('servicex.openDashboard', item);

    assert.strictEqual(openCalled, false);
    assert.ok(infoMessage?.includes("Can't open the dashboard for req-stale"));
    assert.ok(infoMessage?.includes('backend'));
  });

  test('servicex.openDashboard shows an info message when the backend is not in the current config', async () => {
    stubConfig([{ name: 'uchicago', endpoint: 'https://servicex.af.uchicago.edu/', token: 't1' }]);
    let openCalled = false;
    stub(vscode.env, 'openExternal', async () => {
      openCalled = true;
      return true;
    });
    let infoMessage: string | undefined;
    stub(vscode.window, 'showInformationMessage', (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    });

    // "renamed" isn't in the stubbed config - e.g. the user renamed/removed
    // that backend from servicex.yaml since this request was cached.
    const item = new RequestItem(makeEntry({ requestId: 'req-2', backend: 'renamed' }));
    await vscode.commands.executeCommand('servicex.openDashboard', item);

    assert.strictEqual(openCalled, false);
    assert.ok(infoMessage?.includes("Can't open the dashboard for req-2"));
    assert.ok(infoMessage?.includes("'renamed'"));
  });

  test("servicex.openCacheFolder opens the request's data_dir as a new VS Code window", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-open-folder-test-'));
    try {
      const realExecuteCommand = vscode.commands.executeCommand;
      let openFolderArgs: unknown[] | undefined;
      stub(
        vscode.commands,
        'executeCommand',
        // Pass every command through to the real dispatcher (so our own
        // servicex.openCacheFolder invocation below still reaches its real
        // handler) except vscode.openFolder itself, which would otherwise
        // try to tear down this very test host and open a new window.
        (command: string, ...args: unknown[]) => {
          if (command === 'vscode.openFolder') {
            openFolderArgs = args;
            return Promise.resolve();
          }
          return (realExecuteCommand as (...a: unknown[]) => Thenable<unknown>)(command, ...args);
        }
      );

      const item = new RequestItem(makeEntry({ requestId: 'req-1', dataDir }));
      await vscode.commands.executeCommand('servicex.openCacheFolder', item);

      assert.ok(openFolderArgs, 'expected vscode.openFolder to have been invoked');
      const [uri, forceNewWindow] = openFolderArgs!;
      assert.strictEqual((uri as vscode.Uri).fsPath, dataDir);
      assert.strictEqual(forceNewWindow, true);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('servicex.openCacheFolder shows an info message instead when the request has no data_dir', async () => {
    let openFolderCalled = false;
    const realExecuteCommand = vscode.commands.executeCommand;
    stub(vscode.commands, 'executeCommand', (command: string, ...args: unknown[]) => {
      if (command === 'vscode.openFolder') {
        openFolderCalled = true;
        return Promise.resolve();
      }
      return (realExecuteCommand as (...a: unknown[]) => Thenable<unknown>)(command, ...args);
    });
    let infoMessage: string | undefined;
    stub(vscode.window, 'showInformationMessage', (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    });

    const item = new RequestItem(makeEntry({ requestId: 'req-submitted', dataDir: undefined }));
    await vscode.commands.executeCommand('servicex.openCacheFolder', item);

    assert.strictEqual(openFolderCalled, false);
    assert.ok(infoMessage?.includes('No downloaded files to open for req-submitted yet'));
  });

  test('servicex.openCacheFolder shows an info message instead when the data_dir no longer exists on disk', async () => {
    let openFolderCalled = false;
    const realExecuteCommand = vscode.commands.executeCommand;
    stub(vscode.commands, 'executeCommand', (command: string, ...args: unknown[]) => {
      if (command === 'vscode.openFolder') {
        openFolderCalled = true;
        return Promise.resolve();
      }
      return (realExecuteCommand as (...a: unknown[]) => Thenable<unknown>)(command, ...args);
    });
    let infoMessage: string | undefined;
    stub(vscode.window, 'showInformationMessage', (msg: string) => {
      infoMessage = msg;
      return Promise.resolve(undefined);
    });

    // A data_dir the local db still references but that was removed some
    // other way (e.g. manually, or by a different tool) since it was cached.
    const missingDir = path.join(os.tmpdir(), 'servicex-does-not-exist-' + Date.now());
    const item = new RequestItem(makeEntry({ requestId: 'req-gone', dataDir: missingDir }));
    await vscode.commands.executeCommand('servicex.openCacheFolder', item);

    assert.strictEqual(openFolderCalled, false);
    assert.ok(infoMessage?.includes("doesn't exist on disk"));
  });

  test('servicex.openCacheRootFolder opens the configured cache_path as a new VS Code window', async () => {
    const cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'servicex-cache-root-test-'));
    try {
      stub(configModule, 'loadConfig', () => ({
        endpoints: [],
        cachePath,
        configFile: '/fake/servicex.yaml',
      }));

      const realExecuteCommand = vscode.commands.executeCommand;
      let openFolderArgs: unknown[] | undefined;
      stub(vscode.commands, 'executeCommand', (command: string, ...args: unknown[]) => {
        if (command === 'vscode.openFolder') {
          openFolderArgs = args;
          return Promise.resolve();
        }
        return (realExecuteCommand as (...a: unknown[]) => Thenable<unknown>)(command, ...args);
      });

      await vscode.commands.executeCommand('servicex.openCacheRootFolder');

      assert.ok(openFolderArgs, 'expected vscode.openFolder to have been invoked');
      const [uri, forceNewWindow] = openFolderArgs!;
      assert.strictEqual((uri as vscode.Uri).fsPath, cachePath);
      assert.strictEqual(forceNewWindow, true);
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true });
    }
  });
});
