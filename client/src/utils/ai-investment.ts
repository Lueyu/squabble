import type { AiInvestmentView, InvestmentConstraint } from '@shared/investment-policy.interface';
import type { UserInvestmentStrategy } from '@shared/user-investment-strategy.interface';
import type { Market } from '@shared/api.interface';

export function displayInvestmentStatus(status: string, heartbeat: string | null, now = Date.now()): string {
  if (status !== 'running') return status;
  const last = heartbeat ? Date.parse(heartbeat) : NaN;
  return Number.isFinite(last) && now - last <= 120_000 && last <= now + 30_000 ? 'running' : 'offline';
}
/** Account configuration alone does not establish effective, currently monitored trade authority. */
export function effectiveInvestmentStatus(investment: AiInvestmentView | undefined,
  strategy: UserInvestmentStrategy | null | undefined = investment?.currentStrategy, now = Date.now()): string {
  if (!investment?.policy) return strategy ? 'not_applied' : investment?.status ?? 'not_started';
  if (!strategy) return 'observing';
  if (investment.currentStrategy?.id !== strategy.id || investment.currentStrategy.revision !== strategy.revision) return 'not_applied';
  if (investment.policy.status === 'paused') return 'paused';
  const entries = strategy.content.entries;
  const unexpired = entries.filter(entry => Date.parse(entry.endsAt ?? strategy.content.endsAt) > now);
  if (Date.parse(strategy.content.endsAt) <= now || entries.length > 0 && !unexpired.length) return 'expired';
  if (Date.parse(strategy.content.startsAt) > now || unexpired.length > 0
    && unexpired.every(entry => Date.parse(entry.startsAt ?? strategy.content.startsAt) > now)) return 'not_effective';
  if (investment.account?.botEnabled === false) return 'stopped';
  if (!strategy.preview) return 'configured';
  if (!strategy.preview.directives?.length && !strategy.preview.mandateRules?.length) return 'observation_only';
  const status = displayInvestmentStatus(investment.status, investment.lastHeartbeatAt, now);
  return status === 'running' && investment.cycles.some(cycle => ['queued', 'researching'].includes(cycle.state)) ? 'reassessing' : status;
}
export function investmentStatusLabel(status: string, zh: boolean): string {
  const labels: Record<string, string> = {
    observing: zh ? '已创建，先观察' : 'Created and observing',
    observation_only: zh ? '仅观察，不自动买卖' : 'Observation only, no automatic trades',
    not_applied: zh ? '已确认，尚未应用' : 'Confirmed, not applied',
    configured: zh ? '已确认配置，运行状态待核对' : 'Confirmed configuration; runtime needs verification',
    not_effective: zh ? '等待生效' : 'Starts later', expired: zh ? '已到期' : 'Expired',
    stopped: zh ? '自动交易已停止' : 'Automatic trading stopped',
    not_started: zh ? '尚未开启' : 'Not started', needs_information: zh ? '需要补充资料' : 'More information needed',
    needs_confirmation: zh ? '等待确认接管' : 'Awaiting takeover confirmation',
    running: zh ? '自动交易已开启' : 'Automatic trading enabled', paused: zh ? '自动交易已暂停' : 'Automatic trading paused',
    attention_required: zh ? '需要关注' : 'Attention needed', offline: zh ? '服务离线或心跳未知' : 'Service offline or heartbeat unknown',
    reassessing: zh ? '正在重新评估' : 'Reassessing current conditions',
  };
  return labels[status] ?? status;
}
export function validCashSeed(amount: string, currency: string): boolean {
  return amount.trim() !== '' && Number.isFinite(Number(amount)) && Number(amount) > 0 && ['USD', 'HKD', 'CNY'].includes(currency);
}
export function returnLabel(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}
export function constraintDraft(input: { kind: InvestmentConstraint['kind']; ticker?: string; percent?: string; markets?: Market[]; expiresAt?: string }, now = Date.now()): InvestmentConstraint | null {
  const expires = input.expiresAt ? Date.parse(input.expiresAt) : null;
  if (expires !== null && (!Number.isFinite(expires) || expires <= now)) return null;
  const expiresAt = expires == null ? null : new Date(expires).toISOString();
  const ticker = input.ticker?.trim().toUpperCase();
  if (['no_buy', 'no_sell', 'position_cap'].includes(input.kind) && (!ticker || !/^[A-Z0-9.^][A-Z0-9.^/_-]{0,19}$/u.test(ticker))) return null;
  if (input.kind === 'no_buy' || input.kind === 'no_sell') return { kind: input.kind, ticker: ticker!, expiresAt };
  if (input.kind === 'no_increase') return { kind: 'no_increase', expiresAt };
  if (input.kind === 'markets') {
    const markets = [...new Set(input.markets || [])];
    return markets.length && markets.every(value => ['US', 'HK', 'CN'].includes(value)) ? { kind: 'markets', markets, expiresAt } : null;
  }
  const percent = Number(input.percent);
  if (!input.percent?.trim() || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return input.kind === 'position_cap' ? { kind: 'position_cap', ticker: ticker!, percent, expiresAt } : { kind: 'cash_floor', percent, expiresAt };
}
