import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { executeNativeProcess } from './process';

const execFileAsync = promisify(execFile);

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline: number = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail('Owned fixture process did not reach the expected state');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function isRunning(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
  // Orphaned descendants may remain as zombies until init reaps them. They are
  // already dead and cannot execute; kill(pid, 0) alone cannot distinguish this.
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'stat='], { timeout: 1000 });
    return stdout.trim().length > 0 && !stdout.trim().startsWith('Z');
  } catch (error: unknown) {
    // A race with process reaping is expected. A missing/broken ps is not proof
    // that a still-existing descendant was terminated.
    try { process.kill(pid, 0); }
    catch (probeError: unknown) {
      if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw probeError;
    }
    throw error;
  }
}

test('POSIX cancellation kills a SIGTERM-resistant descendant after the direct parent closes its pipes', {
  skip: process.platform === 'win32' ? 'POSIX process-group signals are unavailable on Windows' : false,
  timeout: 10_000,
}, async () => {
  const descendant: string = `
    process.on('SIGTERM', () => {});
    process.send({ pid: process.pid });
    process.disconnect();
    setInterval(() => {}, 1000);
  `;
  const parent: string = `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => process.exit(0));
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.once('message', ({ pid }) => {
      process.stdout.write(JSON.stringify({ parent: process.pid, descendant: pid }) + '\\n');
      child.unref();
    });
    setInterval(() => {}, 1000);
  `;
  let parentPid: number = 0;
  let descendantPid: number = 0;
  const controller: AbortController = new AbortController();
  const execution: Promise<Error | null> = executeNativeProcess({ executable: process.execPath, prefixArgs: [] }, ['-e', parent], {
    cwd: tmpdir(), env: process.env, signal: controller.signal, timeoutMs: 8000, maxOutputBytes: 4096,
    onLine: (line: string) => {
      const ready: { parent: number; descendant: number } = JSON.parse(line);
      parentPid = ready.parent;
      descendantPid = ready.descendant;
    },
  }).then(() => null, (error: Error) => error);
  try {
    await waitUntil(() => descendantPid > 0, 4000);
    assert.equal(await isRunning(descendantPid), true);
    controller.abort();
    assert.match((await execution)?.message ?? '', /NATIVE_AGENT_CANCELLED/);
    // The execution promise settles on the direct child's close. Its resistant
    // descendant must still be reclaimed by the retained 500 ms escalation.
    assert.equal(await isRunning(parentPid), false);
    await waitUntil(async () => !(await isRunning(descendantPid)), 3500);
  } finally {
    controller.abort();
    // Regression failures must not leave the fixture's intentionally stubborn child.
    if (parentPid && descendantPid && await isRunning(descendantPid)) {
      try { process.kill(-parentPid, 'SIGKILL'); } catch { /* Group already gone. */ }
    }
    await execution;
  }
});
