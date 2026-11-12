import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiInvestmentPreview, InvestmentConfig, InvestmentStartRequest } from '@shared/investment-policy.interface';
import { startAiInvestment, restartAiInvestment } from '@/api/ai-investment';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createRequestIntent } from '@/utils/simple-experience';

export const limitLabels = (zh: boolean): Record<keyof InvestmentConfig['limits'], string> => ({
  maxPositionPct: zh ? '单股仓位上限' : 'Single position cap', maxOrderPct: zh ? '单笔新增买入上限' : 'Single purchase cap',
  maxDailyIncreasePct: zh ? '当日新增买入上限' : 'Daily purchase cap', maxDailyTurnoverPct: zh ? '当日普通买卖总额上限' : 'Daily ordinary turnover cap',
  maxGrossExposurePct: zh ? '总仓位上限' : 'Gross exposure cap', minCashPct: zh ? '最低现金比例' : 'Minimum cash', dailyLossLimitPct: zh ? '当日亏损限制' : 'Daily loss threshold',
});

export default function StartInvestmentCard({ preview, onStarted, onRefresh, onCancel, restartAccountId, onCreate, createdAccount = false, receiptPending = false }: {
  preview: AiInvestmentPreview; onStarted: () => void; onRefresh?: () => void; onCancel?: () => void; adoptAccountId?: string; restartAccountId?: string;
  onCreate?: (request: InvestmentStartRequest) => Promise<void>;
  createdAccount?: boolean;
  receiptPending?: boolean;
}) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [extra, setExtra] = useState<Record<string, string>>({}); const [confirmCash, setConfirmCash] = useState(false);
  const [zeroCash, setZeroCash] = useState(false); const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const lock = useRef(false); const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const expired = Date.parse(preview.expiresAt) <= Date.now();
  const invalid = preview.seed.gaps.some(gap => /^(INSTRUMENT_UNKNOWN|NEGATIVE_OR_INVALID)/u.test(gap));
  const amountsValid = Object.values(extra).every(value => value.trim() === '' || Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e12);
  const unknownCash = preview.seed.cash.some(cash => !cash.availabilityKnown);
  const frozen = createdAccount || receiptPending;
  const start = async () => {
    if (lock.current || !frozen && (expired || invalid || !amountsValid)) return;
    lock.current = true; setPending(true); setError('');
    const payload = { previewId: preview.id, additionalVirtualCash: Object.fromEntries(Object.entries(extra).filter(([, value]) => value.trim() && Number(value) > 0).map(([currency, value]) => [currency, Number(value)])),
      ...(confirmCash ? { confirmOpeningCash: true } : {}), ...(zeroCash ? { confirmNoCash: true } : {}), ...(restartAccountId ? { expectedAccountId: restartAccountId } : {}) };
    try {
      const request = { ...payload, requestKey: intent.current.keyFor(payload) };
      if (onCreate) await onCreate(request);
      else if (restartAccountId) await restartAiInvestment({ ...request, expectedAccountId: restartAccountId });
      else await startAiInvestment(request);
      intent.current.complete(); onStarted();
    } catch { setError(zh ? '创建尚未确认，请重试。起点有变化时请重新预览。' : 'Creation is unconfirmed. Retry, or refresh if the starting data changed.'); }
    finally { lock.current = false; setPending(false); }
  };
  return <section aria-label={zh ? '确认模拟账户起点' : 'Confirm the simulation starting point'} className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">
    <h2 className="text-lg font-semibold">{zh ? '确认模拟账户起点' : 'Confirm the simulation starting point'}</h2>
    <p className="text-sm text-muted-foreground">{preview.seed.positions.length} {zh ? '项持仓' : 'positions'} · {new Date(preview.seed.capturedAt).toLocaleString(i18n.language)}</p>
    {preview.seed.origin?.kind === 'simulation_account' && <p className="text-sm">{zh ? '已冻结来源账户：' : 'Frozen source account: '}{preview.seed.origin.accountName}</p>}
    <p className="text-sm leading-6 text-muted-foreground">{zh ? '按可用行情和汇率建立新起点。参考成本只作记录，收益从新账户的可信估值向前计算，不是历史回测。' : 'Available market quotes and FX establish a new starting value. Reference costs are recorded separately; returns begin from the new account’s reliable valuation, with no historical backtest.'}</p>
    {preview.seed.positions.length > 0 && <div className="overflow-x-auto rounded-lg border">
      <table className="companion-seed-table"><caption className="sr-only">{zh ? '冻结的初始持仓' : 'Frozen opening holdings'}</caption>
        <thead><tr>{(zh ? ['证券', '数量', '参考成本', '起点行情', '行情时间'] : ['Security', 'Quantity', 'Reference cost', 'Starting quote', 'Quote time']).map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{preview.seed.positions.map(position => <tr key={position.ticker}>
          <th scope="row">{position.ticker}<span className="block text-xs font-normal text-muted-foreground">{position.market} · {position.currency}</span></th>
          <td>{position.shares}</td><td>{position.historicalCost ?? '—'}</td><td>{position.initialPrice ?? '—'}</td>
          <td>{position.quoteAt ? new Date(position.quoteAt).toLocaleString(i18n.language) : zh ? '等待行情' : 'Awaiting quote'}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    <div className="grid gap-3 sm:grid-cols-3">{(['USD', 'HKD', 'CNY'] as const).map(currency => {
      const cash = preview.seed.cash.find(item => item.currency === currency);
      return <div key={currency} className="space-y-2 rounded-lg bg-muted/30 p-3"><p className="text-sm font-medium">{currency} {cash?.total ?? '—'} <span className="text-xs text-muted-foreground">{cash ? cash.availabilityKnown ? (zh ? '已核对现金' : 'Confirmed cash') : (zh ? '待核对现金' : 'Unconfirmed cash') : (zh ? '未记录现金' : 'Cash not recorded')}</span></p>
        <label className="block space-y-1 text-xs"><span>{zh ? '额外模拟现金（可选）' : 'Additional virtual cash (optional)'}</span><Input disabled={pending || frozen} type="number" min="0" step="any" value={extra[currency] ?? ''} onChange={event => setExtra(current => ({ ...current, [currency]: event.target.value }))} /></label></div>;
    })}</div>
    {unknownCash && <label className="flex items-start gap-2 text-sm"><input disabled={pending || frozen} type="checkbox" className="mt-1" checked={confirmCash} onChange={event => setConfirmCash(event.target.checked)} /><span>{zh ? '以上记录现金已核对，可用于此模拟盘。未确认时保留待核对状态。' : 'I checked the recorded cash amounts for this simulation. Otherwise they remain unconfirmed.'}</span></label>}
    {preview.seed.gaps.includes('CASH_UNKNOWN') && <label className="flex items-start gap-2 text-sm"><input disabled={pending || frozen} type="checkbox" className="mt-1" checked={zeroCash} onChange={event => setZeroCash(event.target.checked)} /><span>{zh ? '以零记录现金假设开始（不影响额外模拟现金）。' : 'Assume zero recorded cash, in addition to any virtual cash.'}</span></label>}
    <p className="text-sm leading-6 text-muted-foreground">{zh ? '创建后先观察，在本页核对并启用策略。额外资金只进入模拟账本，之后真实交易不会自动同步。' : 'The account starts in observation. Review and apply your strategy on this page to run it. Virtual cash stays in the simulation; later real trades do not sync.'}</p>
    {preview.seed.initialEquityUsd === null && <p role="status" className="text-sm text-muted-foreground">{zh ? '可以先建立账本。行情、汇率或现金未齐时等待，收益从首次可信完整估值开始。' : 'You can create the ledger now. Missing quotes, FX or confirmed cash keep it waiting; returns start at the first reliable complete valuation.'}</p>}
    {restartAccountId && <p className="text-sm leading-6">{zh ? '当前模拟盘将归档，历史成交保留；本次建立新的独立起点。' : 'The current simulation will be archived with its trades preserved; this creates a separate starting point.'}</p>}
    {invalid && <p role="alert" className="text-sm text-destructive">{zh ? '请先补全证券币种或修正无效余额。' : 'Complete the security currency or correct invalid balances first.'}</p>}
    {expired && !frozen && <p role="alert" className="text-sm">{zh ? '预览已过期，请重新预览。' : 'Preview expired. Refresh the starting point.'}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={pending || !frozen && (expired || invalid || !amountsValid)} onClick={() => void start()}>{pending ? (zh ? '正在保存…' : 'Saving…') : createdAccount ? (zh ? '重试保存账户风格' : 'Retry account style') : receiptPending ? (zh ? '重试确认创建结果' : 'Retry creation confirmation') : onCreate ? (zh ? '确认创建并观察' : 'Create and observe') : (zh ? '确认复制并观察' : 'Copy and observe')}</Button>{onRefresh && <Button variant="outline" disabled={pending} onClick={onRefresh}>{zh ? '重新预览' : 'Refresh preview'}</Button>}{onCancel && <Button variant="ghost" disabled={pending} onClick={onCancel}>{frozen ? (zh ? '关闭' : 'Close') : onCreate ? (zh ? '取消创建' : 'Cancel creation') : (zh ? '取消复制' : 'Cancel copy')}</Button>}</div>
  </section>;
}
