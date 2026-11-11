import axios from 'axios';
import type { TeamErrorCode } from '@shared/team-workspace.interface';

interface ApiErrorBody {
  error?: { code?: string; message?: string; roleId?: string; field?: string; fieldErrors?: Array<{ message?: string }> };
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
  TEAM_SAVED_RESPONSE_REQUIRED: {
    zh: '没有可重新解析的原始响应。请检查原任务记录，系统不会自动重发调用。',
    en: 'No saved raw response is available to reparse. Check the original task; no request will be resent automatically.',
  },
};

const TEAM_FRIENDLY: Record<TeamErrorCode, { zh: string; en: string }> = {
  TEAM_INVALID_INPUT: { zh: '请检查必填字段、数值和资料版本，再提交。', en: 'Check required fields, values and source versions before submitting.' },
  TEAM_GRAPH_INVALID: { zh: '组织关系存在冲突，请检查归组、汇报环路和关系范围。', en: 'Check department grouping, reporting cycles and relation scopes.' },
  TEAM_NOT_FOUND: { zh: '团队不存在或当前无法访问，请返回团队列表核对。', en: 'This team is unavailable. Check the team list.' },
  TEAM_REFERENCE_NOT_FOUND: { zh: '关联的工作、尝试或版本无法核对，请重新读取原委托。', en: 'The linked work, attempt or version is unavailable. Reload the original commission.' },
  TEAM_REVISION_CONFLICT: { zh: '服务器已有新的修订。当前改动已保留，请读取并合并后再保存。', en: 'A newer revision exists. Your edits are retained; reload and merge before saving.' },
  TEAM_REQUEST_KEY_CONFLICT: { zh: '同一请求标识对应不同内容，请核对原回执，再明确提交新操作。', en: 'This request key belongs to different content. Check its receipt before submitting a new action.' },
  TEAM_PREVIEW_STALE: { zh: '预览已过期或条件发生变化，请重新检查影响并确认。', en: 'The preview expired or its conditions changed. Review a new preview before confirming.' },
  TEAM_PREVIEW_CONSUMED: { zh: '此预览已经使用，请核对原请求回执和当前状态。', en: 'This preview was already used. Check the original receipt and current state.' },
  TEAM_BINDING_CONFLICT: { zh: '账户或团队关联已变化，请重新读取并预览交接。', en: 'The account or team binding changed. Reload and preview the handoff again.' },
  TEAM_REAPPROVAL_REQUIRED: { zh: '团队或来源已变化，此提案需要重新核准，不能沿用旧确认。', en: 'The team or sources changed. This proposal requires a fresh approval.' },
  TEAM_EXECUTION_UNCERTAIN: { zh: '原执行结果尚未确认。请先检查原任务，不要直接重发。', en: 'The original execution is unresolved. Check that task before requesting another attempt.' },
  TEAM_CAPABILITY_UNAVAILABLE: { zh: '参与岗位的能力或连接未通过检查，请核对连接、交付和隔离能力。', en: 'A participant capability or connection is unavailable. Check its connection, delivery and isolation capabilities.' },
  TEAM_PLAN_INVALID: { zh: '分工计划不完整，请检查唯一负责人、参与岗位、依赖和复核安排。', en: 'Check the final lead, participants, work dependencies and review assignments.' },
  TEAM_SOURCE_UNAVAILABLE: { zh: '固定资料版本不可用，请检查版本、截止时间及来源状态。', en: 'A pinned source version is unavailable. Check its version, cutoff and status.' },
  TEAM_SCOPE_REVOKED: { zh: '本次研究的授权或运行条件已变化，请核对账户关联、期限和资料权限。', en: 'This research scope or its execution conditions changed. Check the account binding, deadline and source permissions.' },
  TEAM_BUDGET_BLOCKED: { zh: '调用、修订或费用额度不足。已派发和未知用量仍占额度，请先核对账目。', en: 'Calls, revisions or cost limits block dispatch. Dispatched and unknown usage still count; check the budget receipts.' },
  TEAM_DEPENDENCY_UNAVAILABLE: { zh: '依赖服务暂时不可用，请核对原任务状态，连接恢复后再操作。', en: 'A dependency is temporarily unavailable. Check the original task and retry after the connection recovers.' },
};

/** Extract a human-readable, actionable message from any thrown error. */
export function friendlyError(error: unknown, zh: boolean, fallback: { zh: string; en: string }, roleLabels?: Record<string, string>): string {
  if (axios.isAxiosError(error) && !error.response) {
    // No response at all: the server or network is unreachable.
    return FRIENDLY.LOCAL_NETWORK_UNAVAILABLE[zh ? 'zh' : 'en'];
  }
  const body: ApiErrorBody | undefined = axios.isAxiosError<ApiErrorBody>(error)
    ? error.response?.data
    : undefined;
  const code = body?.error?.code;
  const role = body?.error?.roleId ? roleLabels?.[body.error.roleId] : undefined;
  if (code === 'TEAM_SCOPE_REVOKED' && body?.error?.field === 'sourceGrantIds' && role) return zh
    ? `岗位「${role}」没有本次输入所需的已发布资料权限。请返回组织配置调整该岗位的资料范围并发布，或从委托中移除相应输入后重新预览。`
    : `The role “${role}” lacks the published source permissions required by this input. Update and publish that role’s source scope, or remove the input before previewing again.`;
  if (code && TEAM_FRIENDLY[code as TeamErrorCode]) return TEAM_FRIENDLY[code as TeamErrorCode][zh ? 'zh' : 'en'];
  const raw = body?.error?.message
    || body?.error?.fieldErrors?.[0]?.message
    || body?.message
    || (error instanceof Error ? error.message : '');
  if (raw && FRIENDLY[raw]) return FRIENDLY[raw][zh ? 'zh' : 'en'];
  if (raw && TEAM_FRIENDLY[raw as TeamErrorCode]) return TEAM_FRIENDLY[raw as TeamErrorCode][zh ? 'zh' : 'en'];
  if (raw === 'TEAM_RESEARCH_COMMAND_REQUIRED' || raw === 'TEAM_SCOPE_REQUIRED') return zh
    ? '请从原团队委托查看或恢复研究，以保留本次权限、版本与预算。'
    : 'Open or recover research from its original team commission to retain its scope, versions and budget.';
  return raw || (zh ? fallback.zh : fallback.en);
}
