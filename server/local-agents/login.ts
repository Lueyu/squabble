/**
 * local-agents 登录桥接：在用户自己的终端里拉起 CLI 的登录流程。
 *
 * 职责边界：只负责"拼登录命令 + 选终端 + spawn 交互式终端"；登录状态本身
 * 由各 CLI（codex/claude/gemini/...）自己维护，本模块不读不写任何凭据。
 *
 * 上下游：import node:child_process/fs/os/path、shared 接口与同目录的
 * environment.ts（环境白名单）、resolver.ts（可执行文件定位）；被
 * native.ts 等上层桥接模块调用。
 *
 * 关键约定：登录参数只来自下方固定目录表（loginArgs），可执行文件路径一律
 * 本地探测；Windows 走 PowerShell -EncodedCommand（UTF-16LE base64，规避
 * 引号转义），macOS 走 osascript 驱动 Terminal.app，Linux 依次探测 5 个
 * 终端模拟器；进程 detached + unref，stdio 全部忽略。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LocalAgentProvider } from '../../shared/local-agents.interface';
import { nativeChildEnv } from './environment';
import { resolveTerminal, type NativeLaunch, type NativeResolverOptions } from './resolver';

/** 各 provider 的登录子命令目录表；未收录的 provider 直接拒绝。 */
function loginArgs(provider: LocalAgentProvider): string[] {
  if (provider === 'codex') return ['login'];
  if (provider === 'claude') return ['auth', 'login'];
  if (provider === 'gemini' || provider === 'antigravity') return [];
  if (provider === 'opencode') return ['auth', 'login'];
  if (provider === 'kimi') return ['login'];
  if (provider === 'doubao') return ['headless', 'login'];
  throw new Error('NATIVE_AGENT_UNSUPPORTED');
}
/** POSIX 单引号转义：内部的单引号拆成 '\'' 再拼回。 */
function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
/** PowerShell 单引号转义：内部的单引号翻倍。 */
function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 可执行路径来自本地探测；登录参数只来自上面固定的 provider 目录表。 */
export function buildLoginCommand(
  provider: LocalAgentProvider,
  launch: NativeLaunch,
  platform: NodeJS.Platform,
): string {
  const args: string[] = [launch.executable, ...launch.prefixArgs, ...loginArgs(provider)];
  return platform === 'win32'
    ? `& ${args.map(powershellQuote).join(' ')}`
    : args.map(posixQuote).join(' ');
}

/**
 * 拉起交互式登录：按平台选择终端宿主（Windows PowerShell / macOS Terminal /
 * Linux 桌面终端），spawn 后不等登录完成，spawn 成功即返回。
 */
export async function launchNativeLogin(
  provider: LocalAgentProvider,
  launch: NativeLaunch,
  options: NativeResolverOptions = {},
): Promise<void> {
  const platform: NodeJS.Platform = options.platform ?? process.platform;
  const source: NodeJS.ProcessEnv = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = nativeChildEnv(source);
  const cwd: string = options.home ?? homedir();
  let executable: string;
  let args: string[];
  if (platform === 'win32') {
    // Windows：命令整体编码后交给 PowerShell 执行（-NoExit 保持窗口不关）。
    executable = join(
      source.SystemRoot ?? source.SYSTEMROOT ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (!existsSync(executable)) throw new Error('NATIVE_LOGIN_TERMINAL_UNAVAILABLE');
    args = [
      '-NoLogo',
      '-NoProfile',
      '-NoExit',
      '-EncodedCommand',
      Buffer.from(buildLoginCommand(provider, launch, platform), 'utf16le').toString('base64'),
    ];
  } else if (platform === 'darwin') {
    executable = '/usr/bin/osascript';
    // 终端可能早已在跑且 PATH 已过期。只转发非机密的身份类变量。
    const paths: string[] = [
      'PATH',
      'HOME',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
      'GEMINI_CLI_HOME',
      'KIMI_CODE_HOME',
      'DOUBAO_CLI_CONFIG_DIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
    ]
      .filter((key) => env[key] !== undefined)
      .map((key) => `${key}=${posixQuote(env[key] ?? '')}`);
    const command: string = `env ${paths.join(' ')} ${buildLoginCommand(provider, launch, platform)}`;
    args = [
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(command)}`,
      '-e',
      'tell application "Terminal" to activate',
    ];
  } else {
    // Linux：按优先级探测常见终端模拟器，各家的"接命令"分隔符不同。
    const candidates: Array<{ name: string; separator: string }> = [
      { name: 'x-terminal-emulator', separator: '-e' },
      { name: 'gnome-terminal', separator: '--' },
      { name: 'konsole', separator: '-e' },
      { name: 'xfce4-terminal', separator: '-x' },
      { name: 'xterm', separator: '-e' },
    ];
    const terminal = candidates
      .map((candidate) => ({ ...candidate, path: resolveTerminal(candidate.name, options) }))
      .find((candidate) => candidate.path);
    if (!terminal?.path) throw new Error('NATIVE_LOGIN_TERMINAL_UNAVAILABLE');
    executable = terminal.path;
    args = [terminal.separator, launch.executable, ...launch.prefixArgs, ...loginArgs(provider)];
  }
  // spawn 后只在 'spawn' 成功或 'error' 时结算；不等待用户完成登录。
  await new Promise<void>((resolve, reject) => {
    const terminal = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    terminal.once('error', () => reject(new Error('NATIVE_LOGIN_TERMINAL_UNAVAILABLE')));
    terminal.once('spawn', () => {
      terminal.unref();
      resolve();
    });
  });
}
