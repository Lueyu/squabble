import { homedir } from 'node:os';
import { LOCAL_AGENT_PROVIDERS, type LocalAgentProvider, type NativeAgentConfiguration, type NativeAgentStatus } from '../../shared/local-agents.interface';
import { providerCatalog } from '../../shared/local-agent-catalog';
import { nativeChildEnv } from './environment';
import { NativeEventCollector } from './events';
import { launchNativeLogin } from './login';
import { executeNativeProcess, type NativeProcessResult } from './process';
import { resolveNativeCommand, type NativeLaunch, type NativeResolverOptions } from './resolver';
import { createNativeWorkspace } from './workspace';
import { authenticationState, configuredModels, defaultCapabilities, geminiMetadata, kimiCredentialEnv, kimiMetadata, parseModels, supportsAntigravity } from './metadata';
import { normalizedConfiguration, researchInvocation, type NativeProbe } from './research';
import { runDoubao } from './doubao';

export interface NativeRunOptions {
  root: string; signal: AbortSignal; onProgress: (text: string) => void; agentSettings?: NativeAgentConfiguration;
}
export interface NativeRuntimeOptions extends NativeResolverOptions {
  authTimeoutMs?: number; runTimeoutMs?: number; maxOutputBytes?: number;
  /** Internal dependency seam for offline subprocess fixtures, never accepted over HTTP. */
  commandResolver?: (provider: LocalAgentProvider, options: NativeResolverOptions) => NativeLaunch | null;
}

/** Dependency-free runtime shared by the API process and the paired local companion. */
export function createNativeRuntime(options: NativeRuntimeOptions = {}) {
  const env = (provider?: LocalAgentProvider, model?: string): NodeJS.ProcessEnv => ({ ...nativeChildEnv(options.env ?? process.env),
    ...(provider === 'kimi' ? kimiCredentialEnv(options, model) : {}) });
  const resolveCommand = (provider: LocalAgentProvider): NativeLaunch | null => (options.commandResolver ?? resolveNativeCommand)(provider, options);
  const command = (provider: LocalAgentProvider): NativeLaunch => {
    if (!LOCAL_AGENT_PROVIDERS.includes(provider)) throw new Error('NATIVE_AGENT_UNSUPPORTED');
    const launch: NativeLaunch | null = resolveCommand(provider);
    if (!launch) throw new Error('NATIVE_AGENT_NOT_INSTALLED');
    return launch;
  };
  const probeFor = (launch: NativeLaunch, provider: LocalAgentProvider, model?: string): NativeProbe => (args: string[]): Promise<NativeProcessResult> => executeNativeProcess(launch, args, {
    cwd: options.home ?? homedir(), env: env(provider, model), timeoutMs: options.authTimeoutMs ?? 8000, maxOutputBytes: 1024 * 1024,
  });
  return {
    async detectNativeAgents(): Promise<NativeAgentStatus[]> {
      return Promise.all(LOCAL_AGENT_PROVIDERS.map(async (provider: LocalAgentProvider): Promise<NativeAgentStatus> => {
        const status: NativeAgentStatus = { ...providerCatalog[provider], ...defaultCapabilities(provider), state: 'not_installed' };
        const launch: NativeLaunch | null = resolveCommand(provider);
        if (!launch) return status;
        const probe: NativeProbe = probeFor(launch, provider);
        try {
          const version = await probe(['--version']);
          if (version.code !== 0) { status.state = 'error'; return status; }
          const line: string = version.stdout.trim().split(/\r?\n/)[0] ?? '';
          if (line.length <= 120 && /\d+\.\d+/u.test(line) && !/[\u0000-\u001f]/u.test(line)) status.version = line;
          if (provider === 'gemini') Object.assign(status, geminiMetadata(options));
          else if (provider === 'kimi') {
            const doctor = await probe(['doctor', 'config']);
            const metadata = kimiMetadata(options);
            status.models = metadata.models; status.state = doctor.code === 0 ? metadata.state : 'error';
          } else if (provider === 'antigravity') {
            if (!supportsAntigravity(version.stdout)) { status.state = 'error'; return status; }
            const auth = await probe(['-p', '/usage', '--output-format', 'json']);
            const models = await probe(['--output-format', 'json', 'models']);
            status.models = parseModels(provider, models.stdout);
            status.state = auth.code === 0 && models.code === 0 && status.models.length > 0 ? 'ready' : authenticationState(provider, auth);
          } else {
            const auth = await probe(provider === 'codex' ? ['login', 'status'] : provider === 'doubao' ? ['headless', 'status', '--json']
              : provider === 'opencode' ? ['auth', 'list'] : ['auth', 'status']);
            status.state = authenticationState(provider, auth);
            if (provider === 'codex' || provider === 'claude') status.models = configuredModels(provider, options);
            if (status.state === 'ready' && (provider === 'doubao' || provider === 'opencode')) {
              const models = await probe(provider === 'doubao' ? ['headless', 'models', '--json'] : ['models', '--verbose']);
              if (models.code === 0) status.models = parseModels(provider, models.stdout);
            }
          }
        } catch { status.state = 'error'; }
        return status;
      }));
    },
    async openNativeLogin(provider: LocalAgentProvider): Promise<void> {
      await launchNativeLogin(provider, command(provider), options);
    },
    async runNativeAgent(provider: LocalAgentProvider, prompt: string, run: NativeRunOptions): Promise<{ text: string; usageTokens: number | null }> {
      if (run.signal.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
      if (!prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 256 * 1024) throw new Error('NATIVE_AGENT_INVALID_PROMPT');
      const settings: NativeAgentConfiguration = normalizedConfiguration(run.agentSettings);
      const launch: NativeLaunch = command(provider);
      const workspace = await createNativeWorkspace(run.root);
      try {
        const invocation = await researchInvocation(provider, prompt, settings, workspace.cwd, env(provider, settings.model), options, probeFor(launch, provider, settings.model));
        const processOptions = { cwd: workspace.cwd, env: invocation.env, input: invocation.input, signal: run.signal,
          timeoutMs: options.runTimeoutMs ?? 10 * 60 * 1000, maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024 };
        if (provider === 'doubao') return await runDoubao(launch, invocation.args, processOptions, run.root, run.onProgress);
        const collector: NativeEventCollector = new NativeEventCollector(provider, run.onProgress);
        const result = await executeNativeProcess(launch, invocation.args, { ...processOptions, onLine: (line: string) => collector.read(line) });
        if (result.code !== 0) throw new Error('NATIVE_AGENT_FAILED');
        collector.completeProcess();
        return collector.result();
      } finally { await workspace.dispose(); }
    },
  };
}

const runtime = createNativeRuntime();
export const detectNativeAgents = runtime.detectNativeAgents;
export const openNativeLogin = runtime.openNativeLogin;
export const runNativeAgent = runtime.runNativeAgent;
