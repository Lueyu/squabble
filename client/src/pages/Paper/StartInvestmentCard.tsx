import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiInvestmentPreview, InvestmentConfig } from '@shared/investment-policy.interface';
import { startAiInvestment, restartAiInvestment } from '@/api/ai-investment';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createRequestIntent } from '@/utils/simple-experience';

export const limitLabels = (zh: boolean): Record<keyof InvestmentConfig['limits'], string> => ({
  maxPositionPct: zh ? '单股仓位上限' : 'Single position cap', maxOrderPct: zh ? '单笔新增买入上限' : 'Single purchase cap',
  maxDailyIncreasePct: zh ? '当日新增买入上限' : 'Daily purchase cap', maxDailyTurnoverPct: zh ? '当日普通买卖总额上限' : 'Daily ordinary turnover cap',
  maxGrossExposurePct: zh ? '总仓位上限' : 'Gross exposure cap', minCashPct: zh ? '最低现金比例' : 'Minimum cash', dailyLossLimitPct: zh ? '当日亏损限制' : 'Daily loss threshold',
});

export default function StartInvestmentCard({ preview, onStarted, onRefresh, restartAccountId }: {
  preview: AiInvestmentPreview; onStarted: () => void; onRefresh?: () => void; adoptAccountId?: string; restartAccountId?: string;
}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [extra, setExtra] = useState<Record<string, string>>({}); const [confirmCash, setConfirmCash] = useState(false);
  const [zeroCash, setZeroCash] = useState(false); const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const lock = useRef(false); const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const expired = Date.parse(preview.expiresAt) <= Date.now();
  const invalid = preview.seed.gaps.some(gap => /^(INSTRUMENT_UNKNOWN|NEGATIVE_OR_INVALID)/u.test(gap));
  const amountsValid = Object.values(extra).every(value => value.trim() === '' || Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e12);
  const unknownCash = preview.seed.cash.some(cash => !cash.availabilityKnown);
  const start = async () => {
    if (lock.current || expired || invalid || !amountsValid) return;
    lock.current = true; setPending(true); setError('');
    const payload = { previewId: preview.id, additionalVirtualCash: Object.fromEntries(Object.entries(extra).filter(([, value]) => value.trim() && Number(value) > 0).map(([currency, value]) => [currency, Number(value)])),
      ...(confirmCash ? { confirmOpeningCash: true } : {}), ...(zeroCash ? { confirmNoCash: true } : {}), ...(restartAccountId ? { expectedAccountId: restartAccountId } : {}) };
    try {
      const request = { ...payload, requestKey: intent.current.keyFor(payload) };
      if (restartAccountId) await restartAiInvestment({ ...request, expectedAccountId: restartAccountId }); else await startAiInvestment(request);
      intent.current.complete(); onStarted();
    } catch { setError(zh ? '创建尚未确认，请重试。起点有变化时请重新预览。' : 'Creation is unconfirmed. Retry, or refresh if the starting data changed.'); }
    finally { lock.current = false; setPending(false); }
  };
  return <section aria-label={zh ? '确认复制模拟盘' : 'Confirm paper portfolio copy'} className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">
    <h2 className="text-lg font-semibold">{zh ? '复制当前持仓' : 'Copy current holdings'}</h2>
    <p className="text-sm text-muted-foreground">{preview.seed.positions.length} {zh ? '项持仓' : 'positions'} · {new Date(preview.seed.capturedAt).toLocaleString(i18n.language)}</p>
    <div className="grid gap-3 sm:grid-cols-3">{(['USD', 'HKD', 'CNY'] as const).map(currency => {
      const cash = preview.seed.cash.find(item => item.currency === currency);
      return <div key={currency} className="space-y-2 rounded-lg bg-muted/30 p-3"><p className="text-sm font-medium">{currency} {cash?.total ?? '—'} <span className="text-xs text-muted-foreground">{cash ? cash.availabilityKnown ? (zh ? '已核对现金' : 'Confirmed cash') : (zh ? '待核对现金' : 'Unconfirmed cash') : (zh ? '未记录现金' : 'Cash not recorded')}</span></p>
        <label className="block space-y-1 text-xs"><span>{zh ? '额外模拟现金（可选）' : 'Additional virtual cash (optional)'}</span><Input type="number" min="0" step="any" value={extra[currency] ?? ''} onChange={event => setExtra(current => ({ ...current, [currency]: event.target.value }))} /></label></div>;
    })}</div>
    {unknownCash && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmCash} onChange={event => setConfirmCash(event.target.checked)} /><span>{zh ? '以上记录现金已核对，可用于此模拟盘。未确认时保留待核对状态。' : 'I checked the recorded cash amounts for this simulation. Otherwise they remain unconfirmed.'}</span></label>}
    {preview.seed.gaps.includes('CASH_UNKNOWN') && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={zeroCash} onChange={event => setZeroCash(event.target.checked)} /><span>{zh ? '以零记录现金假设开始（不影响额外模拟现金）。' : 'Assume zero recorded cash, in addition to any virtual cash.'}</span></label>}
    <p className="text-sm leading-6 text-muted-foreground">{zh ? '创建后先观察，再到今日选择并应用投资策略。额外资金只进入模拟账本，之后真实交易不会自动同步。' : 'The account starts in observation. Choose and apply your strategy from Today to run it. Virtual cash stays in the simulation; later real trades do not sync.'}</p>
    {preview.seed.initialEquityUsd === null && <p role="status" className="text-sm text-muted-foreground">{zh ? '可以先建立账本。行情、汇率或现金未齐时等待，收益从首次可信完整估值开始。' : 'You can create the ledger now. Missing quotes, FX or confirmed cash keep it waiting; returns start at the first reliable complete valuation.'}</p>}
    {restartAccountId && <p className="text-sm leading-6">{zh ? '当前模拟盘将归档，历史成交保留；本次建立新的独立起点。' : 'The current simulation will be archived with its trades preserved; this creates a separate starting point.'}</p>}
    {invalid && <p role="alert" className="text-sm text-destructive">{zh ? '请先补全证券币种或修正无效余额。' : 'Complete the security currency or correct invalid balances first.'}</p>}
    {expired && <p role="alert" className="text-sm">{zh ? '预览已过期，请重新预览。' : 'Preview expired. Refresh the starting point.'}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={pending || expired || invalid || !amountsValid} onClick={() => void start()}>{pending ? (zh ? '正在创建…' : 'Creating…') : (zh ? '确认复制并观察' : 'Copy and observe')}</Button>{onRefresh && <Button variant="outline" disabled={pending} onClick={onRefresh}>{zh ? '重新预览' : 'Refresh preview'}</Button>}</div>
  </section>;
}
