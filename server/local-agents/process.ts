import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { NativeLaunch } from './resolver';
import { NativeProviderFailure } from './failures';
import type { NativeDiagnosticEvent } from '../../shared/local-agent-diagnostics.interface';
import { diagnostic } from './diagnostics';

export interface NativeProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  onLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onDiagnostic?: (event: NativeDiagnosticEvent) => void;
}
export interface NativeProcessResult { code: number; stdout: string; stderr: string; outputBytes?: number; stderrBytes?: number }
/** Internal output is retained only to recover an accepted remote task; never use it in UI errors. */
export class NativeProcessFailure extends Error {
  constructor(message: string, readonly result: NativeProcessResult) { super(message); }
}

/** Terminate only this invocation's process tree. Never kill by executable name. */
function terminate(child: ChildProcessWithoutNullStreams, force = false): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => { child.kill(); });
    killer.once('exit', (code: number | null) => { if (code !== 0) child.kill(); });
    if (force) child.kill();
    killer.unref();
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* Already exited. */ } }
  }
}

export function executeNativeProcess(launch: NativeLaunch, args: string[], options: NativeProcessOptions): Promise<NativeProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new Error('NATIVE_AGENT_CANCELLED'));
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(launch.executable, [...launch.prefixArgs, ...args], {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let completed: boolean = false;
    let failure: Error | undefined;
    let stdout: string = '';
    let stderr: string = '';
    let partial: string = '';
    let stderrPartial: string = '';
    let bytes: number = 0;
    let outputBytes = 0;
    let stderrBytes = 0;
    let firstOutput = false;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    const decoder: StringDecoder = new StringDecoder('utf8');
    const stderrDecoder: StringDecoder = new StringDecoder('utf8');
    const callbackFailure = (error: unknown): string => error instanceof NativeProviderFailure ? error.message : 'NATIVE_AGENT_FAILED';
    const finish = (code: number): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timer); clearTimeout(closeTimer);
      // A cancelled CLI may exit before its descendants. Keep the process-group
      // escalation alive even when the direct child's pipes have already closed.
      if (!failure) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', cancel);
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      const result = { code, stdout, stderr, outputBytes, stderrBytes };
      diagnostic(options.onDiagnostic, { stage: 'process', status: failure?.message === 'NATIVE_AGENT_CANCELLED' ? 'cancelled'
        : failure || code !== 0 ? 'failed' : 'succeeded', exitCode: code, outputBytes, stderrBytes });
      if (failure) reject(new NativeProcessFailure(failure.message, result));
      else resolve(result);
    };
    const stop = (code: string): void => {
      if (failure || completed) return;
      failure = new Error(code);
      terminate(child);
      killTimer = setTimeout(() => terminate(child, true), 500);
      // A descendant holding inherited stdout cannot hold the caller forever.
      closeTimer = setTimeout(() => { child.unref(); finish(-1); }, 1500);
    };
    const cancel = (): void => stop('NATIVE_AGENT_CANCELLED');
    const timer: NodeJS.Timeout = setTimeout(() => stop('NATIVE_AGENT_TIMEOUT'), options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    const recordBytes = (chunk: Buffer, stderr = false): boolean => {
      bytes += chunk.length;
      if (stderr) stderrBytes += chunk.length; else outputBytes += chunk.length;
      if (!firstOutput) {
        firstOutput = true;
        diagnostic(options.onDiagnostic, { stage: 'output', status: 'running', outputBytes, stderrBytes });
      }
      if (bytes > options.maxOutputBytes) { stop('NATIVE_AGENT_OUTPUT_LIMIT'); return false; }
      return !failure;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (!recordBytes(chunk)) return;
      const text: string = decoder.write(chunk);
      stdout += text;
      if (!options.onLine) return;
      partial += text;
      const lines: string[] = partial.split('\n');
      partial = lines.pop() ?? '';
      try { for (const line of lines) if (line.trim()) options.onLine(line.trim()); }
      catch (error) { stop(callbackFailure(error)); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (!recordBytes(chunk, true)) return;
      const text = stderrDecoder.write(chunk);
      stderr += text;
      if (!options.onStderrLine) return;
      stderrPartial += text;
      const lines = stderrPartial.split('\n');
      stderrPartial = lines.pop() ?? '';
      try { for (const line of lines) if (line.trim()) options.onStderrLine(line.trim()); }
      catch (error) { stop(callbackFailure(error)); }
    });
    child.once('spawn', () => diagnostic(options.onDiagnostic, { stage: 'process', status: 'running' }));
    child.once('error', () => { failure ??= new Error('NATIVE_AGENT_LAUNCH_FAILED'); finish(-1); });
    child.once('close', (code: number | null) => {
      const tail = decoder.end(); const stderrTail = stderrDecoder.end();
      stdout += tail; stderr += stderrTail;
      if (!failure) {
        partial += tail; stderrPartial += stderrTail;
        try {
          if (partial.trim()) options.onLine?.(partial.trim());
          if (stderrPartial.trim()) options.onStderrLine?.(stderrPartial.trim());
        } catch (error) { failure = new Error(callbackFailure(error)); }
      }
      finish(code ?? -1);
    });
    // An early CLI validation/auth failure can close stdin before the input is consumed.
    child.stdin.on('error', () => undefined);
    if (options.signal?.aborted) cancel();
    child.stdin.end(options.input ?? '');
  });
}
