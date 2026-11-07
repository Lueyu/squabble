import axios from 'axios';

interface ApiErrorBody {
  error?: { message?: string; fieldErrors?: Array<{ message?: string }> };
  message?: string;
}

/** Map machine error codes to short, actionable bilingual guidance. */
const FRIENDLY: Record<string, { zh: string; en: string }> = {
  LOCAL_NETWORK_UNAVAILABLE: {
    zh: '无法连接模型服务，请检查网络或代理后重试。',
    en: 'Cannot reach the model service. Check your network or proxy and try again.',
  },
  LOCAL_DISPATCH_UNCERTAIN: {
    zh: '模型请求未确认，请检查网络后重试。',
    en: 'The model request was not confirmed. Check your network and try again.',
  },
  LOCAL_TIMEOUT: { zh: '模型响应超时，请稍后重试。', en: 'The model timed out. Try again in a moment.' },
  LOCAL_LOGIN_REQUIRED: {
    zh: '该模型需要先登录，请在设置中完成登录。',
    en: 'This model requires sign-in. Complete it in settings.',
  },
  LOCAL_INVALID_CONFIGURATION: {
    zh: '模型配置有误，请在设置中检查模型名称。',
    en: 'The model configuration is invalid. Check the model name in settings.',
  },
  LOCAL_USAGE_LIMIT: {
    zh: '模型额度已用尽，请更换模型或稍后再试。',
    en: 'The model quota is exhausted. Switch models or try later.',
  },
  LOCAL_RATE_LIMIT: {
    zh: '请求过于频繁，请稍后再试。',
    en: 'Too many requests. Please slow down and try again.',
  },
  REPORT_STRATEGY_UNAVAILABLE: {
    zh: '这份报告还没有可执行的策略，请先生成今日报告。',
    en: 'This report has no executable strategy yet. Generate today’s report first.',
  },
};

/** Extract a human-readable, actionable message from any thrown error. */
export function friendlyError(error: unknown, zh: boolean, fallback: { zh: string; en: string }): string {
  if (axios.isAxiosError(error) && !error.response) {
    // No response at all: the server or network is unreachable.
    return FRIENDLY.LOCAL_NETWORK_UNAVAILABLE[zh ? 'zh' : 'en'];
  }
  const body: ApiErrorBody | undefined = axios.isAxiosError<ApiErrorBody>(error)
    ? error.response?.data
    : undefined;
  const raw = body?.error?.message
    || body?.error?.fieldErrors?.[0]?.message
    || body?.message
    || (error instanceof Error ? error.message : '');
  if (raw && FRIENDLY[raw]) return FRIENDLY[raw][zh ? 'zh' : 'en'];
  return raw || (zh ? fallback.zh : fallback.en);
}
