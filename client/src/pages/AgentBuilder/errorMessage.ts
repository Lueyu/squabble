/**
 * errorMessage.ts — 统一错误转文案：把 Axios 错误体解析成可展示信息，并翻译本地智能体专用错误码。
 *
 * 职责边界：
 *  - 只做"错误对象 → 一句可展示文案"：优先取服务端结构化 message，其次第一个字段级错误，
 *    再取顶层 message，都不存在时回退调用方文案。
 *  - 额外翻译四个本地智能体（LOCAL_*）私有错误码为 i18n 文案（避免泄漏内部诊断细节）。
 *  - 注意：各页面（如 LoginPage）还有同名本地 errorMessage 函数，实现不同，互不引用。
 * 上下游：
 *  - 上游（路由入口/谁引用）：AnalysisRunner、AgentRunCard、Auth 两页、Council 三处、
 *    Settings 三面板（Budget/LocalAgents/ModelConnections）等广泛引用的公共错误文案出口。
 *  - 下游（调用哪些 hooks/api/组件）：axios（仅用 isAxiosError 判型）、i18next 的全局 t。
 * 关键约定：
 *  - LOCAL_INVALID_CONFIGURATION / LOCAL_CONFIGURATION_UNSUPPORTED / LOCAL_VERSION_UNSUPPORTED /
 *    LOCAL_LOGIN_REQUIRED 四个码由服务端约定，映射到 council.localAgents.* 文案（测试有断言）。
 */
import axios from 'axios';
import { t } from 'i18next';

// 服务端错误体约定：顶层 message 或嵌套 error.message / error.fieldErrors[0].message
interface ApiErrorBody {
  error?: { message?: string; fieldErrors?: Array<{ message?: string }> };
  message?: string;
}

/** 解析错误为可展示文案；非 Axios 错误或无结构化信息时返回 fallback。 */
export function errorMessage(error: unknown, fallback: string): string {
  // 步骤 1：非 Axios 错误直接用回退文案
  if (!axios.isAxiosError<ApiErrorBody>(error)) return fallback;
  // 步骤 2：按优先级取服务端结构化信息（嵌套 message → 字段级错误 → 顶层 message）
  const body: ApiErrorBody | undefined = error.response?.data;
  const message =
    body?.error?.message || body?.error?.fieldErrors?.[0]?.message || body?.message || fallback;
  // 步骤 3：本地智能体专用错误码翻译为 i18n 文案（不直接暴露内部码）
  if (message === 'LOCAL_INVALID_CONFIGURATION')
    return t('council.localAgents.configurationInvalid');
  if (message === 'LOCAL_CONFIGURATION_UNSUPPORTED')
    return t('council.localAgents.configurationUnsupported');
  if (message === 'LOCAL_VERSION_UNSUPPORTED') return t('council.localAgents.versionUnsupported');
  if (message === 'LOCAL_LOGIN_REQUIRED') return t('council.localAgents.loginRequired');
  return message;
}
