/**
 * local-agents 运行时门面：检测、登录、运行三种能力的统一入口。
 *
 * 职责边界：编排各 provider 的探测/登录/执行流程（复用 resolver、process、
 * workspace、tool-bridge、tool-config、research、events、doubao）；不做单
 * 项职责的实现。无外部依赖，API 进程与本地伴生进程共用同一运行时。
 *
 * 上下游：import node:os、shared 接口/目录与 local-agents 内部模块；
 * 被 server/modules/agent 桥接层调用（底部导出默认 runtime 的三个方法）。
 *
 * 关键约定：探测（probe）超时 authTimeoutMs 默认 8s、输出上限 1MiB；正式
 * 运行超时 runTimeoutMs 默认 10min、输出上限 4MiB；prompt 非空且 <= 256KiB
 * （UTF-8 字节）；commandResolver 仅作离线子进程 fixture 的依赖缝，绝不
 * 通过 HTTP 接受；工具桥/工作区在 finally 中保证释放（先关 bridge 再清
 * workspace）。
 */
import { homedir } from 'node:os';
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
  type NativeAgentConfiguration,
  type NativeAgentStatus,
} from '../../shared/local-agents.interface';
import { providerCatalog } from '../../shared/local-agent-catalog';
import { nativeChildEnv } from './environment';
import { NativeEventCollector } from './events';
import { launchNativeLogin } from './login';
import { executeNativeProcess, type NativeProcessResult } from './process';
import { resolveNativeCommand, type NativeLaunch, type NativeResolverOptions } from './resolver';
import { createNativeWorkspace } from './workspace';
import {
  authenticationState,
  configuredModels,
  defaultCapabilities,
  geminiMetadata,
  kimiCredentialEnv,
  kimiMetadata,
  parseModels,
  supportsAntigravity,
} from './metadata';
import { normalizedConfiguration, researchInvocation, type NativeProbe } from './research';
import { runDoubao } from './doubao';
import type { ResearchActivity } from '../../shared/research-events.interface';
import type { ResearchToolCapability } from '../../shared/research-tools.interface';
import {
  createResearchToolBridge,
  type NativeResearchTools,
  type ResearchToolBridge,
} from './tool-bridge';
import {
  injectResearchTools,
  isolateCodexResearch,
  researchSnapshotPrompt,
  researchToolCapability,
} from './tool-config';

export interface NativeRunOptions {
  root: string;
  signal: AbortSignal;
  onProgress: (text: string) => void;
  agentSettings?: NativeAgentConfiguration;
  researchTools?: NativeResearchTools;
  onEvent?: (event: ResearchActivity) => void;
}
export interface NativeRuntimeOptions extends NativeResolverOptions {
  authTimeoutMs?: number;
  runTimeoutMs?: number;
  maxOutputBytes?: number;
  /** 离线子进程 fixture 的内部依赖缝，绝不通过 HTTP 接受。 */
  commandResolver?: (
    provider: LocalAgentProvider,
    options: NativeResolverOptions,
  ) => NativeLaunch | null;
}

/** API 进程与本地伴生进程共用的无依赖运行时。 */
export function createNativeRuntime(options: NativeRuntimeOptions = {}) {
  // 子进程环境：白名单继承 + kimi 额外转发其显式声明的凭据变量。
  const env = (provider?: LocalAgentProvider, model?: string): NodeJS.ProcessEnv => ({
    ...nativeChildEnv(options.env ?? process.env),
    ...(provider === 'kimi' ? kimiCredentialEnv(options, model) : {}),
  });
  const resolveCommand = (provider: LocalAgentProvider): NativeLaunch | null =>
    (options.commandResolver ?? resolveNativeCommand)(provider, options);
  // 命令解析失败分两种错误码：provider 不认识 vs 本机未安装。
  const command = (provider: LocalAgentProvider): NativeLaunch => {
    if (!LOCAL_AGENT_PROVIDERS.includes(provider)) throw new Error('NATIVE_AGENT_UNSUPPORTED');
    const launch: NativeLaunch | null = resolveCommand(provider);
    if (!launch) throw new Error('NATIVE_AGENT_NOT_INSTALLED');
    return launch;
  };
  // 短命探针（--version/doctor/auth status 等）：8s 超时、1MiB 输出上限。
  const probeFor =
    (launch: NativeLaunch, provider: LocalAgentProvider, model?: string): NativeProbe =>
    (args, context): Promise<NativeProcessResult> =>
      executeNativeProcess(launch, args, {
        cwd: context?.cwd ?? options.home ?? homedir(),
        env: context?.env ?? env(provider, model),
        signal: context?.signal,
        timeoutMs: options.authTimeoutMs ?? 8000,
        maxOutputBytes: 1024 * 1024,
      });
  return {
    /** 逐 provider 探测：安装/版本/登录状态/模型清单/研究工具能力。 */
    async detectNativeAgents(): Promise<NativeAgentStatus[]> {
      return Promise.all(
        LOCAL_AGENT_PROVIDERS.map(
          async (provider: LocalAgentProvider): Promise<NativeAgentStatus> => {
            // 基线状态：目录信息 + 出厂能力 + not_installed。
            const status: NativeAgentStatus = {
              ...providerCatalog[provider],
              ...defaultCapabilities(provider),
              state: 'not_installed',
              researchTools: researchToolCapability(provider),
            };
            const launch: NativeLaunch | null = resolveCommand(provider);
            if (!launch) return status;
            const probe: NativeProbe = probeFor(launch, provider);
            try {
              const version = await probe(['--version']);
              if (version.code !== 0) {
                status.state = 'error';
                return status;
              }
              // 版本行只在"短且含数字版本号且无控制字符"时采信。
              const line: string = version.stdout.trim().split(/\r?\n/)[0] ?? '';
              if (line.length <= 120 && /\d+\.\d+/u.test(line) && !/[\u0000-\u001f]/u.test(line))
                status.version = line;
              status.researchTools = researchToolCapability(provider, status.version);
              // 各 provider 的差异探测分支。
              if (provider === 'gemini') Object.assign(status, geminiMetadata(options));
              else if (provider === 'kimi') {
                // kimi：doctor config 探活 + 本地 config.toml 元数据。
                const doctor = await probe(['doctor', 'config']);
                const metadata = kimiMetadata(options);
                status.models = metadata.models;
                status.state = doctor.code === 0 ? metadata.state : 'error';
              } else if (provider === 'antigravity') {
                if (!supportsAntigravity(version.stdout)) {
                  status.state = 'error';
                  return status;
                }
                const auth = await probe(['-p', '/usage', '--output-format', 'json']);
                const models = await probe(['--output-format', 'json', 'models']);
                status.models = parseModels(provider, models.stdout);
                status.state =
                  auth.code === 0 && models.code === 0 && status.models.length > 0
                    ? 'ready'
                    : authenticationState(provider, auth);
              } else {
                // 其余 provider：按各自协议探测登录状态。
                const auth = await probe(
                  provider === 'codex'
                    ? ['login', 'status']
                    : provider === 'doubao'
                      ? ['headless', 'status', '--json']
                      : provider === 'opencode'
                        ? ['auth', 'list']
                        : ['auth', 'status'],
                );
                status.state = authenticationState(provider, auth);
                if (provider === 'codex' || provider === 'claude')
                  status.models = configuredModels(provider, options);
                // 已就绪的 doubao/opencode 再拉实时模型清单。
                if (
                  status.state === 'ready' &&
                  (provider === 'doubao' || provider === 'opencode')
                ) {
                  const models = await probe(
                    provider === 'doubao'
                      ? ['headless', 'models', '--json']
                      : ['models', '--verbose'],
                  );
                  if (models.code === 0) status.models = parseModels(provider, models.stdout);
                }
              }
            } catch {
              status.state = 'error';
            }
            return status;
          },
        ),
      );
    },
    /** 打开原生登录流程（终端窗口）。 */
    async openNativeLogin(provider: LocalAgentProvider): Promise<void> {
      await launchNativeLogin(provider, command(provider), options);
    },
    /**
     * 执行一次 native agent 调用：构造一次性 workspace → 视能力注入研究
     * 工具（MCP 桥或快照隔离）→ 执行进程 → 采集结果。bridge 与 workspace
     * 在 finally 中保证释放。
     */
    async runNativeAgent(
      provider: LocalAgentProvider,
      prompt: string,
      run: NativeRunOptions,
    ): Promise<{ text: string; usageTokens: number | null }> {
      if (run.signal.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
      if (!prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 256 * 1024)
        throw new Error('NATIVE_AGENT_INVALID_PROMPT');
      const settings: NativeAgentConfiguration = normalizedConfiguration(run.agentSettings);
      const launch: NativeLaunch = command(provider);
      const workspace = await createNativeWorkspace(run.root);
      let bridge: ResearchToolBridge | undefined;
      try {
        const probe: NativeProbe = probeFor(launch, provider, settings.model);
        // 研究工具仅在快照或工具清单非空时启用。
        const tools =
          run.researchTools &&
          (run.researchTools.snapshot.trim() || run.researchTools.descriptors.length)
            ? run.researchTools
            : undefined;
        let capability: ResearchToolCapability = researchToolCapability(provider);
        if (tools) {
          // 有工具时先探测真实版本再判定 MCP 能力；探测失败不阻断主流程。
          try {
            const version = await probe(['--version'], { signal: run.signal });
            capability = researchToolCapability(
              provider,
              version.code === 0 ? version.stdout.trim() : undefined,
            );
          } catch {
            if (run.signal.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
          }
        }
        // 构造调用参数：有快照时把证据 JSON 以"引用文本"姿势拼进 prompt。
        let invocation = await researchInvocation(
          provider,
          tools ? researchSnapshotPrompt(prompt, tools.snapshot) : prompt,
          settings,
          workspace.cwd,
          env(provider, settings.model),
          options,
          probe,
        );
        if (tools && capability.mode === 'mcp' && tools.descriptors.length) {
          // MCP 路径：起任务级工具桥并注入 CLI；注入失败关桥并统一报隔离失败。
          bridge = await createResearchToolBridge(tools, run.signal);
          try {
            invocation = await injectResearchTools(
              provider,
              invocation,
              bridge,
              tools.descriptors.map((tool) => tool.name),
              probe,
              workspace.cwd,
              run.signal,
            );
          } catch {
            await bridge.close();
            bridge = undefined;
            if (run.signal.aborted) throw new Error('NATIVE_AGENT_CANCELLED');
            throw new Error('NATIVE_AGENT_TOOL_ISOLATION_FAILED');
          }
        }
        if (tools && provider === 'codex' && !bridge) {
          // codex 无 MCP 时也要做隔离（禁用其既有 server/插件/hooks）。
          try {
            invocation = await isolateCodexResearch(invocation, probe, workspace.cwd, run.signal);
          } catch {
            throw new Error(
              run.signal.aborted ? 'NATIVE_AGENT_CANCELLED' : 'NATIVE_AGENT_TOOL_ISOLATION_FAILED',
            );
          }
        }
        // 对外播报本次任务的研究工具能力（MCP 可用 or 快照降级原因）。
        if (tools)
          run.onEvent?.({
            id: `${provider}-research-capability`,
            kind: 'capability',
            status: bridge ? 'succeeded' : 'unavailable',
            at: new Date().toISOString(),
            summary: bridge
              ? 'Task-scoped research tools available'
              : capability.reason === 'version_unsupported'
                ? 'CLI version is not verified for research tools; using read-only evidence snapshot'
                : 'Isolated research tools are not available for this runtime; using read-only evidence snapshot',
          });
        // 正式运行：10min 超时、4MiB 输出上限、带 abort signal。
        const processOptions = {
          cwd: workspace.cwd,
          env: invocation.env,
          input: invocation.input,
          signal: run.signal,
          timeoutMs: options.runTimeoutMs ?? 10 * 60 * 1000,
          maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
        };
        // doubao 是远端任务协议，走专用三段式（ACK→wait→stop）。
        if (provider === 'doubao')
          return await runDoubao(
            launch,
            invocation.args,
            processOptions,
            run.root,
            run.onProgress,
            run.onEvent,
          );
        // 其余 provider：stdout 逐行喂事件采集器，零退出码 + 终态消息才算成功。
        const collector: NativeEventCollector = new NativeEventCollector(
          provider,
          run.onProgress,
          run.onEvent,
        );
        const result = await executeNativeProcess(launch, invocation.args, {
          ...processOptions,
          onLine: (line: string) => collector.read(line),
        });
        if (result.code !== 0) throw new Error('NATIVE_AGENT_FAILED');
        collector.completeProcess();
        return collector.result();
      } finally {
        // 释放顺序：先关工具桥（中断在途调用），再清一次性 workspace。
        try {
          await bridge?.close();
        } finally {
          await workspace.dispose();
        }
      }
    },
  };
}

/** 模块级默认 runtime：进程内共享一份配置探测结果。 */
const runtime = createNativeRuntime();
export const detectNativeAgents = runtime.detectNativeAgents;
export const openNativeLogin = runtime.openNativeLogin;
export const runNativeAgent = runtime.runNativeAgent;
