import type { TelemetryStatus } from '@shared/telemetry.interface';
import type { FailureStage, RecoveryAction, SafeFailure } from '@shared/research-execution.interface';

export function statusLabel(status: TelemetryStatus, zh: boolean): string {
  const labels: Record<TelemetryStatus, [string, string]> = {
    queued: ['排队中', 'Queued'], running: ['运行中', 'Running'], completed: ['已完成', 'Completed'],
    failed: ['失败', 'Failed'], cancelled: ['已取消', 'Cancelled'], unknown: ['未知状态', 'Unknown status'],
  };
  return labels[status][zh ? 0 : 1];
}

export function sceneLabel(scene: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    council: ['研究室', 'Research room'], research: ['研究任务', 'Research'],
    daily: ['投资日报', 'Daily report'], portfolio: ['持仓研究', 'Portfolio research'],
    channel: ['股友频道', 'Companion channel'], model: ['模型请求', 'Model request'],
    native: ['本地 Agent', 'Native agent'],
  };
  return labels[scene]?.[zh ? 0 : 1] ?? scene;
}

/** Explain fixed failure codes without deriving a cause from missing activity or raw output. */
export function diagnosticFailureExplanation(failure: Pick<SafeFailure, 'code' | 'stage'>, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    LOCAL_LOGIN_REQUIRED: ['本地 Agent 需要登录后才能执行。', 'The local agent requires sign-in before execution.'],
    LOCAL_INVALID_CONFIGURATION: ['已保存的成员配置未通过检查。', 'The saved member configuration did not pass validation.'],
    LOCAL_CONFIGURATION_UNSUPPORTED: ['当前 Agent 不支持所选配置。', 'This agent does not support the selected configuration.'],
    LOCAL_VERSION_UNSUPPORTED: ['当前 Agent 版本不支持所需能力。', 'This agent version does not support the required capability.'],
    LOCAL_NETWORK_UNAVAILABLE: ['已记录网络或传输失败，具体连接原因以已保存证据为准。', 'A network or transport failure was recorded; the saved evidence determines what is known.'],
    LOCAL_TIMEOUT: ['执行已达到配置的时间限制。', 'Execution reached the configured time limit.'],
    LOCAL_LAUNCH_FAILED: ['本地 Agent 进程未能启动。', 'The local agent process could not be started.'],
    LOCAL_PROTOCOL_INCOMPLETE: ['Agent 未返回完整的最终结果；进程退出本身不代表结果成功。', 'The agent did not return a complete final result; process exit alone does not establish success.'],
    LOCAL_OUTPUT_LIMIT: ['采集的输出达到配置的大小限制。', 'Captured output reached the configured size limit.'],
    LOCAL_DISPATCH_UNCERTAIN: ['派发结果尚未确定，需先核查原任务状态。', 'The dispatch outcome is uncertain. Check the original task status first.'],
    LOCAL_USAGE_LIMIT: ['供应商已报告用量额度限制。', 'The provider reported a usage allowance limit.'],
    LOCAL_RATE_LIMIT: ['供应商已报告请求频率限制。', 'The provider reported a request rate limit.'],
    LOCAL_PAUSED: ['任务已暂停，需要核查原任务状态。', 'The task was paused. Check the original task status.'],
    LOCAL_INTERRUPTED: ['执行已中断，需要核查原任务状态。', 'Execution was interrupted. Check the original task status.'],
    LOCAL_UNAVAILABLE: ['当前执行器不可用。', 'The executor is unavailable.'],
    LOCAL_TOOL_ISOLATION_FAILED: ['工具隔离检查未通过，执行被阻止。', 'Tool isolation checks failed and blocked execution.'],
  };
  if (failure.stage === 'parse' || failure.code === 'LOCAL_INVALID_RESULT') return zh
    ? '内容已返回，但结果验收未通过；请检查已保存结果与字段证据。'
    : 'Content was returned, but result acceptance failed. Inspect the saved result and validation evidence.';
  return labels[failure.code]?.[zh ? 0 : 1] ?? (zh
    ? '任务失败；已保存证据尚不能确定更具体的原因。'
    : 'The task failed. The saved evidence does not establish a more specific cause.');
}

export function diagnosticFailureStageLabel(stage: FailureStage, zh: boolean): string {
  const labels: Record<FailureStage, [string, string]> = {
    preflight: ['启动前检查', 'Preflight checks'], dispatch: ['派发 / 启动', 'Dispatch / launch'],
    runtime: ['执行过程', 'Execution'], parse: ['结果解析与验收', 'Result parsing and acceptance'],
  };
  return labels[stage][zh ? 0 : 1];
}

export function diagnosticRecoveryLabel(action: RecoveryAction, zh: boolean): string {
  const labels: Record<RecoveryAction, [string, string]> = {
    check_existing: ['先核查原任务状态与已有结果', 'Check original task status and saved results first'],
    reparse_existing: ['重新验收已有结果，无需重新请求 Agent', 'Revalidate the saved result without another agent request'],
    retry_member: ['在原会话核查后，仅重试该成员', 'Review and retry this member in the original session'],
    fix_configuration: ['修复连接、登录或成员配置', 'Fix connection, sign-in or member configuration'],
  };
  return labels[action]?.[zh ? 0 : 1] ?? (zh ? '在原会话核查恢复方式' : 'Review recovery options in the original session');
}

/** Translate fixed adapter labels; preserve other already-sanitized public activity as recorded. */
export function diagnosticEventSummary(summary: string, zh: boolean): string {
  if (!zh) return summary;
  const labels: Record<string, string> = {
    'Native execution preflight': '本地执行启动前检查',
    'First process output observed': '已观测到进程首次输出',
    'Provider result protocol': '执行器结果协议检查',
    'Native process started': '本地 Agent 进程已启动',
    'Native process ended': '本地 Agent 进程已结束',
    'Task handed off; subprocess launch not yet established': '任务已交接，尚需进程启动证据确认',
    'Application accepted the returned result': '应用已接受返回结果',
    'Application rejected the returned result': '应用未接受返回结果',
    'Research started': '研究已开始',
    'Research completed': '执行器已报告研究完成',
    'Research running': '执行器已报告研究进行中',
    'Research ended': '执行器已报告研究结束',
    'Research tool activity': '已观测到研究工具活动',
  };
  return labels[summary] ?? summary;
}
