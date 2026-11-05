const reasons: Record<string, [string, string]> = {
  MEMORY_ARCHIVE_PENDING: ['Claims are waiting for archival. This research cycle will be reused.', '论点正在等待归档，将复用当前研究周期。'],
  MEMORY_ARCHIVE_FAILED: ['Claim archival failed. Retry it in the research dossier.', '论点归档失败，请在研究档案中重试。'],
  MEMORY_ARCHIVE_DISABLED: ['Automatic archival is off. Import the existing report manually.', '自动归档已关闭，请手动导入现有报告。'],
  MEMORY_ARCHIVE_REQUIRED: ['This report needs archival before its claims can be checked.', '该报告需要先归档，再核验论点。'],
  MEMORY_CONDITION_BREACHED: ['A thesis condition was breached. A deliberate revision with a review reason or a reviewed replacement is required.', '论点条件已触发，需要填写复核原因后明确修订，或提供已复核的替代论点。'],
  MEMORY_MONITOR_UNKNOWN: ['A configured condition has no usable observation. New risk is blocked.', '已配置条件暂无有效观测，新增风险已阻断。'],
  MEMORY_DEPENDENCY_REVOKED: ['A thesis version or source changed or was removed. A new reviewed plan is required.', '依赖论点版本或来源已变化、撤回或删除，需要新的验收策略。'],
  MEMORY_DEPENDENCY_EXPIRED: ['A thesis reached its validity or review boundary. Research review is required.', '论点已到有效期或复核边界，需要研究复核。'],
  MEMORY_RECALL_DISABLED: ['This plan used memory that is now disabled. Review a new plan without recall.', '该策略使用了已停用的记忆，请复核不使用记忆的新策略。'],
  MEMORY_LEGACY_PLAN_REVIEW_REQUIRED: ['This older plan has no captured dependency inventory. Review a new plan before increasing risk.', '旧策略未记录论点依赖清单，增加风险前需要复核新策略。'],
  MEMORY_SUBMISSION_UNKNOWN: ['The actual submitted memory inventory is unknown. Review the research before using its dependencies.', '实际提交的记忆清单未知，使用依赖前请复核研究。'],
  MEMORY_REPLACEMENT_REVIEW_REQUIRED: ['Replacement authority or the previous version changed. Review the replacement again.', '替代授权或旧版本已变化，请重新复核替代关系。'],
  MEMORY_REPLACEMENT_INVALID: ['The replacement relationship cannot be verified. New risk is blocked.', '替代关系无法核实，新增风险已阻断。'],
  MEMORY_SOURCE_UNAVAILABLE: ['A research source is unavailable. Review the source before increasing risk.', '研究来源不可用，增加风险前请复核来源。'],
  MEMORY_REPORT_MISSING: ['The report is unavailable. Review a current report before continuing.', '报告不可用，请先复核当前报告。'],
  MEMORY_RESEARCH_NOT_ACCEPTED: ['The research has not passed review.', '研究尚未通过验收。'],
  MEMORY_CLAIMS_MISSING: ['Structured claims are missing. Review the published research.', '缺少结构化论点，请复核已发布的研究。'],
  MEMORY_CONTEXT_LIMIT: ['Whole memory items do not fit the context capacity. Reduce the selected memory or increase the available context budget.', '完整记忆无法放入上下文容量，请减少所选记忆或增加可用上下文预算。'],
  MEMORY_CONTEXT_CHANGED: ['Memory changed before submission. Refresh the selected versions and retry the research explicitly.', '记忆在提交前已变化，请刷新所选版本后明确重试研究。'],
  MEMORY_CONTEXT_FORMAT: ['The memory context could not be prepared. Refresh memory and retry.', '记忆上下文准备失败，请刷新记忆后重试。'],
  MEMORY_UNKNOWN: ['Thesis dependencies cannot be verified. Review the report and prepare a new plan.', '无法核实论点依赖，请复核报告并准备新策略。'],
};
export function memoryReason(reason: string, language: string): string {
  const code = reason.match(/MEMORY_[A-Z_]+/u)?.[0];
  return code ? (reasons[code] ?? reasons.MEMORY_UNKNOWN)[language.startsWith('zh') ? 1 : 0] : reason;
}
export function isMemoryContextError(reason: string): boolean {
  return /MEMORY_|memory|context|记忆|上下文/iu.test(reason);
}
