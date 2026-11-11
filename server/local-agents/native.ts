import { homedir } from 'node:os';
import { LOCAL_AGENT_PROVIDERS, type LocalAgentProvider, type NativeAgentConfiguration, type NativeAgentStatus } from '../../shared/local-agents.interface';
import { providerCatalog } from '../../shared/local-agent-catalog';
import { nativeChildEnv } from './environment';
import { NativeEventCollector } from './events';
import { launchNativeLogin } from './login';
import { executeNativeProcess, NativeProcessFailure, type NativeProcessResult } from './process';
import { readOpenCodeDiagnostic, detectNetworkFailure, safeExecutionFailure } from './failures';
import { resolveNativeCommand, type NativeLaunch, type NativeResolverOptions } from './resolver';
import { createNativeWorkspace } from './workspace';
import { authenticationState, configuredModels, configuredDefaultModel, defaultCapabilities, geminiMetadata, kimiCredentialEnv, kimiMetadata, parseModels, supportsAntigravity } from './metadata';
import { normalizedConfiguration, researchInvocation, type NativeProbe } from './research';
import { runDoubao } from './doubao';
import type { ResearchActivity } from '../../shared/research-events.interface';
import type { ResearchToolCapability } from '../../shared/research-tools.interface';
import { createResearchToolBridge, type NativeResearchTools, type ResearchToolBridge } from './tool-bridge';
import { injectResearchTools, isolateCodexResearch, researchSnapshotPrompt, researchToolCapability } from './tool-config';
import type { NativeAgentImage } from '../../shared/native-image.interface';
import { attachNativeImage, nativeImageCapability, validateNativeImage } from './native-image';
import type { NativeDiagnosticEvent } from '../../shared/local-agent-diagnostics.interface';
import { diagnostic, observe } from './diagnostics';

export interface NativeRunOptions {
  root: string; signal: AbortSignal; onProgress: (text: string) => void; agentSettings?: NativeAgentConfiguration;
  researchTools?: NativeResearchTools;
  image?: NativeAgentImage;
  onEvent?: (event: ResearchActivity) => void;
  onDiagnostic?: (event: NativeDiagnosticEvent) => void;
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
  const probeFor = (launch: NativeLaunch, provider: LocalAgentProvider, model?: string): NativeProbe => (args, context): Promise<NativeProcessResult> => executeNativeProcess(launch, args, {
    cwd: context?.cwd ?? options.home ?? homedir(), env: context?.env ?? env(provider, model), signal: context?.signal,
    timeoutMs: options.authTimeoutMs ?? 8000, maxOutputBytes: 1024 * 1024,
  });
  return {
    async detectNativeAgents(): Promise<NativeAgentStatus[]> {
      return Promise.all(LOCAL_AGENT_PROVIDERS.map(async (provider: LocalAgentProvider): Promise<NativeAgentStatus> => {
        const status: NativeAgentStatus = { ...providerCatalog[provider], ...defaultCapabilities(provider), state: 'not_installed',
          defaultModel: configuredDefaultModel(provider, options),
          researchTools: researchToolCapability(provider), imageInput: nativeImageCapability(provider) };
        const launch: NativeLaunch | null = resolveCommand(provider);
        if (!launch) return status;
        const probe: NativeProbe = probeFor(launch, provider);
        try {
          const version = await probe(['--version']);
          if (version.code !== 0) { status.state = 'error'; return status; }
          const line: string = version.stdout.trim().split(/\r?\n/)[0] ?? '';
          if (line.length <= 120 && /\d+\.\d+/u.test(line) && !/[\u0000-\u001f]/u.test(line)) status.version = line;
          status.researchTools = researchToolCapability(provider, status.version);
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
      let preflight = true;
      let workspace: Awaited<ReturnType<typeof createNativeWorkspace>> | undefined;
      let collector: NativeEventCollector | undefined;
      let terminalEvent = false;
      let outputSeen = false;
      const evidence: { exitCode?: number; outputBytes?: number; stderrBytes?: number } = {};
      diagnostic(run.onDiagnostic, { stage: 'preflight', status: 'running' });
      let bridge: ResearchToolBridge | undefined;
      try {
        if (run.signal.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
        if (!prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 256 * 1024) throw new Error('NATIVE_AGENT_INVALID_PROMPT');
        const image = run.image === undefined ? undefined : validateNativeImage(run.image);
        if (image && !nativeImageCapability(provider)) throw new Error('NATIVE_AGENT_IMAGE_UNSUPPORTED');
        const settings: NativeAgentConfiguration = normalizedConfiguration(run.agentSettings);
        const launch: NativeLaunch = command(provider);
        workspace = await createNativeWorkspace(run.root);
        const probe: NativeProbe = probeFor(launch, provider, settings.model);
        const tools = !image && run.researchTools && (run.researchTools.snapshot.trim() || run.researchTools.descriptors.length) ? run.researchTools : undefined;
        let capability: ResearchToolCapability = researchToolCapability(provider);
        if (tools) {
          try {
            const version = await probe(['--version'], { signal: run.signal });
            capability = researchToolCapability(provider, version.code === 0 ? version.stdout.trim() : undefined);
          } catch { if (run.signal.aborted) throw new Error('NATIVE_AGENT_CANCELLED'); }
        }
        let invocation = await researchInvocation(provider, tools ? researchSnapshotPrompt(prompt, tools.snapshot) : prompt,
          settings, workspace.cwd, env(provider, settings.model), options, probe);
        if (image) invocation = await attachNativeImage(provider, invocation, image, workspace.cwd);
        if (tools && capability.mode === 'mcp' && tools.descriptors.length) {
          bridge = await createResearchToolBridge(tools, run.signal);
          try { invocation = await injectResearchTools(provider, invocation, bridge, tools.descriptors.map(tool => tool.name), probe, workspace.cwd, run.signal); }
          catch {
            await bridge.close(); bridge = undefined;
            if (run.signal.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
            throw new Error('NATIVE_AGENT_TOOL_ISOLATION_FAILED');
          }
        }
        if (provider === 'codex' && !bridge) {
          try { invocation = await isolateCodexResearch(invocation, probe, workspace.cwd, run.signal); }
          catch { throw new Error(run.signal.aborted ? 'NATIVE_AGENT_CANCELLED' : 'NATIVE_AGENT_TOOL_ISOLATION_FAILED'); }
        }
        if (tools) observe(run.onEvent, { id: `${provider}-research-capability`, kind: 'capability',
          status: bridge ? 'succeeded' : 'unavailable', at: new Date().toISOString(),
          summary: bridge ? 'Task-scoped research tools available' : capability.reason === 'version_unsupported'
            ? 'CLI version is not verified for research tools; using read-only evidence snapshot'
            : 'Isolated research tools are not available for this runtime; using read-only evidence snapshot' });
        diagnostic(run.onDiagnostic, { stage: 'preflight', status: 'succeeded' });
        preflight = false;
        const processOptions = { cwd: workspace.cwd, env: invocation.env, input: invocation.input, signal: run.signal,
          timeoutMs: options.runTimeoutMs ?? 10 * 60 * 1000, maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
          onDiagnostic: (event: NativeDiagnosticEvent) => {
            if (event.stage === 'output') { if (outputSeen) return; outputSeen = true; }
            if (event.stage === 'process' && event.status !== 'running') {
              evidence.exitCode = event.exitCode;
              evidence.outputBytes = (evidence.outputBytes ?? 0) + (event.outputBytes ?? 0);
              evidence.stderrBytes = (evidence.stderrBytes ?? 0) + (event.stderrBytes ?? 0);
            }
            observe(run.onDiagnostic, event);
          } };
        if (provider === 'doubao') {
          const result = await runDoubao(launch, invocation.args, processOptions, run.root,
            text => observe(run.onProgress, text), event => observe(run.onEvent, event));
          terminalEvent = true;
          diagnostic(run.onDiagnostic, { stage: 'result', status: 'succeeded', ...evidence, terminalEvent });
          return result;
        }
        collector = new NativeEventCollector(provider, run.onProgress, run.onEvent);
        const result = await executeNativeProcess(launch, invocation.args, { ...processOptions, onLine: (line: string) => collector.read(line),
          ...(provider === 'opencode' ? { onStderrLine: readOpenCodeDiagnostic } : {}) });
        if (result.code !== 0) {
          const networkCode = detectNetworkFailure(result);
          throw new NativeProcessFailure(networkCode ?? 'NATIVE_AGENT_FAILED', result);
        }
        collector.completeProcess();
        const value = collector.result();
        diagnostic(run.onDiagnostic, { stage: 'result', status: 'succeeded', ...evidence, terminalEvent: collector.terminalEvent });
        return value;
      } catch (error) {
        const failure = { ...safeExecutionFailure(error, preflight ? 'preflight' : 'runtime'), ...evidence,
          ...(!preflight ? { terminalEvent: collector?.terminalEvent ?? terminalEvent } : {}) };
        diagnostic(run.onDiagnostic, { stage: preflight ? 'preflight' : 'result',
          status: run.signal.aborted ? 'cancelled' : 'failed', code: failure.code, ...evidence,
          ...(!preflight ? { terminalEvent: failure.terminalEvent } : {}) });
        throw Object.assign(error instanceof Error ? error : new Error('NATIVE_AGENT_FAILED'), { failure });
      } finally { try { await bridge?.close(); } finally { await workspace?.dispose(); } }
    },
  };
}

const runtime = createNativeRuntime();
export const detectNativeAgents = runtime.detectNativeAgents;
export const openNativeLogin = runtime.openNativeLogin;
export const runNativeAgent = runtime.runNativeAgent;
