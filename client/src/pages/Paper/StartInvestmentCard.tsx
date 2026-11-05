import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Market } from '@shared/api.interface';
import type { AiInvestmentPreview, InvestmentConfig } from '@shared/investment-policy.interface';
import { startAiInvestment, restartAiInvestment, marketLabel } from '@/api/ai-investment';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createRequestIntent } from '@/utils/simple-experience';

export const limitLabels = (zh: boolean): Record<keyof InvestmentConfig['limits'], string> => ({
  maxPositionPct: zh ? '单股仓位上限' : 'Single position cap', maxOrderPct: zh ? '单笔新增买入上限' : 'Single purchase cap',
  maxDailyIncreasePct: zh ? '当日新增买入上限' : 'Daily purchase cap', maxDailyTurnoverPct: zh ? '当日普通买卖总额上限' : 'Daily ordinary turnover cap',
  maxGrossExposurePct: zh ? '总仓位上限' : 'Gross exposure cap', minCashPct: zh ? '最低现金比例' : 'Minimum cash', dailyLossLimitPct: zh ? '当日亏损限制' : 'Daily loss threshold',
});

export default function StartInvestmentCard({ preview, onStarted, onRefresh, adoptAccountId, restartAccountId }: {
  preview: AiInvestmentPreview; onStarted: () => void; onRefresh?: () => void; adoptAccountId?: string; restartAccountId?: string;
}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [markets, setMarkets] = useState<Market[]>(preview.markets);
  const [limits, setLimits] = useState(preview.limits); const [zeroCash, setZeroCash] = useState(false);
  const [available, setAvailable] = useState<Record<string, string>>({}); const [sellable, setSellable] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const lock = useRef(false); const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const hardGaps = preview.needsInput.filter(gap => /^(QUOTE_MISSING|FX_MISSING|INSTRUMENT_UNKNOWN|NEGATIVE_OR_INVALID|IMPORT_HOLDINGS)/u.test(gap));
  const cashNeeds = preview.seed.cash.filter(cash => !cash.availabilityKnown);
  const positionNeeds = preview.seed.positions.filter(position => position.sellableShares == null);
  const validAmounts = cashNeeds.every(cash => available[cash.currency]?.trim() !== '' && available[cash.currency] != null && Number.isFinite(Number(available[cash.currency])) && Number(available[cash.currency]) >= 0 && Number(available[cash.currency]) <= Number(cash.total))
    && positionNeeds.every(position => sellable[position.ticker]?.trim() !== '' && sellable[position.ticker] != null && Number.isFinite(Number(sellable[position.ticker])) && Number(sellable[position.ticker]) >= 0 && Number(sellable[position.ticker]) <= Number(position.shares));
  const validLimits = Object.values(limits).every(value => Number.isFinite(value) && value >= 0 && value <= 100);
  const expired = Date.parse(preview.expiresAt) <= Date.now();
  const ready = !hardGaps.length && markets.length > 0 && validAmounts && validLimits && (!preview.needsInput.includes('CASH_UNKNOWN') || zeroCash) && !expired;
  const start = async () => {
    if (!ready || lock.current) return; lock.current = true; setPending(true); setError('');
    const payload = { previewId: preview.previewId, markets, limits, ...(zeroCash ? { confirmNoCash: true } : {}),
      ...(cashNeeds.length ? { cashAvailable: Object.fromEntries(cashNeeds.map(cash => [cash.currency, Number(available[cash.currency])])) } : {}),
      ...(positionNeeds.length ? { sellableShares: Object.fromEntries(positionNeeds.map(position => [position.ticker, Number(sellable[position.ticker])])) } : {}),
      ...(adoptAccountId ? { adoptAccountId } : {}), ...(restartAccountId ? { expectedAccountId: restartAccountId } : {}) };
    try {
      const request = { ...payload, requestKey: intent.current.keyFor(payload) };
      if (restartAccountId) await restartAiInvestment({ ...request, expectedAccountId: restartAccountId });
      else await startAiInvestment(request);
      intent.current.complete(); onStarted();
    } catch (cause) {
      const code = String((cause as { response?: { data?: { message?: string } } }).response?.data?.message || '');
      setError(/SOURCE_CHANGED|PREVIEW_EXPIRED/u.test(code)
        ? (zh ? '起点资料已改变或确认已过期，请重新预览。' : 'Starting data changed or the preview expired. Preview again.')
        : (zh ? '尚未确认开启。请核对资料并重试；同一次请求不会重复开户。' : 'Start was not confirmed. Check the information and retry; the same request will not create another account.'));
    } finally { lock.current = false; setPending(false); }
  };
  const labels = limitLabels(zh);
  return <section className="space-y-5 rounded-xl border bg-card p-4 sm:p-6" aria-label={zh ? '开启投资确认' : 'Confirm investment start'}>
    <h2 className="text-lg font-semibold">{restartAccountId ? (zh ? '确认重新开始' : 'Confirm a fresh start') : (zh ? '核对起点，开启 AI 投资' : 'Review the starting point and enable AI investing')}</h2>
    {adoptAccountId && <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm leading-6">{zh ? '旧自动交易将暂停，核对新的投资范围后继续。原有成交和账本保留。' : 'Legacy automatic trading will pause. Review the new investment scope before continuing. Existing trades and the ledger are preserved.'}</p>}
    {restartAccountId && <p className="text-sm leading-6">{zh ? '旧账户将归档为只读，原成交和讨论保留。新账户使用本卡起点，不合并或覆盖旧资产。' : 'The old account becomes read-only history; trades and discussions remain. The new account uses this starting point without merging or overwriting assets.'}</p>}
    <div className="grid gap-3 sm:grid-cols-2"><div><h3 className="text-sm font-medium">{zh ? '起点持仓' : 'Starting holdings'}</h3>{preview.seed.positions.length ? <ul className="mt-2 space-y-1 text-sm text-muted-foreground">{preview.seed.positions.map(position => <li key={position.ticker}>{position.ticker} · {position.shares} · {position.currency}</li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">{zh ? '无持仓，使用明确选择的模拟现金。' : 'No positions; uses your explicit simulated cash choice.'}</p>}</div>
      <div><h3 className="text-sm font-medium">{zh ? '起点现金' : 'Starting cash'}</h3>{preview.seed.cash.length ? preview.seed.cash.map(cash => <p key={cash.currency} className="mt-2 text-sm text-muted-foreground">{cash.currency} {cash.total}</p>) : <p className="mt-2 text-sm text-muted-foreground">{zh ? '现金未知' : 'Cash unknown'}</p>}<p className="mt-3 text-sm">{zh ? '起点估值（美元）：' : 'Starting valuation (USD): '}{preview.seed.initialEquityUsd ?? '—'}</p></div></div>
    <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{zh ? '允许的投资市场' : 'Allowed investment markets'}</legend><div className="flex flex-wrap gap-5">{(['US', 'HK', 'CN'] as Market[]).map(market => <label key={market} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={markets.includes(market)} onChange={event => setMarkets(current => event.target.checked ? [...current, market] : current.filter(item => item !== market))} />{marketLabel(market, zh)}</label>)}</div></fieldset>
    <p className="text-sm leading-6 text-muted-foreground">{zh ? '团队可在以上市场自主发现普通股票与非杠杆 ETF，仅做多、不借款。新股首笔买入需要两个实际独立来源复核；不足时等待。' : 'The team may discover ordinary stocks and non-leveraged ETFs in these markets, long-only without borrowing. A new stock’s first purchase requires two actual independent review sources; otherwise it waits.'}</p>
    {preview.needsInput.includes('CASH_UNKNOWN') && <label className="flex items-start gap-2 rounded-lg border p-3 text-sm leading-6"><input type="checkbox" className="mt-1" checked={zeroCash} onChange={event => setZeroCash(event.target.checked)} /><span>{zh ? '我明确选择以零现金假设开始。实际现金未被完整复制。' : 'I explicitly assume zero cash. Actual cash has not been fully copied.'}</span></label>}
    {cashNeeds.map(cash => <label key={cash.currency} className="block max-w-sm space-y-2 text-sm"><span>{zh ? '可用现金' : 'Available cash'} · {cash.currency} ({zh ? '总额' : 'total'} {cash.total})</span><Input type="number" min="0" max={cash.total} value={available[cash.currency] ?? ''} onChange={event => setAvailable(current => ({ ...current, [cash.currency]: event.target.value }))} /></label>)}
    {positionNeeds.map(position => <label key={position.ticker} className="block max-w-sm space-y-2 text-sm"><span>{position.ticker} · {zh ? '可卖出股数' : 'Sellable shares'} (0–{position.shares})</span><Input type="number" min="0" max={position.shares} value={sellable[position.ticker] ?? ''} onChange={event => setSellable(current => ({ ...current, [position.ticker]: event.target.value }))} /></label>)}
    {!!hardGaps.length && <div role="status" className="space-y-2 rounded-lg border p-3 text-sm"><p>{zh ? '需要补全可信估值或证券资料后才能开启。' : 'Verified valuation or security details are required before starting.'}</p><ul className="list-inside list-disc">{hardGaps.map(gap => <li key={gap}>{gap}</li>)}</ul><Link to="/holdings" className="text-primary underline">{zh ? '补全持仓资料' : 'Complete holding details'}</Link></div>}
    {!!preview.inheritedConcentration.length && <p className="rounded-lg bg-amber-500/5 p-3 text-sm leading-6">{zh ? '继承的集中持仓：' : 'Inherited concentrated positions: '}{preview.inheritedConcentration.join(', ')}。{zh ? '限制进一步扩大，不会因为导入就强制卖出。' : 'Further increases are restricted; importing does not force a sale.'}</p>}
    <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{zh ? '查看和调整限制' : 'Review and adjust limits'}</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">{(Object.keys(labels) as Array<keyof InvestmentConfig['limits']>).map(key => <label key={key} className="space-y-1 text-sm"><span>{labels[key]} (%)</span><Input type="number" min="0" max="100" value={limits[key]} onChange={event => setLimits(current => ({ ...current, [key]: Number(event.target.value) }))} /></label>)}</div><p className="mt-4 text-xs leading-6 text-muted-foreground">{zh ? `每天最多 ${preview.budget.dailyTasks} 个自动研究任务，每任务最多 ${preview.budget.maxCallsPerTask} 次模型或 Agent 调用；更严格的现有预算优先。` : `Up to ${preview.budget.dailyTasks} automatic research tasks per day and ${preview.budget.maxCallsPerTask} model or agent calls per task. Existing stricter budgets take priority.`}</p></details>
    <p className="text-xs text-muted-foreground">{zh ? '成交费用' : 'Trading fee'} {preview.seed.model.feeBps} bps · {zh ? '滑点' : 'Slippage'} {preview.seed.model.slippageBps} bps · {zh ? '仅使用原币可用现金，不自动换汇' : 'Uses available original-currency cash without automatic FX'}</p>
    {expired && <p role="alert" className="text-sm">{zh ? '预览已过期，请重新预览。' : 'The preview expired. Preview again.'}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={!ready || pending} onClick={() => void start()}>{pending ? (zh ? '正在开启…' : 'Starting…') : restartAccountId ? (zh ? '确认归档并重新开始' : 'Archive and start again') : (zh ? '开启 AI 投资' : 'Enable AI investing')}</Button>{onRefresh && <Button variant="outline" disabled={pending} onClick={onRefresh}>{zh ? '重新预览' : 'Preview again'}</Button>}</div>
  </section>;
}
