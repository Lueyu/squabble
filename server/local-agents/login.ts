import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LocalAgentProvider } from '../../shared/local-agents.interface';
import { nativeChildEnv } from './environment';
import { resolveTerminal, type NativeLaunch, type NativeResolverOptions } from './resolver';

function loginArgs(provider: LocalAgentProvider): string[] {
  if (provider === 'codex') return ['login'];
  if (provider === 'claude') return ['auth', 'login'];
  if (provider === 'gemini' || provider === 'antigravity') return [];
  if (provider === 'opencode') return ['auth', 'login'];
  if (provider === 'kimi') return ['login'];
  if (provider === 'doubao') return ['headless', 'login'];
  throw new Error('NATIVE_AGENT_UNSUPPORTED');
}
function posixQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function powershellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

/** Executable paths are discovered locally; login arguments come only from the fixed provider catalog. */
export function buildLoginCommand(provider: LocalAgentProvider, launch: NativeLaunch, platform: NodeJS.Platform): string {
  const args: string[] = [launch.executable, ...launch.prefixArgs, ...loginArgs(provider)];
  return platform === 'win32' ? `& ${args.map(powershellQuote).join(' ')}` : args.map(posixQuote).join(' ');
}

export async function launchNativeLogin(provider: LocalAgentProvider, launch: NativeLaunch, options: NativeResolverOptions = {}): Promise<void> {
  const platform: NodeJS.Platform = options.platform ?? process.platform;
  const source: NodeJS.ProcessEnv = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = nativeChildEnv(source);
  const cwd: string = options.home ?? homedir();
  let executable: string;
  let args: string[];
  if (platform === 'win32') {
    executable = join(source.SystemRoot ?? source.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!existsSync(executable)) throw new Error('NATIVE_LOGIN_TERMINAL_UNAVAILABLE');
    args = ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand',
      Buffer.from(buildLoginCommand(provider, launch, platform), 'utf16le').toString('base64')];
  } else if (platform === 'darwin') {
    executable = '/usr/bin/osascript';
    // Terminal may already be running with an old PATH. Forward only nonsecret identity paths.
    const paths: string[] = ['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME',
      'KIMI_CODE_HOME', 'DOUBAO_CLI_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']
      .filter((key) => env[key] !== undefined).map((key) => `${key}=${posixQuote(env[key] ?? '')}`);
    const command: string = `env ${paths.join(' ')} ${buildLoginCommand(provider, launch, platform)}`;
    args = ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`, '-e', 'tell application "Terminal" to activate'];
  } else {
    const candidates: Array<{ name: string; separator: string }> = [
      { name: 'x-terminal-emulator', separator: '-e' }, { name: 'gnome-terminal', separator: '--' },
      { name: 'konsole', separator: '-e' }, { name: 'xfce4-terminal', separator: '-x' }, { name: 'xterm', separator: '-e' },
    ];
    const terminal = candidates.map((candidate) => ({ ...candidate, path: resolveTerminal(candidate.name, options) })).find((candidate) => candidate.path);
    if (!terminal?.path) throw new Error('NATIVE_LOGIN_TERMINAL_UNAVAILABLE');
    executable = terminal.path;
    args = [terminal.separator, launch.executable, ...launch.prefixArgs, ...loginArgs(provider)];
  }
  await new Promise<void>((resolve, reject) => {
    const terminal = spawn(executable, args, { cwd, env, shell: false, detached: true, windowsHide: false, stdio: 'ignore' });
    terminal.once('error', () => reject(new Error('NATIVE_LOGIN_TERMINAL_UNAVAILABLE')));
    terminal.once('spawn', () => { terminal.unref(); resolve(); });
  });
}
