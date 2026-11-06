type ErrorText = readonly [en: string, zh: string];

const messages: Record<string, ErrorText> = {
  LLM_BUDGET_EXCEEDED_INPUT_TOKENS: [
    'This preparation exceeds the per-call input token limit. Shorten the strategy text or review the input limit in Research budget.',
    '本次策略整理超过单次输入 Token 上限。请缩短策略正文，或在研究预算中检查单次输入上限。',
  ],
  LLM_BUDGET_EXCEEDED_DAILY_TOKENS: [
    'The daily token budget is insufficient. Review Research budget or wait for the next UTC day before retrying.',
    '当日 Token 额度不足。请检查研究预算，或等待下一个 UTC 日后重试。',
  ],
  LLM_BUDGET_EXCEEDED_MONTHLY_TOKENS: [
    'The monthly token budget is insufficient. Review Research budget or wait for the next UTC month before retrying.',
    '当月 Token 额度不足。请检查研究预算，或等待下一个 UTC 月后重试。',
  ],
  LLM_BUDGET_EXCEEDED_TASK_TOKENS: [
    'This task has reached its token budget. Review the task token limit in Research budget before retrying.',
    '本次任务已达到 Token 额度上限。请在研究预算中检查任务 Token 上限后重试。',
  ],
  LLM_BUDGET_EXCEEDED_DAILY_CALLS: [
    'The daily model-call limit has been reached. Review Research budget or wait for the next UTC day before retrying.',
    '当日模型调用次数已达上限。请检查研究预算，或等待下一个 UTC 日后重试。',
  ],
  LLM_BUDGET_EXCEEDED_TASK_CALLS: [
    'This task has reached its model-call limit. Review the task call limit in Research budget before retrying.',
    '本次任务的模型调用次数已达上限。请在研究预算中检查任务调用次数上限后重试。',
  ],
  LLM_BUDGET_EXCEEDED: [
    'Preparation reached a model budget limit. Review the token and call limits in Research budget before retrying.',
    '策略整理已达到模型预算上限。请在研究预算中检查 Token 和调用次数额度后重试。',
  ],
  LOCAL_BUSY: [
    'The selected stock friend is busy. Wait for its current task to finish before retrying.',
    '所选股友正在处理其他任务。请等待当前任务结束后重试。',
  ],
  LOCAL_UNAVAILABLE: [
    'The selected stock friend is unavailable. Check its connection in Model Settings before retrying.',
    '所选股友暂不可用。请在模型设置中检查连接后重试。',
  ],
  LOCAL_AGENT_NOT_FOUND: [
    'The selected stock friend is no longer connected. Choose a connected stock friend in Model Settings.',
    '所选股友已断开连接。请在模型设置中选择已连接的股友。',
  ],
  LOCAL_COMPANION_OFFLINE: [
    'The local stock friend companion is offline. Reconnect it before retrying.',
    '本地股友的伴侣程序已离线。请重新连接后重试。',
  ],
  LOCAL_LOGIN_REQUIRED: [
    'The selected stock friend needs sign-in. Sign in and reconnect it in Model Settings.',
    '所选股友需要登录。请登录后在模型设置中重新连接。',
  ],
  LOCAL_INVALID_CONFIGURATION: [
    'The stock friend configuration is invalid. Check its model and reasoning settings in Model Settings.',
    '股友配置无效。请在模型设置中检查模型和推理设置。',
  ],
  LOCAL_CONFIGURATION_UNSUPPORTED: [
    'The selected stock friend does not support this configuration. Check its model and reasoning settings in Model Settings.',
    '所选股友不支持当前配置。请在模型设置中检查模型和推理设置。',
  ],
  STRATEGY_PREPARATION_FAILED: [
    'Preparation could not be confirmed. Check the saved result and preparation status before trying again.',
    '策略整理尚未确认。请先读取已保存结果并核对整理状态，再决定是否重试。',
  ],
};

const budgetReasons: Record<string, string> = {
  input_tokens: 'LLM_BUDGET_EXCEEDED_INPUT_TOKENS',
  daily_tokens: 'LLM_BUDGET_EXCEEDED_DAILY_TOKENS',
  monthly_tokens: 'LLM_BUDGET_EXCEEDED_MONTHLY_TOKENS',
  task_tokens: 'LLM_BUDGET_EXCEEDED_TASK_TOKENS',
  daily_calls: 'LLM_BUDGET_EXCEEDED_DAILY_CALLS',
  task_calls: 'LLM_BUDGET_EXCEEDED_TASK_CALLS',
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** API diagnostics may contain provider data. Only known classifications select visible text. */
export function normalizeApiPreparationError(cause: unknown, language: string): { message: string; code: string } {
  const error = record(record(record(record(cause).response).data).error);
  let code = [error.code, error.message].find((value): value is string => typeof value === 'string' && Object.prototype.hasOwnProperty.call(messages, value))
    ?? 'STRATEGY_PREPARATION_FAILED';
  if (code === 'LLM_BUDGET_EXCEEDED' && typeof error.reason === 'string' && Object.prototype.hasOwnProperty.call(budgetReasons, error.reason)) {
    code = budgetReasons[error.reason];
  }
  return { code, message: messages[code][language.startsWith('zh') ? 1 : 0] };
}
