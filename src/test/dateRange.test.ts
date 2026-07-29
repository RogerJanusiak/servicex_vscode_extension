import * as assert from 'assert';
import { startOfDay, endOfDay, daysAgo, parseDateInput } from '../dateRange';

suite('dateRange.ts - startOfDay / endOfDay', () => {
  test('startOfDay zeroes the time while keeping the calendar date', () => {
    const result = startOfDay(new Date(2026, 0, 15, 13, 45, 30, 250));

    assert.strictEqual(result.getFullYear(), 2026);
    assert.strictEqual(result.getMonth(), 0);
    assert.strictEqual(result.getDate(), 15);
    assert.strictEqual(result.getHours(), 0);
    assert.strictEqual(result.getMinutes(), 0);
    assert.strictEqual(result.getSeconds(), 0);
    assert.strictEqual(result.getMilliseconds(), 0);
  });

  test('endOfDay pushes the time to 23:59:59.999 on the same calendar date', () => {
    const result = endOfDay(new Date(2026, 0, 15, 13, 45, 30, 250));

    assert.strictEqual(result.getDate(), 15);
    assert.strictEqual(result.getHours(), 23);
    assert.strictEqual(result.getMinutes(), 59);
    assert.strictEqual(result.getSeconds(), 59);
    assert.strictEqual(result.getMilliseconds(), 999);
  });

  test('neither mutates its input', () => {
    const input = new Date(2026, 0, 15, 13, 45, 30, 250);
    const before = input.getTime();

    startOfDay(input);
    endOfDay(input);

    assert.strictEqual(input.getTime(), before);
  });
});

suite('dateRange.ts - daysAgo', () => {
  test('daysAgo(0) is the start of today', () => {
    const result = daysAgo(0);
    const today = startOfDay(new Date());

    assert.strictEqual(result.getTime(), today.getTime());
  });

  test('daysAgo(n) lands n calendar days back, at start of day', () => {
    const result = daysAgo(6);

    assert.strictEqual(result.getHours(), 0);
    assert.strictEqual(result.getMilliseconds(), 0);
    // Compare by calendar arithmetic rather than raw ms so a DST boundary
    // inside the window can't make this flaky.
    const expected = new Date();
    expected.setDate(expected.getDate() - 6);
    assert.strictEqual(result.getTime(), startOfDay(expected).getTime());
  });
});

suite('dateRange.ts - parseDateInput', () => {
  test('parses a valid YYYY-MM-DD into local midnight of that date', () => {
    const result = parseDateInput('2026-01-15');

    assert.ok(result);
    assert.strictEqual(result!.getFullYear(), 2026);
    assert.strictEqual(result!.getMonth(), 0);
    assert.strictEqual(result!.getDate(), 15);
    assert.strictEqual(result!.getHours(), 0);
  });

  test('tolerates surrounding whitespace', () => {
    assert.ok(parseDateInput('  2026-01-15  '));
  });

  test('rejects other formats and garbage', () => {
    for (const bad of ['', '2026/01/15', '15-01-2026', '2026-1-5', 'January 15 2026', 'abc', '2026-01-15T00:00']) {
      assert.strictEqual(parseDateInput(bad), undefined, `expected '${bad}' to be rejected`);
    }
  });

  test('rejects calendar-invalid dates that match the format', () => {
    // JS Date would silently roll 2026-02-31 over to March 3; the round-trip
    // check must catch that instead of accepting a different date.
    for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31']) {
      assert.strictEqual(parseDateInput(bad), undefined, `expected '${bad}' to be rejected`);
    }
  });

  test('accepts a leap-day only in a leap year', () => {
    assert.ok(parseDateInput('2028-02-29'), '2028 is a leap year');
    assert.strictEqual(parseDateInput('2026-02-29'), undefined, '2026 is not a leap year');
  });
});
