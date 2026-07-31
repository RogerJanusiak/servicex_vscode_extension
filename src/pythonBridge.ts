import * as cp from 'child_process';
import * as vscode from 'vscode';

/**
 * Runs `resources/decode_qastle.py` to turn a qastle selection back into
 * func_adl source. qastle has no JavaScript implementation, so this is the
 * one part of query decoding that has to leave the extension host - but
 * anyone who submitted a func_adl query already has qastle installed
 * (servicex depends on func_adl, which depends on qastle), so in practice
 * their own interpreter can do it.
 *
 * Over Remote-SSH this all stays on the remote: the extension host runs
 * there, so both the bundled script and the spawned interpreter are the
 * remote's - which is exactly where the analysis environment lives.
 */

/** The script's own exit codes - see the module docstring in decode_qastle.py. */
const EXIT_UNAVAILABLE = 2;
const EXIT_BAD_SELECTION = 3;

const DECODE_TIMEOUT_MS = 15_000;

export interface QastleDecodeResult {
  /** The recovered func_adl source, when some interpreter managed it. */
  source?: string;
  /** Why it didn't work, for the caller to show alongside the raw qastle. */
  reason?: string;
}

interface PythonRun {
  stdout: string;
  stderr: string;
  /** undefined when the interpreter couldn't be spawned or had to be killed. */
  code?: number;
  failure?: string;
}

function runPython(interpreter: string, args: string[], stdin: string): Promise<PythonRun> {
  return new Promise((resolve) => {
    let child: cp.ChildProcessWithoutNullStreams;
    try {
      child = cp.spawn(interpreter, args, { windowsHide: true });
    } catch (e) {
      resolve({ stdout: '', stderr: '', failure: (e as Error).message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (run: PythonRun) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(run);
      }
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ stdout, stderr, failure: `${interpreter} did not respond within 15s` });
    }, DECODE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (e) => finish({ stdout, stderr, failure: e.message }));
    child.on('close', (code) => finish({ stdout, stderr, code: code ?? undefined }));

    child.stdin.on('error', () => {
      // The interpreter can exit before it reads stdin (e.g. a missing
      // script); the 'close' handler reports that, so swallow EPIPE here
      // rather than letting it take down the extension host.
    });
    // Only once the process is actually running - writing to the stdin of a
    // child that failed to spawn at all raises SIGPIPE in the extension host.
    child.on('spawn', () => child.stdin.end(stdin));
  });
}

/** The active interpreter according to the Python extension, if it's installed. */
async function interpreterFromPythonExtension(): Promise<string | undefined> {
  const ext = vscode.extensions.getExtension('ms-python.python');
  if (!ext) {
    return undefined;
  }
  try {
    const api = ext.isActive ? ext.exports : await ext.activate();
    const resource = vscode.workspace.workspaceFolders?.[0]?.uri;
    const active = api?.environments?.getActiveEnvironmentPath?.(resource);
    return typeof active?.path === 'string' ? active.path : undefined;
  } catch {
    // The Python extension's API is optional and version-dependent - if
    // anything about it surprises us, just fall through to PATH.
    return undefined;
  }
}

/**
 * Interpreters to try, best first: an explicit `servicex.pythonPath`, then
 * whatever the Python extension has selected for this workspace (the one
 * with the user's servicex install, most of the time), then PATH.
 */
export async function pythonInterpreterCandidates(): Promise<string[]> {
  const configured = vscode.workspace.getConfiguration('servicex').get<string>('pythonPath');
  const fromExtension = await interpreterFromPythonExtension();
  const candidates = [
    ...(configured ? [configured] : []),
    ...(fromExtension ? [fromExtension] : []),
    'python3',
    'python',
  ];
  return Array.from(new Set(candidates));
}

/**
 * Try each candidate interpreter in turn until one has qastle. An
 * interpreter that can't do the job (no qastle, too old, not on PATH) just
 * moves us to the next one; a selection that doesn't parse is reported
 * straight away, since no other interpreter would parse it either.
 */
export async function decodeQastle(
  selection: string,
  scriptPath: string,
  interpreters: string[],
  scriptArgs: string[] = []
): Promise<QastleDecodeResult> {
  const attempts: string[] = [];

  for (const interpreter of interpreters) {
    const run = await runPython(interpreter, [scriptPath, ...scriptArgs], selection);

    if (run.code === 0) {
      return { source: run.stdout.trim() };
    }
    if (run.code === EXIT_BAD_SELECTION) {
      return { reason: `Could not parse this query's qastle: ${run.stderr.trim()}` };
    }
    if (run.failure) {
      attempts.push(`${interpreter}: ${run.failure}`);
    } else if (run.code === EXIT_UNAVAILABLE) {
      attempts.push(`${interpreter}: ${run.stderr.trim()}`);
    } else {
      attempts.push(`${interpreter}: exited ${run.code}${run.stderr.trim() ? ` - ${run.stderr.trim()}` : ''}`);
    }
  }

  return {
    reason:
      'Showing the raw qastle: no Python interpreter with the `qastle` package was found,\n' +
      'so it could not be turned back into func_adl source. Point `servicex.pythonPath` at\n' +
      'the environment you submit queries from, or `pip install qastle`.\n' +
      'Tried:\n' +
      attempts.map((a) => `  ${a}`).join('\n'),
  };
}
