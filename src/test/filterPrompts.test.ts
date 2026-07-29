import * as assert from 'assert';
import * as vscode from 'vscode';
import { pickMulti, pickFailureFilter, pickDateFilter } from '../filterPrompts';
import { startOfDay, endOfDay, daysAgo } from '../dateRange';
import { stub, restoreStubs } from './testUtils';

/** Stubs showQuickPick to return `result`, capturing the items/options it was shown. */
function stubQuickPick(result: unknown): { items: unknown[]; options: vscode.QuickPickOptions | undefined } {
  const captured: { items: unknown[]; options: vscode.QuickPickOptions | undefined } = {
    items: [],
    options: undefined,
  };
  stub(vscode.window, 'showQuickPick', async (items: unknown[], options?: vscode.QuickPickOptions) => {
    captured.items = items;
    captured.options = options;
    return result;
  });
  return captured;
}

/** Stubs showInputBox to return queued answers in order, capturing each call's options. */
function stubInputBox(answers: (string | undefined)[]): { calls: vscode.InputBoxOptions[] } {
  const captured: { calls: vscode.InputBoxOptions[] } = { calls: [] };
  let i = 0;
  stub(vscode.window, 'showInputBox', async (options?: vscode.InputBoxOptions) => {
    captured.calls.push(options ?? {});
    return answers[i++];
  });
  return captured;
}

suite('filterPrompts.ts - pickMulti', () => {
  teardown(restoreStubs);

  test('pre-checks every option when there is no current filter', async () => {
    const captured = stubQuickPick(undefined);

    await pickMulti(['A', 'B', 'C'], undefined, 'pick...');

    assert.deepStrictEqual(
      (captured.items as { label: string; picked: boolean }[]).map((i) => i.picked),
      [true, true, true]
    );
    assert.strictEqual(captured.options?.canPickMany, true);
  });

  test('pre-checks only the currently selected options when a filter is active', async () => {
    const captured = stubQuickPick(undefined);

    await pickMulti(['A', 'B', 'C'], new Set(['B']), 'pick...');

    assert.deepStrictEqual(
      (captured.items as { label: string; picked: boolean }[]).map((i) => i.picked),
      [false, true, false]
    );
  });

  test("returns 'cancel' when the picker is dismissed", async () => {
    stubQuickPick(undefined);
    assert.strictEqual(await pickMulti(['A', 'B'], undefined, 'pick...'), 'cancel');
  });

  test('returns undefined (no filter) when every option is selected', async () => {
    stubQuickPick([{ label: 'A' }, { label: 'B' }]);
    assert.strictEqual(await pickMulti(['A', 'B'], undefined, 'pick...'), undefined);
  });

  test('returns the chosen subset as a Set', async () => {
    stubQuickPick([{ label: 'B' }]);

    const result = await pickMulti(['A', 'B'], undefined, 'pick...');

    assert.deepStrictEqual(result, new Set(['B']));
  });

  test('an empty selection is an active filter-out-everything choice, not a cancel', async () => {
    stubQuickPick([]);

    const result = await pickMulti(['A', 'B'], undefined, 'pick...');

    assert.deepStrictEqual(result, new Set());
  });
});

suite('filterPrompts.ts - pickFailureFilter', () => {
  teardown(restoreStubs);

  test('offers all three modes and marks the current one', async () => {
    const captured = stubQuickPick(undefined);

    await pickFailureFilter('withFailures');

    const items = captured.items as { value: string; description?: string }[];
    assert.deepStrictEqual(items.map((i) => i.value), ['all', 'withFailures', 'withoutFailures']);
    assert.deepStrictEqual(
      items.filter((i) => i.description === 'current').map((i) => i.value),
      ['withFailures']
    );
  });

  test('returns the picked value, or undefined on dismiss', async () => {
    stubQuickPick({ label: 'Without Failures Only', value: 'withoutFailures' });
    assert.strictEqual(await pickFailureFilter('all'), 'withoutFailures');
    restoreStubs();

    stubQuickPick(undefined);
    assert.strictEqual(await pickFailureFilter('all'), undefined);
  });
});

suite('filterPrompts.ts - pickDateFilter', () => {
  teardown(restoreStubs);

  test("returns 'cancel' when the preset picker is dismissed", async () => {
    stubQuickPick(undefined);
    assert.strictEqual(await pickDateFilter(), 'cancel');
  });

  test("'All Time' clears the filter (undefined range)", async () => {
    stubQuickPick('All Time');
    assert.strictEqual(await pickDateFilter(), undefined);
  });

  test("'Today' spans start of today to end of today", async () => {
    stubQuickPick('Today');

    const result = await pickDateFilter();

    assert.ok(result && result !== 'cancel');
    const now = new Date();
    assert.strictEqual(result.from?.getTime(), startOfDay(now).getTime());
    assert.strictEqual(result.to?.getTime(), endOfDay(now).getTime());
  });

  test("'Last 7 Days' starts six days back so the window covers seven calendar days", async () => {
    stubQuickPick('Last 7 Days');

    const result = await pickDateFilter();

    assert.ok(result && result !== 'cancel');
    assert.strictEqual(result.from?.getTime(), daysAgo(6).getTime());
  });

  test('custom range parses both bounds to start/end of their days', async () => {
    stubQuickPick('Custom Range...');
    stubInputBox(['2026-01-10', '2026-01-20']);

    const result = await pickDateFilter();

    assert.ok(result && result !== 'cancel');
    assert.strictEqual(result.from?.getTime(), startOfDay(new Date(2026, 0, 10)).getTime());
    assert.strictEqual(result.to?.getTime(), endOfDay(new Date(2026, 0, 20)).getTime());
  });

  test('custom range treats blank bounds as unbounded', async () => {
    stubQuickPick('Custom Range...');
    stubInputBox(['', '2026-01-20']);

    const result = await pickDateFilter();

    assert.ok(result && result !== 'cancel');
    assert.strictEqual(result.from, undefined);
    assert.ok(result.to);
  });

  test("custom range returns 'cancel' if either input box is dismissed", async () => {
    stubQuickPick('Custom Range...');
    stubInputBox([undefined]);
    assert.strictEqual(await pickDateFilter(), 'cancel');
    restoreStubs();

    stubQuickPick('Custom Range...');
    stubInputBox(['2026-01-10', undefined]);
    assert.strictEqual(await pickDateFilter(), 'cancel');
  });

  test('custom range input validation accepts blank or YYYY-MM-DD and rejects everything else', async () => {
    stubQuickPick('Custom Range...');
    const inputBox = stubInputBox(['', '']);

    await pickDateFilter();

    const validate = inputBox.calls[0].validateInput as (v: string) => string | undefined;
    assert.strictEqual(validate(''), undefined);
    assert.strictEqual(validate('2026-01-15'), undefined);
    assert.strictEqual(validate('not-a-date'), 'Use YYYY-MM-DD format');
    assert.strictEqual(validate('2026-02-31'), 'Use YYYY-MM-DD format');
  });
});
