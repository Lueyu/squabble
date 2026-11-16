/**
 * local-agents.types.ts — 本地智能体模块的共享类型与错误工具。
 *
 * 职责边界：
 *  - 任务引用（LocalAgentTaskRef）、执行请求（LocalAgentExecution）、执行结果（LocalAgentResult）。
 *  - LocalAgentError（带错误码/任务上下文的领域错误）与 nativeFailureCode（运行时错误码归一化）。
 * 上下游：
 *  - 上游：LocalAgentsService、CouncilService（council.service 依赖其执行契约）。
 *  - 下游：无（仅类型与错误映射）。
 * 关键约定：
 *  - 运行时失败码只发布已知映射；CLI 诊断文本可能包含私密数据，不透传给用户。
 */
import type { NativeAgentConfiguration } from '../../../shared/local-agents.interface';
import type { ResearchToolScope } from '../../../shared/research-tools.interface';

/** 任务引用：本地任务 id 与会话上下文 id（当前两者相同）。 */
export interface LocalAgentTaskRef {
  taskId: string;
  contextId: string;
}
/** 一次本地智能体执行请求：智能体、消息幂等键、prompt、配置、远端续传引用与生命周期回调。 */
export interface LocalAgentExecution {
  researchScope?: ResearchToolScope;
  agentId: string;
  messageId: string;
  prompt: string;
  agentSettings?: NativeAgentConfiguration;
  remoteTaskId?: string;
  contextId?: string;
  resumeInput?: boolean;
  onDispatch?(): Promise<void>;
  onTask(ref: LocalAgentTaskRef): Promise<void>;
  onProgress(text: string): Promise<void>;
  shouldContinue(): Promise<boolean>;
}
/** 执行结果：任务/上下文引用、输出文本与（可能未知的）token 用量。 */
export interface LocalAgentResult {
  taskId?: string;
  contextId?: string;
  text: string;
  data?: unknown;
  usageTokens: number | null;
}
/** 领域错误：code 为对外可见错误码，taskId/contextId 标注出错任务。 */
export class LocalAgentError extends Error {
  constructor(
    readonly code: string,
    readonly taskId?: string,
    readonly contextId?: string,
  ) {
    super(code);
    this.name = 'LocalAgentError';
  }
}

/** 只发布已知的运行时失败码；CLI 诊断信息可能包含私密数据，不对外透传。 */
export function nativeFailureCode(error: unknown): string {
  if (error instanceof LocalAgentError) return error.code;
  const codes: Record<string, string> = {
    NATIVE_AGENT_LOGIN_REQUIRED: 'LOCAL_LOGIN_REQUIRED',
    NATIVE_AGENT_INVALID_CONFIGURATION: 'LOCAL_INVALID_CONFIGURATION',
    NATIVE_AGENT_CONFIGURATION_UNSUPPORTED: 'LOCAL_CONFIGURATION_UNSUPPORTED',
    NATIVE_AGENT_VERSION_UNSUPPORTED: 'LOCAL_VERSION_UNSUPPORTED',
    NATIVE_AGENT_CANCEL_UNCONFIRMED: 'LOCAL_DISPATCH_UNCERTAIN',
    NATIVE_AGENT_UPSTREAM_PENDING: 'LOCAL_DISPATCH_UNCERTAIN',
    NATIVE_AGENT_TOOL_ISOLATION_FAILED: 'LOCAL_TOOL_ISOLATION_FAILED',
  };
  return error instanceof Error
    ? (codes[error.message] ?? 'LOCAL_TASK_FAILED')
    : 'LOCAL_TASK_FAILED';
}
