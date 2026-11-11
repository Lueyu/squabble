/** Fixed operational metadata only; no command lines, output text or credentials. */
export type NativeDiagnosticStage = 'preflight' | 'process' | 'output' | 'result';
export interface NativeDiagnosticEvent {
  id: string;
  stage: NativeDiagnosticStage;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  at: string;
  code?: string;
  exitCode?: number;
  outputBytes?: number;
  stderrBytes?: number;
  terminalEvent?: boolean;
}
