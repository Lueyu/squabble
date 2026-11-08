import type { AnalysisLanguage } from '@shared/api.interface';

/** Safe shared diagnostics for research execution and archived error reading. */
type SafeErrorText = readonly [en: string, zh: string];
const BUDGET_ERRORS: Record<string, SafeErrorText> = {
  task_tokens: [
    "This task's token budget is exhausted. Continuing does not reset it. Review Research budget or start a new discussion; daily and monthly limits still apply.",
    '本次讨论的 Token 额度不足，继续不会重置。可在研究预算中调整或新建讨论，日／月总额度仍然生效。',
  ],
  task_calls: [
    "This task's model-call budget is exhausted. Continuing does not reset it. Review Research budget or start a new discussion; daily and monthly limits still apply.",
    '本次讨论的模型调用次数已达上限，继续不会重置。可在研究预算中调整或新建讨论，日／月总额度仍然生效。',
  ],
  daily_tokens: [
    'The daily token budget is insufficient for this request. Review Research budget or wait for the next UTC day. Existing task limits still apply.',
    '当日 Token 预算不足以执行本次请求。请检查研究预算，或等待下一个 UTC 日；已有任务额度仍然生效。',
  ],
  monthly_tokens: [
    'The monthly token budget is insufficient for this request. Review Research budget or wait for the next UTC month. Existing task limits still apply.',
    '当月 Token 预算不足以执行本次请求。请检查研究预算，或等待下一个 UTC 月；已有任务额度仍然生效。',
  ],
  daily_calls: [
    'The daily model-call limit has been reached. Review Research budget or wait for the next UTC day. Existing task limits still apply.',
    '当日模型调用次数已达上限。请检查研究预算，或等待下一个 UTC 日；已有任务额度仍然生效。',
  ],
  input_tokens: [
    'The prompt exceeds the per-call input budget. Shorten the instructions or start a shorter discussion, or review the input limit in Research budget.',
    '本次提示内容超过单次输入额度。请缩短指令或新建较短的讨论，或在研究预算中检查输入上限。',
  ],
  unknown: [
    'Analysis stopped at an LLM budget limit. Review token and call limits in API Settings before retrying.',
    '分析已达到模型预算上限，请在 API 设置中检查 Token 和调用次数额度后再重试。',
  ],
};
const MODEL_ERRORS: Record<string, SafeErrorText> = {
  PORTFOLIO_INVALID_REPORT: [
    'The Agent returned an incomplete or unsupported portfolio report. No conclusion was saved. Check its model settings before starting a new report.',
    'Agent 返回的组合报告不完整或包含不支持的内容，未保存结论。请检查模型设置后重新开始报告。',
  ],
  LLM_BASIC_ROUTE: [
    'Basic analysis uses data and rules. Select an API model or connected local Agent for model tasks.',
    '基础分析使用数据和规则。模型任务请选择 API 模型或已连接的本地 Agent。',
  ],
  LOCAL_UNAVAILABLE: [
    'The selected local Agent is unavailable. Reconnect it in Model Settings, then retry.',
    '所选本地 Agent 不可用。请在模型设置中重新连接后重试。',
  ],
  LOCAL_AGENT_NOT_FOUND: [
    'The selected local Agent is no longer connected. Choose a connected Agent in Model Settings.',
    '所选本地 Agent 已断开连接。请在模型设置中选择已连接的 Agent。',
  ],
  LOCAL_LOGIN_REQUIRED: [
    'The selected local Agent needs sign-in. Sign in and reconnect it in Model Settings.',
    '所选本地 Agent 需要登录。请登录后在模型设置中重新连接。',
  ],
  LOCAL_BUSY: [
    'The selected local Agent is busy. Retry when its current task finishes.',
    '所选本地 Agent 正忙。请等待当前任务完成后重试。',
  ],
  LOCAL_CANCELLED: [
    'The local Agent task was cancelled.',
    '本地 Agent 任务已取消。',
  ],
  LOCAL_PAUSED: [
    'The local Agent task stopped. Confirm it has finished before retrying.',
    '本地 Agent 任务已停止。请确认任务结束后再重试。',
  ],
  LOCAL_INTERRUPTED: [
    'The local Agent disconnected during the task. Reconnect it and start a new analysis.',
    '本地 Agent 在任务期间断开连接。请重新连接并开始新的分析。',
  ],
  LOCAL_COMPANION_OFFLINE: [
    'The local Agent companion is offline. Reconnect the companion and retry.',
    '本地 Agent 伴侣程序已离线。请重新连接后重试。',
  ],
  LOCAL_DISPATCH_UNCERTAIN: [
    'The local Agent task may still be running. Check its status before starting a new analysis.',
    '本地 Agent 任务可能仍在运行。开始新分析前请检查其状态。',
  ],
  LOCAL_VERSION_UNSUPPORTED: [
    'The local Agent version is unsupported. Update it and reconnect in Model Settings.',
    '本地 Agent 版本不受支持。请更新后在模型设置中重新连接。',
  ],
  LOCAL_INVALID_RESULT: [
    'The local Agent returned an invalid result. Check its model settings and retry.',
    '本地 Agent 返回了无效结果。请检查模型设置后重试。',
  ],
  LOCAL_INVALID_CONFIGURATION: [
    'The local Agent model or reasoning setting is invalid. Check Model Settings.',
    '本地 Agent 的模型或推理设置无效。请检查模型设置。',
  ],
  LOCAL_CONFIGURATION_UNSUPPORTED: [
    'The selected local Agent does not support that model or reasoning setting. Check Model Settings.',
    '所选本地 Agent 不支持该模型或推理设置。请检查模型设置。',
  ],
  LOCAL_USAGE_LIMIT: [
    'The local Agent account reached its usage limit. Check the Agent account before retrying.',
    '本地 Agent 账户已达到用量上限。请检查 Agent 账户后重试。',
  ],
  LOCAL_RATE_LIMIT: [
    'The local Agent is rate limited. Wait before retrying.',
    '本地 Agent 遇到频率限制。请稍后重试。',
  ],
  LOCAL_TASK_FAILED: [
    'The local Agent task failed. Check its connection and retry.',
    '本地 Agent 任务失败。请检查连接后重试。',
  ],
  LLM_REQUEST_TIMEOUT: [
    'The model response timed out. Its reserved usage remains counted because the provider may have processed the request. Completed discussion turns are retained; check provider status before explicitly continuing.',
    '模型响应超时；供应商可能已处理请求，因此保留本次预留用量。已完成的讨论发言仍会保留，请检查供应商状态后再手动继续。',
  ],
  LLM_OUTPUT_LIMIT: [
    'The model reply reached its output limit and was truncated. No incomplete decision was accepted. Choose a model that can return a final answer within the limit, or review the output cap in Research budget; no automatic retry was made.',
    '模型回复达到输出上限而被截断，未采纳不完整决策。请选择能在限额内返回最终答案的模型，或在研究预算中检查输出上限；系统未自动重试。',
  ],
  LLM_EMPTY_RESPONSE: [
    'The model returned an empty final answer. Check the model ID and reasoning mode; for DeepSeek, use a current API model ID such as deepseek-flash. Usage remains counted and no automatic retry was made.',
    '模型未返回最终答案。请检查模型 ID 与推理模式；DeepSeek 可使用当前 API 模型 ID，例如 deepseek-flash。已有用量仍计入预算，系统未自动重试。',
  ],
  LLM_INVALID_JSON: [
    'The model returned invalid JSON, so no decision was accepted. Use a model that supports structured JSON responses. Usage remains counted and no automatic retry was made.',
    '模型返回的 JSON 格式无效，未采纳任何决策。请使用支持 JSON 结构化输出的模型。已有用量仍计入预算，系统未自动重试。',
  ],
};
const PROVIDER_ERRORS: Record<string, SafeErrorText> = {
  '400': ['Model request rejected (HTTP 400). Check the exact API model ID and request parameters; a display name is not a model ID.',
    '模型请求被拒绝（HTTP 400）。请检查准确的 API 模型 ID 和请求参数，产品展示名称不能当作模型 ID。'],
  '401': ['Model authentication failed (HTTP 401). Check the API key in API Settings.',
    '模型鉴权失败（HTTP 401）。请在 API 设置中检查 API Key。'],
  '402': ['Model provider payment required (HTTP 402). Check the provider account balance or credits; this is separate from the app token budget.',
    '模型服务要求付费（HTTP 402）。请检查供应商账户余额或额度，这与应用内 Token 预算不同。'],
  '403': ['Model access denied (HTTP 403). Check that the API key has access to the selected model.',
    '模型访问被拒绝（HTTP 403）。请检查 API Key 是否拥有所选模型的访问权限。'],
  '404': ['Model or endpoint not found (HTTP 404). Check the base URL and exact API model ID in API Settings.',
    '模型或接口不存在（HTTP 404）。请在 API 设置中检查接口地址和准确的 API 模型 ID。'],
  '422': ['Model parameters rejected (HTTP 422). Check the model ID and supported request parameters.',
    '模型参数被拒绝（HTTP 422）。请检查模型 ID 及其支持的请求参数。'],
  '429': ['Model provider rate or quota limit reached (HTTP 429). Wait before retrying and check the provider quota; app budget limits are separate.',
    '模型供应商限流或额度已用完（HTTP 429）。请稍后重试并检查供应商额度；应用内预算是另一项限制。'],
  '500': ['Model provider is unavailable (HTTP 500). Retry later after checking its service status.',
    '模型供应商暂时不可用（HTTP 500）。请检查服务状态后稍后重试。'],
  '503': ['Model provider is busy or unavailable (HTTP 503). Retry later after checking its service status.',
    '模型供应商繁忙或暂时不可用（HTTP 503）。请检查服务状态后稍后重试。'],
};

/** Only allowlisted classifications cross the boundary; never provider payloads or secrets. */
export function safeAnalysisError(error: unknown, language: AnalysisLanguage): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const localized = (text: SafeErrorText) => text[language === 'en' ? 0 : 1];
  // Reports persist sanitized text. Re-reading one must preserve its cause,
  // including when the reader switches interface language.
  const saved = [...Object.values(BUDGET_ERRORS), ...Object.values(MODEL_ERRORS), ...Object.values(PROVIDER_ERRORS)]
    .find((text) => text.includes(message));
  if (saved) return localized(saved);
  const code = analysisErrorCode(error);
  if (code === 'LLM_BUDGET_EXCEEDED') {
    const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : undefined;
    return localized(BUDGET_ERRORS[typeof reason === 'string' ? reason : 'unknown'] ?? BUDGET_ERRORS.unknown);
  }
  const modelError = MODEL_ERRORS[code] ?? MODEL_ERRORS[message]
    ?? (message === 'Failed to parse LLM JSON response' ? MODEL_ERRORS.LLM_INVALID_JSON : undefined);
  if (modelError) return localized(modelError);
  const status = message.match(/^LLM provider returned HTTP (\d{3})$/u)?.[1];
  if (status) return PROVIDER_ERRORS[status] ? localized(PROVIDER_ERRORS[status]) : language === 'en'
      ? `Model provider request failed (HTTP ${status}). Check API Settings and retry.`
      : `模型服务请求失败（HTTP ${status}），请检查 API 设置后重试。`;
  if (/^(?:Model provider request failed \(HTTP \d{3}\)\. Check API Settings and retry\.|模型服务请求失败（HTTP \d{3}），请检查 API 设置后重试。)$/u.test(message)) {
    return message;
  }
  if (message === 'No LLM API key configured' || message === 'LLM request failed. Check provider URL and server network.') {
    return language === 'en' ? 'The configured model is unavailable. Check API Settings and retry.'
      : '当前配置的模型不可用，请检查 API 设置后重试。';
  }
  return language === 'en'
    ? 'Analysis could not be completed. Please retry; if it continues, check the server connection and API Settings.'
    : '分析未能完成，请重试；如持续失败，请检查服务连接和 API 设置。';
}

/** Non-sensitive diagnostic classification for operational logs. */
export function analysisErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const item = error as { code?: unknown; cause?: { code?: unknown } };
    const code = item.cause?.code ?? item.code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,20}$/u.test(code)) return code;
  }
  return 'ANALYSIS_FAILED';
}
