import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { decodeQastle, pythonInterpreterCandidates } from '../pythonBridge';
import { stub, restoreStubs } from './testUtils';

// decode_qastle.py is driven entirely through stdin and its exit code, so
// these stand-ins reproduce each of its outcomes without needing a Python
// (let alone a Python with qastle) on the machine running the tests. `node`
// is guaranteed present - it's what the test runner itself came from.
// Every stand-in drains stdin before exiting, exactly as decode_qastle.py
// does - a script that exits with the selection still unread leaves the
// extension host writing into a closed pipe.
function fixture(body: string): string {
  return `
    let input = '';
    process.stdin.on('data', (c) => (input += c));
    process.stdin.on('end', () => { ${body} });
  `;
}

const SCRIPTS: Record<string, string> = {
  // Echo stdin (and any flags) back, the way the real script echoes source.
  'ok.js': fixture(
    `const args = process.argv.slice(2);
     process.stdout.write('decoded: ' + input.trim() + (args.length ? ' args=' + args.join(',') : '') + '\\n');`
  ),
  // Exit 2: this interpreter can't do the job (no qastle / too old).
  'unavailable.js': fixture(
    `process.stderr.write('qastle is not installed in this interpreter\\n'); process.exit(2);`
  ),
  // Exit 3: the selection itself didn't parse.
  'bad.js': fixture(
    `process.stderr.write('UnexpectedEOF: Unexpected end-of-input\\n'); process.exit(3);`
  ),
  // Anything else: an unexpected crash.
  'crash.js': fixture(
    `process.stderr.write('Traceback (most recent call last)\\n'); process.exit(1);`
  ),
};

const MISSING_INTERPRETER = 'servicex-test-no-such-interpreter';

suite('pythonBridge.ts - decodeQastle', () => {
  let scriptDir: string;

  suiteSetup(() => {
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-pybridge-'));
    for (const [name, body] of Object.entries(SCRIPTS)) {
      fs.writeFileSync(path.join(scriptDir, name), body);
    }
  });

  suiteTeardown(() => {
    fs.rmSync(scriptDir, { recursive: true, force: true });
  });

  const script = (name: string) => path.join(scriptDir, name);

  test('returns the decoded source, passing the selection in on stdin', async () => {
    const result = await decodeQastle('(call Select)', script('ok.js'), ['node']);

    assert.strictEqual(result.source, 'decoded: (call Select)');
    assert.strictEqual(result.reason, undefined);
  });

  test('passes script flags through, so metadata can be kept on request', async () => {
    const result = await decodeQastle('(call Select)', script('ok.js'), ['node'], ['--metadata']);

    assert.strictEqual(result.source, 'decoded: (call Select) args=--metadata');
  });

  test('falls through to the next interpreter when one cannot be spawned', async () => {
    const result = await decodeQastle('(call Select)', script('ok.js'), [MISSING_INTERPRETER, 'node']);

    assert.strictEqual(result.source, 'decoded: (call Select)');
  });

  test('explains itself when no interpreter has qastle, listing what it tried', async () => {
    const result = await decodeQastle('(call Select)', script('unavailable.js'), [
      MISSING_INTERPRETER,
      'node',
    ]);

    assert.strictEqual(result.source, undefined);
    assert.ok(result.reason?.includes('Showing the raw qastle'), result.reason);
    assert.ok(result.reason?.includes('servicex.pythonPath'), result.reason);
    // Both candidates were tried, and each says why it didn't work.
    assert.ok(result.reason?.includes(MISSING_INTERPRETER), result.reason);
    assert.ok(result.reason?.includes('node: qastle is not installed'), result.reason);
  });

  test('reports an unparseable selection without trying other interpreters', async () => {
    const result = await decodeQastle('(call Select', script('bad.js'), ['node', MISSING_INTERPRETER]);

    assert.strictEqual(result.source, undefined);
    assert.ok(result.reason?.includes("Could not parse this query's qastle"), result.reason);
    assert.ok(result.reason?.includes('UnexpectedEOF'), result.reason);
    // A second interpreter would fail the same way, so it isn't consulted -
    // and its name must not show up in the message.
    assert.ok(!result.reason?.includes(MISSING_INTERPRETER), result.reason);
  });

  test('surfaces an unexpected non-zero exit as a tried-and-failed attempt', async () => {
    const result = await decodeQastle('(call Select)', script('crash.js'), ['node']);

    assert.strictEqual(result.source, undefined);
    assert.ok(result.reason?.includes('node: exited 1'), result.reason);
    assert.ok(result.reason?.includes('Traceback'), result.reason);
  });

  test('returns a reason rather than throwing when given no interpreters at all', async () => {
    const result = await decodeQastle('(call Select)', script('ok.js'), []);

    assert.strictEqual(result.source, undefined);
    assert.ok(result.reason?.includes('Showing the raw qastle'), result.reason);
  });
});

suite('pythonBridge.ts - pythonInterpreterCandidates', () => {
  teardown(restoreStubs);

  test('falls back to python3 then python from PATH', async () => {
    stub(vscode.workspace, 'getConfiguration', () => ({ get: () => '' }));

    assert.deepStrictEqual(await pythonInterpreterCandidates(), ['python3', 'python']);
  });

  test('puts a configured servicex.pythonPath first', async () => {
    stub(vscode.workspace, 'getConfiguration', () => ({ get: () => '/envs/analysis/bin/python' }));

    assert.deepStrictEqual(await pythonInterpreterCandidates(), [
      '/envs/analysis/bin/python',
      'python3',
      'python',
    ]);
  });

  test('does not list the same interpreter twice', async () => {
    stub(vscode.workspace, 'getConfiguration', () => ({ get: () => 'python3' }));

    assert.deepStrictEqual(await pythonInterpreterCandidates(), ['python3', 'python']);
  });
});
