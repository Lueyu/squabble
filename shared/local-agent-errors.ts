/** Static public messages: provider diagnostics may contain credentials and must never be rendered. */
export function localAgentLimitMessage(code: string | undefined, language: string): string | undefined {
  const messages: Record<string, [string, string]> = {
    LOCAL_USAGE_LIMIT: [
      '本地 Agent 的供应商用量额度已达上限，或余额不足。本次任务已停止，未自动重试。请查看供应商账户的额度与重置时间，或更换该角色的模型后新建讨论。Squabble 的研究预算不控制供应商额度。',
      'The local agent provider reported a usage limit or insufficient balance. This task stopped and was not retried. Check the provider account for usage and reset time, or change this member’s model and start a new discussion. Squabble research budgets do not control provider limits.',
    ],
    LOCAL_RATE_LIMIT: [
      '本地 Agent 的供应商限制了请求频率。本次任务已停止，未自动重试。请稍后新建讨论，或更换该角色的模型。Squabble 的研究预算不控制供应商限流。',
      'The local agent provider reported a rate limit. This task stopped and was not retried. Start a new discussion later, or change this member’s model. Squabble research budgets do not control provider rate limits.',
    ],
  };
  return code ? messages[code]?.[language === 'en' ? 1 : 0] : undefined;
}
