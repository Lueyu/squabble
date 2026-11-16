/**
 * local-agents 子进程执行器：spawn 一次 native CLI 调用并安全收尾。
 *
 * 职责边界：只管单次进程的启动/输入注入/输出采集/超时取消/终止；不决定
 * 跑什么命令（resolver.ts）也不管工作区（workspace.ts）。
 *
 * 上下游：import node:child_process/path/string_decoder 与 resolver 的
 * NativeLaunch；被 native.ts / research.ts 调用。
 *
 * 关键约定：终止只针对本次调用的进程树（Windows taskkill /PID /T /F，
 * POSIX 进程组信号），绝不按可执行文件名杀进程；输出总量受
 * maxOutputBytes 硬限（超限即 NATIVE_AGENT_OUTPUT_LIMIT）；超时先用
 * SIGTERM 温和终止，500ms 后升级 SIGKILL，1500ms 后 unref 强制收尾；
 * 子进程内部输出只用于找回已受理的远端任务，绝不出现在 UI 错误里。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { NativeLaunch } from './resolver';

export interface NativeProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  onLine?: (line: string) => void;
}
export interface NativeProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
/**
 * 进程失败：携带完整 stdout/stderr 便于诊断。
 * 内部输出只保留用于找回已受理的远端任务；绝不放进 UI 错误提示。
 */
export class NativeProcessFailure extends Error {
  constructor(
    message: string,
    readonly result: NativeProcessResult,
  ) {
    super(message);
  }
}

/** 只终止本次调用拉起的进程树。绝不按可执行文件名杀进程。 */
function terminate(child: ChildProcessWithoutNullStreams, force = false): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Windows：taskkill /T 连子进程一起杀；失败（taskkill 不存在/报错）回退 child.kill。
    const killer = spawn(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    );
    killer.once('error', () => {
      child.kill();
    });
    killer.once('exit', (code: number | null) => {
      if (code !== 0) child.kill();
    });
    if (force) child.kill();
    killer.unref();
  } else {
    // POSIX：detached 使子进程自成进程组，负 pid 信号发给整组。
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      try {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        /* 已经退出了。 */
      }
    }
  }
}

/** 执行一次 native CLI：stdin 注入 input，采集 stdout/stderr，按行回调 onLine。 */
export function executeNativeProcess(
  launch: NativeLaunch,
  args: string[],
  options: NativeProcessOptions,
): Promise<NativeProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new Error('NATIVE_AGENT_CANCELLED'));
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      launch.executable,
      [...launch.prefixArgs, ...args],
      {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let completed: boolean = false;
    let failure: Error | undefined;
    let stdout: string = '';
    let stderr: string = '';
    let partial: string = '';
    let bytes: number = 0;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    const decoder: StringDecoder = new StringDecoder('utf8');
    // 唯一结算点：清定时器/摘掉 abort 监听/销毁管道，然后 resolve 或 reject。
    const finish = (code: number): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      // 被取消的 CLI 可能先于其子孙进程退出。即使直接子进程的管道已经关闭，
      // 也要保持进程组升级击杀的定时器继续存活。
      if (!failure) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', cancel);
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      if (failure) reject(new NativeProcessFailure(failure.message, { code, stdout, stderr }));
      else resolve({ code, stdout, stderr });
    };
    // 统一的失败入口：记失败原因 -> 温和终止 -> 500ms 强杀 -> 1500ms 后强制收尾。
    const stop = (code: string): void => {
      if (failure || completed) return;
      failure = new Error(code);
      terminate(child);
      killTimer = setTimeout(() => terminate(child, true), 500);
      // 继承了 stdout 的子孙进程不能让调用方永远挂着。
      closeTimer = setTimeout(() => {
        child.unref();
        finish(-1);
      }, 1500);
    };
    const cancel = (): void => stop('NATIVE_AGENT_CANCELLED');
    const timer: NodeJS.Timeout = setTimeout(() => stop('NATIVE_AGENT_TIMEOUT'), options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    // 字节预算计数：超限即停，返回 false 告知该 chunk 不再处理。
    const recordBytes = (chunk: Buffer): boolean => {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) {
        stop('NATIVE_AGENT_OUTPUT_LIMIT');
        return false;
      }
      return !failure;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (!recordBytes(chunk)) return;
      const text: string = decoder.write(chunk);
      stdout += text;
      if (!options.onLine) return;
      // 按行切片：留最后一段不完整行到 partial，等下一个 chunk 拼接。
      partial += text;
      const lines: string[] = partial.split('\n');
      partial = lines.pop() ?? '';
      try {
        for (const line of lines) if (line.trim()) options.onLine(line.trim());
      } catch {
        stop('NATIVE_AGENT_FAILED');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (recordBytes(chunk)) stderr += chunk.toString('utf8');
    });
    child.once('error', () => {
      failure ??= new Error('NATIVE_AGENT_LAUNCH_FAILED');
      finish(-1);
    });
    child.once('close', (code: number | null) => {
      if (!failure && options.onLine) {
        // 进程关闭后冲掉 decoder 尾部与不完整行，保证回调不漏最后一行。
        partial += decoder.end();
        try {
          if (partial.trim()) options.onLine(partial.trim());
        } catch {
          failure = new Error('NATIVE_AGENT_FAILED');
        }
      }
      finish(code ?? -1);
    });
    // CLI 的参数/鉴权校验失败可能在我们写完 input 前就关闭 stdin：吞掉 EPIPE。
    child.stdin.on('error', () => undefined);
    if (options.signal?.aborted) cancel();
    child.stdin.end(options.input ?? '');
  });
}
