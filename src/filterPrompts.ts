import * as vscode from 'vscode';
import { FailureFilter } from './cacheTreeProvider';
import { daysAgo, endOfDay, parseDateInput, startOfDay } from './dateRange';

/** Shows a multi-select QuickPick over `options`; returns 'cancel' if the user backed out,
 *  undefined if everything ended up selected (i.e. "no filter"), or the chosen subset. */
export async function pickMulti(
  options: string[],
  current: Set<string> | undefined,
  placeHolder: string
): Promise<Set<string> | undefined | 'cancel'> {
  const picks = await vscode.window.showQuickPick(
    options.map((o) => ({ label: o, picked: !current || current.has(o) })),
    { canPickMany: true, placeHolder }
  );
  if (!picks) {
    return 'cancel';
  }
  const selected = new Set(picks.map((p) => p.label));
  return selected.size === options.length ? undefined : selected;
}

export async function pickFailureFilter(current: FailureFilter): Promise<FailureFilter | undefined> {
  const items: { label: string; value: FailureFilter }[] = [
    { label: 'All (with and without failures)', value: 'all' },
    { label: 'With Failures Only', value: 'withFailures' },
    { label: 'Without Failures Only', value: 'withoutFailures' },
  ];
  const pick = await vscode.window.showQuickPick(
    items.map((i) => ({ ...i, description: i.value === current ? 'current' : undefined })),
    { placeHolder: 'Show requests with failed files...' }
  );
  return pick?.value;
}

async function promptCustomDateRange(): Promise<{ from?: Date; to?: Date } | 'cancel'> {
  const validate = (v: string) => (v.trim() === '' || parseDateInput(v) ? undefined : 'Use YYYY-MM-DD format');
  const fromText = await vscode.window.showInputBox({
    prompt: 'From date (YYYY-MM-DD) - leave blank for no lower bound',
    validateInput: validate,
  });
  if (fromText === undefined) {
    return 'cancel';
  }
  const toText = await vscode.window.showInputBox({
    prompt: 'To date (YYYY-MM-DD) - leave blank for no upper bound',
    validateInput: validate,
  });
  if (toText === undefined) {
    return 'cancel';
  }
  return {
    from: fromText.trim() ? startOfDay(parseDateInput(fromText)!) : undefined,
    to: toText.trim() ? endOfDay(parseDateInput(toText)!) : undefined,
  };
}

export async function pickDateFilter(): Promise<{ from?: Date; to?: Date } | undefined | 'cancel'> {
  const now = new Date();
  const presets: { label: string; range: { from?: Date; to?: Date } | undefined }[] = [
    { label: 'All Time', range: undefined },
    { label: 'Today', range: { from: startOfDay(now), to: endOfDay(now) } },
    { label: 'Last 7 Days', range: { from: daysAgo(6), to: endOfDay(now) } },
    { label: 'Last 30 Days', range: { from: daysAgo(29), to: endOfDay(now) } },
  ];
  const pick = await vscode.window.showQuickPick([...presets.map((p) => p.label), 'Custom Range...'], {
    placeHolder: 'Show requests submitted...',
  });
  if (!pick) {
    return 'cancel';
  }
  if (pick === 'Custom Range...') {
    return promptCustomDateRange();
  }
  return presets.find((p) => p.label === pick)!.range;
}
