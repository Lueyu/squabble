import { homedir } from 'node:os';
import type { LocalAgentProvider, NativeAgentStatus } from '../../shared/local-agents.interface';
import { nativeChildEnv } from './environment';
import { NativeEventCollector } from './events';
import { launchNativeLogin } from './login';
import { executeNativeProcess, type NativeProcessResult } from './process';
import { resolveNativeCommand, type NativeLaunch, type NativeResolverOptions } from './resolver';
import { createNativeWorkspace } from './workspace';

export interface NativeRunOptions { root: string; signal: AbortSignal; onProgress: (text: string) => void }
export interface NativeRuntimeOptions extends NativeResolverOptions {
  authTimeoutMs?: number;
  runTimeoutMs?: number;
  maxOutputBytes?: number;
}
const CATALOG: Record<LocalAgentProvider, Pick<NativeAgentStatus, 'name' | 'loginCommand' | 'installUrl'>> = {
  codex: { name: 'Codex', loginCommand: 'codex login', installUrl: 'https://developers.openai.com/codex/cli/' },
  claude: { name: 'Claude Code', loginCommand: 'claude auth login', installUrl: 'https://code.claude.com/docs/en/setup' },
};

function authState(provider: LocalAgentProvider, result: NativeProcessResult): NativeAgentStatus['state'] {
  if (provider === 'codex') {
    if (result.code === 0) return 'ready';
    return /not logged in|not authenticated|login required/i.test(`${result.stdout}\n${result.stderr}`) ? 'login_required' : 'error';
  }
  for (const line of [result.stdout.trim(), ...result.stdout.split(/\r?\n/).reverse()]) {
    try {
      const status: { loggedIn?: boolean } = JSON.parse(line);
      if (status.loggedIn === true && result.code === 0) return 'ready';
      if (status.loggedIn === false && (result.code === 0 || result.code === 1)) return 'login_required';
    } catch { /* Native CLI warnings can precede the JSON status. */ }
  }
  return 'error';
}

function researchArgs(provider: LocalAgentProvider): string[] {
  if (provider === 'codex') return ['--search', '--ask-for-approval', 'never', 'exec', '--json', '--sandbox', 'read-only',
    '--ephemeral', '--skip-git-repo-check', '-'];
  return ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--tools', 'WebSearch,WebFetch,Read,Glob,Grep', '--allowedTools', 'WebSearch,WebFetch,Read,Glob,Grep',
    '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--settings', '{"disableAllHooks":true}'];
}

/** Dependency-free runtime shared by the API process and the paired local companion. */
export function createNativeRuntime(options: NativeRuntimeOptions = {}) {
  const env = (): NodeJS.ProcessEnv => nativeChildEnv(options.env ?? process.env);
  const command = (provider: LocalAgentProvider): NativeLaunch => {
    const launch: NativeLaunch | null = resolveNativeCommand(provider, options);
    if (!launch) throw new Error('NATIVE_AGENT_NOT_INSTALLED');
    return launch;
  };
  return {
    async detectNativeAgents(): Promise<NativeAgentStatus[]> {
      return Promise.all((['codex', 'claude'] as const).map(async (provider): Promise<NativeAgentStatus> => {
        const status: NativeAgentStatus = { provider, ...CATALOG[provider], state: 'not_installed' };
        const launch: NativeLaunch | null = resolveNativeCommand(provider, options);
        if (!launch) return status;
        const probe = (args: string[]) => executeNativeProcess(launch, args, {
          cwd: options.home ?? homedir(), env: env(), timeoutMs: options.authTimeoutMs ?? 8000, maxOutputBytes: 64 * 1024,
        });
        const [version, auth] = await Promise.allSettled([
          probe(['--version']), probe(provider === 'codex' ? ['login', 'status'] : ['auth', 'status']),
        ]);
        if (version.status === 'fulfilled' && version.value.code === 0) {
          const line: string = version.value.stdout.trim().split(/\r?\n/)[0] ?? '';
          if (line.length <= 120 && /\d+\.\d+/.test(line) && !/[\u0000-\u001f]/.test(line)) status.version = line;
        }
        status.state = auth.status === 'fulfilled' ? authState(provider, auth.value) : 'error';
        return status;
      }));
    },
    async openNativeLogin(provider: LocalAgentProvider): Promise<void> {
      await launchNativeLogin(provider, command(provider), options);
    },
    async runNativeAgent(provider: LocalAgentProvider, prompt: string, run: NativeRunOptions): Promise<{ text: string; usageTokens: number | null }> {
      if (run.signal.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
      if (!prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 256 * 1024) throw new Error('NATIVE_AGENT_INVALID_PROMPT');
      const launch: NativeLaunch = command(provider);
      const collector: NativeEventCollector = new NativeEventCollector(provider, run.onProgress);
      const workspace = await createNativeWorkspace(run.root);
      try {
        const result: NativeProcessResult = await executeNativeProcess(launch, researchArgs(provider), {
          cwd: workspace.cwd, env: env(), input: prompt, signal: run.signal,
          timeoutMs: options.runTimeoutMs ?? 10 * 60 * 1000, maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
          onLine: (line: string) => collector.read(line),
        });
        if (result.code !== 0) throw new Error('NATIVE_AGENT_FAILED');
        return collector.result();
      } finally { await workspace.dispose(); }
    },
  };
}

const runtime = createNativeRuntime();
export const detectNativeAgents = runtime.detectNativeAgents;
export const openNativeLogin = runtime.openNativeLogin;
export const runNativeAgent = runtime.runNativeAgent;
