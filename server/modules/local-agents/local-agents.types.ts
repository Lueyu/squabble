export interface LocalAgentTaskRef { taskId: string; contextId: string }
export interface LocalAgentExecution {
  agentId: string;
  messageId: string;
  prompt: string;
  remoteTaskId?: string;
  contextId?: string;
  resumeInput?: boolean;
  onDispatch?(): Promise<void>;
  onTask(ref: LocalAgentTaskRef): Promise<void>;
  onProgress(text: string): Promise<void>;
  shouldContinue(): Promise<boolean>;
}
export interface LocalAgentResult {
  taskId?: string;
  contextId?: string;
  text: string;
  data?: unknown;
  usageTokens: number | null;
}
export class LocalAgentError extends Error {
  constructor(readonly code: string, readonly taskId?: string, readonly contextId?: string) {
    super(code);
    this.name = 'LocalAgentError';
  }
}
