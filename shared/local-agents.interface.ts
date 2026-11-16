/**
 * local-agents.interface.ts — 本地 CLI 代理与 companion 进程的公共契约。
 *
 * 职责边界：
 *  - 本地代理侧：固定提供商目录（LOCAL_AGENT_PROVIDERS）、各提供商的原生状态
 *    （NativeAgentStatus / NativeAgentState / NativeAgentModel）与连接汇总（LocalAgentsStatus /
 *    LocalAgentConnection）。
 *  - companion 侧：外部 companion 设备与服务器之间的轮询协议——配对（LocalAgentPairing）、
 *    下行命令（CompanionCommand）、上行更新（CompanionUpdate）与轮询信封
 *    （CompanionPoll / CompanionPollResult）。
 *  - 安全边界：native 运行时从固定目录选择提供商，客户端永不提供可执行文件路径；
 *    companion 使用可撤销的设备凭据（Bearer），不复用用户浏览器会话。
 * 上下游：
 *  - 上游：server/modules/local-agents/*（companion.controller.ts 轮询协议的服务端实现）
 *    与 client/src 代理设置界面，共 24 个文件 import 本契约（server 19、client 3、shared 内 2）。
 *  - 下游：import type ResearchActivity（research-events.interface.ts）与
 *    ResearchToolBundle / ResearchToolCapability（research-tools.interface.ts）。
 * 关键约定：
 *  - CompanionUpdate.error 为固定错误码集合（LOCAL_*），客户端据此提示。
 *  - usageTokens：companion 本地运行产生的 token 数，可能为 null（用量未知）。
 */

import type { ResearchActivity } from './research-events.interface';
import type { ResearchToolBundle, ResearchToolCapability } from './research-tools.interface';

/** 本地代理提供商固定目录：客户端永不提供可执行文件路径，只能从这里选择。 */
export const LOCAL_AGENT_PROVIDERS = [
  'codex',
  'claude',
  'gemini',
  'antigravity',
  'opencode',
  'kimi',
  'doubao',
] as const;
/** 提供商标识的联合类型（由 LOCAL_AGENT_PROVIDERS 推导，二者必须同步维护）。 */
export type LocalAgentProvider = (typeof LOCAL_AGENT_PROVIDERS)[number];

/** 本地代理的模型级配置：仅模型名与推理力度，不含密钥或路径。 */
export interface NativeAgentConfiguration {
  /** 模型名；省略用提供商默认。 */
  model?: string;
  /** 推理力度（取值域由提供商决定）。 */
  reasoningEffort?: string;
}

/** 提供商报告的一个可选模型及其实际支持的推理力度列表。 */
export interface NativeAgentModel {
  /** 模型 id。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 该模型支持的推理力度；省略表示提供商未提供。 */
  reasoningEfforts?: string[];
}

/** 原生代理生命周期状态：未安装 → 需登录 → 就绪；error 为异常态。 */
export type NativeAgentState = 'not_installed' | 'login_required' | 'ready' | 'error';

/** 单个本地代理的探测结果（服务端聚合本地运行时的上报）。 */
export interface NativeAgentStatus {
  /** 研究工具能力（是否支持 MCP）；不支持时省略。 */
  researchTools?: ResearchToolCapability;
  /** 提供商标识。 */
  provider: LocalAgentProvider;
  /** 展示名。 */
  name: string;
  /** 生命周期状态。 */
  state: NativeAgentState;
  /** CLI 版本号；未知时省略。 */
  version?: string;
  /** 引导登录的命令（展示给用户）。 */
  loginCommand: string;
  /** 安装引导页 URL。 */
  installUrl: string;
  /** 提供商可用模型列表；未知时省略。 */
  models?: NativeAgentModel[];
  /** 提供商支持的推理力度列表（逐模型的精确列表见 models[].reasoningEfforts）。 */
  reasoningEfforts?: string[];
  /** 状态异常时的配置指引文案。 */
  configurationHelp?: string;
}

/** 用户视角的一条本地代理连接：状态 + 连接/可用/占用标志与来源。 */
export interface LocalAgentConnection extends NativeAgentStatus {
  /** 连接条目 id。 */
  id: string;
  /** 是否已连接。 */
  connected: boolean;
  /** 是否可用。 */
  available: boolean;
  /** 是否正被任务占用。 */
  busy: boolean;
  /** 来源：native=本机 CLI；companion=外部 companion 设备。 */
  source: 'native' | 'companion';
}

/** 代理页汇总：当前模式（native/companion）+ 连接列表 + companion 设备信息。 */
export interface LocalAgentsStatus {
  /** 本地代理模式。 */
  mode: 'native' | 'companion';
  /** 连接条目列表。 */
  items: LocalAgentConnection[];
  /** companion 设备连接状态与名称。 */
  companion: { connected: boolean; name?: string };
}

/** 配对信物：一次性配对码 + 过期时间；换取可撤销的设备凭据。 */
export interface LocalAgentPairing {
  /** 配对码（服务端生成，短期有效）。 */
  code: string;
  /** 过期时间（ISO 字符串）。 */
  expiresAt: string;
}

/** 下行命令：让 companion 执行一次登录或一次研究运行。 */
export interface CompanionCommand {
  /** 运行类命令附带的研究工具包（描述符 + 快照）；登录命令省略。 */
  researchTools?: ResearchToolBundle;
  /** 命令 id（上行更新用同一 id 回执）。 */
  id: string;
  /** 命令种类：run=执行研究，login=引导登录。 */
  kind: 'run' | 'login';
  /** 目标提供商。 */
  provider: LocalAgentProvider;
  /** run 命令的研究提示词。 */
  prompt?: string;
  /** run 命令的模型配置。 */
  agentSettings?: NativeAgentConfiguration;
}

/** 上行更新：companion 对某条命令的进度/结果回执。 */
export interface CompanionUpdate {
  /** 过程中产生的公开活动事件（脱敏后的 ResearchActivity）。 */
  events?: ResearchActivity[];
  /** 对应命令 id。 */
  id: string;
  /** 命令状态：运行中 / 完成 / 失败 / 已取消。 */
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  /** 进度说明。 */
  progress?: string;
  /** 最终产出文本（研究结论文本）。 */
  text?: string;
  /** 本地运行消耗的 token 数；null 表示用量未知（外部 CLI 未上报）。 */
  usageTokens?: number | null;
  /** 失败原因的固定错误码（客户端据此提示）。 */
  error?:
    | 'LOCAL_INVALID_CONFIGURATION'
    | 'LOCAL_CONFIGURATION_UNSUPPORTED'
    | 'LOCAL_VERSION_UNSUPPORTED'
    | 'LOCAL_LOGIN_REQUIRED'
    | 'LOCAL_DISPATCH_UNCERTAIN'
    | 'LOCAL_TOOL_ISOLATION_FAILED';
}

/** 轮询请求体：companion 当前看到的各代理状态 + 待回执的更新。 */
export interface CompanionPoll {
  /** companion 侧探测到的各提供商状态。 */
  agents: NativeAgentStatus[];
  /** 待回执的命令更新。 */
  updates: CompanionUpdate[];
}

/** 轮询响应体：新命令 + 需要取消的任务 id 列表。 */
export interface CompanionPollResult {
  /** 服务端下发的新命令。 */
  commands: CompanionCommand[];
  /** 需要取消的研究任务 id。 */
  cancelTaskIds: string[];
}
