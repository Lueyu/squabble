import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { listSimulationExperiments, previewSimulationExperiment, createSimulationExperiment, selectSimulationExperiment,
  exchangeSimulationCash, reviewSimulationExperiment, archiveSimulationReview } from '@/api/simulation-experiments';
import type { SimulationPreview } from '@shared/simulation-experiment.interface';

function errorMessage(error: unknown): string {
  return (error as { response?: { data?: { message?: string } } })?.response?.data?.message
    ?? (error instanceof Error ? error.message : 'Request failed');
}
export function SimulationExperimentsPanel({ accountId, autoPreview = false }: { accountId?: string; autoPreview?: boolean }) {
  const { i18n } = useTranslation();
  const en = i18n.language.startsWith('en');
  const label = (zh: string, english: string) => en ? english : zh;
  const gapLabel = (gap: string) => {
    const [code, detail] = gap.split(':');
    const names: Record<string, [string, string]> = {
      CORPORATE_ACTIONS_UNSUPPORTED: ['尚未模拟分红、拆并股等公司行动', 'Dividends, splits and other corporate actions are not simulated'],
      CORPORATE_ACTION_RECONCILIATION_REQUIRED: ['已发现公司行动，受影响区间收益未知；需核对账本并新建实验', 'Detected corporate action: affected returns remain unknown until a reconciled new experiment is created'],
      PUBLIC_QUOTES_MAY_BE_DELAYED: ['公开报价可能延迟', 'Public quotes may be delayed'],
      CASH_UNKNOWN: ['真实盘未登记现金', 'Real-account cash is not recorded'],
      OPENING_ZERO_CASH_CONFIRMED_BY_USER: ['用户已明确确认期初零现金', 'Zero opening cash was explicitly confirmed'],
      CASH_AVAILABILITY_UNKNOWN: ['现金可用状态未知，已冻结', 'Cash availability unknown; frozen'],
      SELLABILITY_UNKNOWN: ['可售数量与限制未知，期初股数不可卖出', 'Sellability/restrictions unknown; opening shares blocked'],
      QUOTE_MISSING: ['缺少新鲜报价', 'Fresh quote unavailable'],
      FX_MISSING: ['缺少有效汇率', 'Valid FX unavailable'],
      INSTRUMENT_UNKNOWN: ['市场或币种不受支持', 'Unsupported market or currency'],
      NEGATIVE_OR_INVALID_SOURCE_BALANCE: ['源账本包含负数或无效余额', 'Source contains negative or invalid balances'],
      PERIOD_START_SNAPSHOT_MISSING: ['缺少对应期初净值记录，期间收益未知', 'Period opening NAV missing; period returns are unknown'],
      PERIOD_END_SNAPSHOT_MISSING: ['缺少指定期末净值，期间收益未知；最近记录仅供参考', 'Exact period closing NAV missing; period returns are unknown and the latest record is for reference only'],
      STRATEGY_BOUNDARY_VALUATION_MISSING: ['缺少策略版本生效或结束瞬间的净值，区间收益未知', 'NAV at the exact strategy-version boundary is missing; interval returns are unknown'],
      STRATEGY_TIMEZONE_CHANGED: ['策略业务时区发生变化，历史日期口径需核对', 'Strategy business timezone changed; historical date coverage needs review'],
      BENCHMARK_VALUATION_UNAVAILABLE: ['缺少对应期间的买入持有对照净值', 'Buy-and-hold NAV is unavailable for this period'],
      INDEX_BENCHMARK_VALUATION_UNAVAILABLE: ['指数对照的对应期间净值缺失', 'Index benchmark period NAV unavailable'],
      INDEX_BENCHMARK_QUOTE_MISSING: ['指数对照起点报价缺失，无法计算表现', 'Index benchmark opening quote unavailable; performance remains unknown'],
      LEGACY_SEED_UNKNOWN: ['此现金账户没有真实盘起点快照', 'This cash account has no real-account opening snapshot'],
    };
    const translated = names[code];
    return `${translated ? label(...translated) : gap}${detail ? ` · ${detail}` : ''}`;
  };
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<SimulationPreview | null>(null);
  const [name, setName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmNoCash, setConfirmNoCash] = useState(false);
  const [feeBps, setFeeBps] = useState('5');
  const [slippageBps, setSlippageBps] = useState('10');
  const [benchmarkTicker, setBenchmarkTicker] = useState<'SPY' | 'QQQ' | ''>('SPY');
  const [cashAvailable, setCashAvailable] = useState<Record<string, string>>({});
  const [sellableShares, setSellableShares] = useState<Record<string, string>>({});
  const requestKey = useRef(crypto.randomUUID());
  const autoOpened = useRef(false);
  const [period, setPeriod] = useState<{ accountId: string; from: string; to: string } | null>(null);
  const currentPeriod = period?.accountId === accountId ? period : null;
  const [exchangeFrom, setExchangeFrom] = useState('USD');
  const [exchangeTo, setExchangeTo] = useState('HKD');
  const [amount, setAmount] = useState('');
  const invalidate = () => { void cache.invalidateQueries({ queryKey: ['paper'] }); void cache.invalidateQueries({ queryKey: ['strategy'] }); };
  const experiments = useQuery({ queryKey: ['paper', 'experiments'], queryFn: listSimulationExperiments });
  const selected = experiments.data?.find((item) => item.id === accountId);
  const previewMutation = useMutation({ mutationFn: previewSimulationExperiment, onSuccess: (result) => {
    setPreview(result); setName(label('真实盘起点实验', 'Real-account experiment')); setAcknowledged(false); setConfirmNoCash(false);
    setFeeBps(String(result.seed.model.feeBps)); setSlippageBps(String(result.seed.model.slippageBps)); setBenchmarkTicker('SPY');
    setCashAvailable({}); setSellableShares({}); requestKey.current = crypto.randomUUID();
  }, onError: (error) => toast.error(errorMessage(error)) });
  const createMutation = useMutation({ mutationFn: async () => {
    if (!preview) throw new Error('Preview unavailable');
    return createSimulationExperiment({ previewId: preview.id, idempotencyKey: requestKey.current, name,
      acknowledgeGaps: acknowledged, cashAvailable, sellableShares, confirmNoCash,
      feeBps: Number(feeBps), slippageBps: Number(slippageBps), benchmarkTicker: benchmarkTicker || null });
  }, onSuccess: () => { setPreview(null); invalidate(); toast.success(label('已建立独立实验，旧账本保留', 'Independent experiment created; prior ledgers retained')); },
  onError: (error) => toast.error(errorMessage(error)) });
  const selectMutation = useMutation({ mutationFn: selectSimulationExperiment, onSuccess: invalidate,
    onError: (error) => toast.error(errorMessage(error)) });
  const exchangeMutation = useMutation({ mutationFn: () => exchangeSimulationCash(accountId!, { from: exchangeFrom, to: exchangeTo, amount: Number(amount) }),
    onSuccess: () => { setAmount(''); invalidate(); }, onError: (error) => toast.error(errorMessage(error)) });
  const review = useQuery({ queryKey: ['paper', 'review', accountId, currentPeriod?.from, currentPeriod?.to],
    queryFn: () => reviewSimulationExperiment(accountId!, currentPeriod?.from, currentPeriod?.to),
    enabled: Boolean(accountId && (!currentPeriod || currentPeriod.from && currentPeriod.to && currentPeriod.from <= currentPeriod.to)) });
  const from = currentPeriod?.from ?? review.data?.from ?? '';
  const to = currentPeriod?.to ?? review.data?.to ?? '';
  const businessToday = review.data?.timezone
    ? new Intl.DateTimeFormat('sv-SE', { timeZone: review.data.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) : null;
  const archive = useMutation({ mutationFn: () => archiveSimulationReview(accountId!, review.data!.from, review.data!.to),
    onSuccess: (version) => navigate(`/council?scene=trade_post_review&referenceVersionId=${encodeURIComponent(version.id)}`),
    onError: (error) => toast.error(errorMessage(error)) });
  useEffect(() => {
    if (autoPreview && !autoOpened.current) { autoOpened.current = true; previewMutation.mutate(); }
  }, [autoPreview, previewMutation]);

  return <Card>
    <CardHeader><CardTitle>{label('独立模拟实验', 'Independent paper experiments')}</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <select className="min-w-0 rounded-md border bg-background p-2 text-sm" aria-label={label('当前实验', 'Selected experiment')}
          value={accountId ?? ''} disabled={selectMutation.isPending} onChange={(event) => selectMutation.mutate(event.target.value)}>
          {!experiments.data?.length && <option value="">{label('暂无实验', 'No experiment')}</option>}
          {experiments.data?.map((item) => <option key={item.id} value={item.id}>{item.name} · {new Date(item.createdAt).toLocaleDateString()}</option>)}
        </select>
        <Button variant="outline" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>
          {previewMutation.isPending ? label('读取真实盘…', 'Reading real account…') : label('从真实盘创建新实验', 'Create from real account')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{label('切换会停止旧实验自动化并作废在途候选。每个实验保留独立现金、持仓和交易历史。',
        'Switching stops prior automation and invalidates pending candidates. Each experiment retains its own cash, positions and history.')}</p>
      {selected?.sourceChanged === true && <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{label(
        '真实盘已变化，当前实验起点保持不变，可新建实验。',
        'The real account has changed. This experiment keeps its original starting point; you can create a new experiment.')}</p>}
      {selected?.cash.length ? <div className="space-y-2">
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-muted-foreground">
          <th>{label('币种', 'Currency')}</th><th>{label('可用', 'Available')}</th><th>{label('冻结', 'Frozen')}</th><th>{label('未结算', 'Unsettled')}</th>
        </tr></thead><tbody>{selected.cash.map((cash) => <tr key={cash.currency}><td>{cash.currency}</td><td>{cash.available}</td><td>{cash.frozen}</td><td>{cash.unsettled}</td></tr>)}</tbody></table></div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded border bg-background p-2 text-sm" aria-label={label('兑换原币', 'Convert from')} value={exchangeFrom} onChange={(e) => setExchangeFrom(e.target.value)}>
            {['USD', 'HKD', 'CNY'].map((currency) => <option key={currency}>{currency}</option>)}
          </select><span>→</span>
          <select className="rounded border bg-background p-2 text-sm" aria-label={label('兑换目标币', 'Convert to')} value={exchangeTo} onChange={(e) => setExchangeTo(e.target.value)}>
            {['USD', 'HKD', 'CNY'].map((currency) => <option key={currency}>{currency}</option>)}
          </select>
          <Input className="w-32" type="number" min="0" aria-label={label('兑换金额', 'FX amount')} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Button variant="outline" disabled={exchangeMutation.isPending || !Number(amount) || exchangeFrom === exchangeTo} onClick={() => exchangeMutation.mutate()}>{label('按当前汇率兑换', 'Convert at current FX')}</Button>
        </div>
      </div> : null}
      <p className="text-xs text-muted-foreground">{label(`模型 paper-v1：费用 ${selected?.executionModel?.feeBps ?? 0} bps，滑点 ${selected?.executionModel?.slippageBps ?? 0} bps；美国现金 T+1、香港 T+2 于结算日收盘后释放，A股买入 T+1 可售。报价源报告起点后的分红、拆并股时将暂停，核对后需新建起点。港股每手数量未知或碎股市场暂不支持成交。`,
        `Model paper-v1: fees ${selected?.executionModel?.feeBps ?? 0} bps, slippage ${selected?.executionModel?.slippageBps ?? 0} bps; US cash T+1, HK cash T+2 (released at settlement-day close), CN purchases sellable T+1. Reported post-opening corporate actions pause execution pending a reconciled seed. HK unknown board lots and odd-lot matching are unsupported.`)}</p>
      <p className="text-xs text-muted-foreground">{label('当前仅模拟整笔市价成交；不支持限价单、部分成交、借券卖空或融资。公开行情可能延迟，停牌状态仅限报价源明确报告的事件。',
        'Only full market-order fills are simulated. Limit orders, partial fills, short borrowing and margin are unsupported. Public quotes may be delayed; halt detection covers events explicitly reported by the quote source.')}</p>
      <div className="border-t pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm">{label('期间复盘', 'Period review')}</strong>
          <Button size="sm" variant="ghost" disabled={!businessToday} onClick={() => { if (accountId && businessToday) setPeriod({ accountId, from: businessToday, to: businessToday }); }}>{label('当日', 'Today')}</Button>
          <Button size="sm" variant="ghost" disabled={!businessToday} onClick={() => { if (accountId && businessToday) setPeriod({ accountId, from: businessToday.slice(0, 8) + '01', to: businessToday }); }}>{label('当月', 'This month')}</Button>
          <Input className="w-40" type="date" aria-label={label('复盘开始日期', 'Review from')} value={from} onChange={(e) => { if (accountId) setPeriod({ accountId, from: e.target.value, to }); }} />
          <Input className="w-40" type="date" aria-label={label('复盘结束日期', 'Review to')} value={to} onChange={(e) => { if (accountId) setPeriod({ accountId, from, to: e.target.value }); }} />
        </div>
        {review.data && <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>{label('期间收益', 'Period profit')}<p className="font-mono">${review.data.profitUsd ?? '—'} ({review.data.returnPct ?? '—'}%)</p></div>
          <div>{label('起点买入持有净值', 'Seed buy-and-hold NAV')}<p className="font-mono">${review.data.buyAndHoldEquityUsd ?? '—'}</p></div>
          <div>{label('超额收益', 'Excess return')}<p className="font-mono">{review.data.excessReturnPct ?? '—'}%</p></div>
          <div>{label('成交 / 费用', 'Fills / fees')}<p className="font-mono">{review.data.orders} / ${review.data.feesUsd}</p></div>
          {review.data.indexBenchmarkTicker && <>
            <div>{review.data.indexBenchmarkTicker} {label('价格对照', 'price benchmark')}<p className="font-mono">${review.data.indexBenchmarkEquityUsd ?? '—'} ({review.data.indexBenchmarkReturnPct ?? '—'}%)</p></div>
            <div>{label('相对指数超额', 'Excess over index')}<p className="font-mono">{review.data.indexExcessReturnPct ?? '—'}%</p></div>
          </>}
        </div>}
        {review.data && <>
          <p className="mt-2 text-xs text-muted-foreground">{label('业务时区', 'Business timezone')}: {review.data.timezone} · {label('最近净值记录', 'Latest NAV record')}: {review.data.valuationAsOf ?? '—'}</p>
          <div className="mt-3 rounded-md border p-3 text-sm">
            <p>{label('观测样本最大回撤', 'Observed maximum drawdown')}: <span className="font-mono">{review.data.observedMaxDrawdownPct ?? '—'}%</span> · {label('有效净值样本', 'Valid NAV observations')}: {review.data.drawdownSampleCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">{review.data.drawdownCoverage === 'corporate_action_gap'
              ? label('公司行动造成受影响区间的估值缺口，回撤未知。', 'Corporate actions leave a valuation gap in this period; drawdown is unknown.')
              : review.data.drawdownCoverage === 'insufficient_samples'
                ? label('至少需要两条有效净值记录才能计算样本回撤。', 'At least two valid NAV observations are required to calculate observed drawdown.')
                : label('仅按已有净值样本计算，不代表盘中或未监控期间的最大回撤。', 'Calculated only from recorded NAV observations; this is not the maximum intraday or unmonitored-period drawdown.')}</p>
          </div>
          {!!review.data.strategyContributions?.length && <details className="mt-3 rounded-md border p-3">
            <summary className="text-sm font-medium">{label('策略版本区间与成交归属', 'Strategy-version intervals and fill attribution')}</summary>
            <p className="mt-2 text-xs text-muted-foreground">{label('区间净值变化包含同期手动交易、汇率等影响，不等于 AI 的因果贡献。成交和费用按原授权版本归属；旧版保护退出可在新版运行期间成交。',
              'Interval NAV changes can include manual trades, FX and other effects; they do not establish AI causation. Fills and fees retain their authorizing version, including older protective exits executed after a replacement.')}</p>
            <div className="mt-3 space-y-3">{review.data.strategyContributions.map((contribution) => <article key={contribution.mandateId} className="min-w-0 rounded-md bg-muted/30 p-3 text-sm">
              <p className="break-words font-medium">{contribution.title} · V{contribution.version}</p>
              <p className="mt-1 break-words text-xs text-muted-foreground">{new Date(contribution.from).toLocaleString(undefined, { timeZone: review.data!.timezone })} → {new Date(contribution.to).toLocaleString(undefined, { timeZone: review.data!.timezone })} ({review.data!.timezone})</p>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
                <p>{label('区间账本变化', 'Interval NAV change')}: <span className="font-mono">${contribution.profitUsd ?? '—'} ({contribution.returnPct ?? '—'}%)</span></p>
                <p>{label('归属成交 / 费用', 'Attributed fills / fees')}: <span className="font-mono">{contribution.orders} / ${contribution.feesUsd}</span></p>
              </div>
              {!!contribution.gaps.length && <ul className="mt-2 space-y-1 text-xs text-amber-700 dark:text-amber-400">{contribution.gaps.map((gap) => <li key={gap}>{gapLabel(gap)}</li>)}</ul>}
            </article>)}</div>
          </details>}
        </>}
        {review.data?.gaps.length ? <details className="mt-2 text-xs text-amber-700 dark:text-amber-400"><summary>{label('数据缺口与假设', 'Data gaps and assumptions')} ({review.data.gaps.length})</summary>
          <ul className="mt-2 space-y-1">{review.data.gaps.map((gap) => <li key={gap}>{gapLabel(gap)}</li>)}</ul></details> : null}
        {review.error && <p className="mt-2 text-sm text-destructive">{errorMessage(review.error)}</p>}
        <Button className="mt-3" variant="outline" disabled={!review.data || archive.isPending} onClick={() => archive.mutate()}>
          {label('保存复盘并进入讨论', 'Save review and discuss')}
        </Button>
      </div>
    </CardContent>
    <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open && !createMutation.isPending) setPreview(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{label('确认真实盘起点', 'Confirm real-account starting snapshot')}</DialogTitle>
          <DialogDescription>{label('只新建独立模拟账本，不改真实盘或任何旧实验。股数与现金直接结转，历史成本仅留作参考，不计入新实验收益。',
            'Creates an independent opening ledger. Shares and cash carry forward; historical cost is reference metadata and does not count as experiment profit.')}</DialogDescription>
        </DialogHeader>
        {preview && <div className="space-y-4">
          <label className="block text-sm">{label('实验名称', 'Experiment name')}<Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">{label('每笔费用（bps）', 'Fee per fill (bps)')}<Input type="number" min="0" max="100" value={feeBps} onChange={(e) => setFeeBps(e.target.value)} /></label>
            <label className="text-sm">{label('不利滑点（bps）', 'Adverse slippage (bps)')}<Input type="number" min="0" max="100" value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} /></label>
          </div>
          <p className="text-xs text-muted-foreground">{label('1 bps = 0.01%。费用从原币现金扣除，买入滑点上调价格、卖出滑点下调价格。参数在创建时固定，不代表特定券商真实费用。',
            '1 bps = 0.01%. Fees debit native cash; slippage raises buy prices and lowers sell prices. Parameters freeze at creation and do not represent a particular broker fee schedule.')}</p>
          <label className="block text-sm">{label('市场价格对照', 'Market price benchmark')}
            <select className="mt-1 w-full rounded border bg-background p-2" value={benchmarkTicker} onChange={(e) => setBenchmarkTicker(e.target.value as 'SPY' | 'QQQ' | '')}>
              <option value="">{label('仅起点买入持有对照', 'Opening buy-and-hold only')}</option>
              <option value="SPY">SPY · {label('标普500 ETF', 'S&P 500 ETF')}</option><option value="QQQ">QQQ · {label('纳斯达克100 ETF', 'Nasdaq 100 ETF')}</option>
            </select>
          </label>
          {benchmarkTicker && <p className="text-xs text-muted-foreground">{label('以同等起点净值全额持有ETF作为价格对照，不含分红再投资或费用。', 'Price-only comparison invests the same opening NAV in the ETF, excluding reinvested distributions and fees.')} {preview.seed.benchmarkOptions?.find((b) => b.ticker === benchmarkTicker)?.initialPrice ?? label('起点报价未知', 'Opening quote unavailable')} USD</p>}
          <p className="text-sm">{preview.seed.gaps.includes('CASH_UNKNOWN') ? label('已知资产估值（现金未知）', 'Known asset value (cash unknown)') : label('起点净值', 'Starting NAV')}: ${preview.seed.initialEquityUsd ?? label('无法估值', 'Unavailable')} · {new Date(preview.seed.capturedAt).toLocaleString()}</p>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>
            {[label('股票/币种', 'Ticker / currency'), label('股数', 'Shares'), label('历史成本', 'Historical cost'), label('起点价格', 'Starting mark'), label('确认可售股数', 'Confirm sellable shares')].map((title) => <th key={title} className="p-1">{title}</th>)}
          </tr></thead><tbody>{preview.seed.positions.map((p) => <tr key={p.sourceHoldingId} className="border-t">
            <td className="p-1">{p.ticker} / {p.currency}<div className="text-xs text-muted-foreground">{label('持仓截至', 'Source as of')} {new Date(p.sourceUpdatedAt).toLocaleString()}</div></td><td>{p.shares}</td><td>{p.historicalCost ?? '—'}</td>
            <td>{p.initialPrice ?? '—'}<div className="text-xs text-muted-foreground">{p.quoteAt ? new Date(p.quoteAt).toLocaleString() : '—'}</div></td>
            <td><Input className="w-28" type="number" min="0" max={p.shares} placeholder={label('未知→禁止卖', 'Unknown: blocked')}
              aria-label={`${p.ticker} ${label('可售数量', 'sellable shares')}`} value={sellableShares[p.ticker] ?? ''}
              onChange={(e) => setSellableShares((previous) => { const next = { ...previous }; if (e.target.value === '') delete next[p.ticker]; else next[p.ticker] = e.target.value; return next; })} /></td>
          </tr>)}</tbody></table></div>
          <div className="space-y-2">{preview.seed.cash.map((cash) => <label key={cash.currency} className="flex flex-wrap items-center gap-2 text-sm">
            {cash.currency} {label('总现金', 'total cash')} {cash.total} · {label('确认可用金额', 'Confirm available amount')}
            <span className="text-xs text-muted-foreground">{cash.sourceUpdatedAt ? new Date(cash.sourceUpdatedAt).toLocaleString() : ''}</span>
            <Input className="w-36" type="number" min="0" max={cash.total} placeholder={label('未知→冻结', 'Unknown: frozen')}
              value={cashAvailable[cash.currency] ?? ''} onChange={(e) => setCashAvailable((previous) => { const next = { ...previous }; if (e.target.value === '') delete next[cash.currency]; else next[cash.currency] = e.target.value; return next; })} />
          </label>)}</div>
          {preview.seed.gaps.includes('CASH_UNKNOWN') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmNoCash} onChange={(e) => setConfirmNoCash(e.target.checked)} />
            {label('真实盘未登记现金。我确认本实验期初现金为零。', 'No real cash is recorded. I explicitly confirm zero opening cash for this experiment.')}</label>}
          <div className="text-xs">{preview.seed.fx.map((fx) => <p key={fx.currency}>1 {fx.currency} = {fx.rate} USD · {fx.at}</p>)}</div>
          <p className="text-xs text-muted-foreground">{label('未填写可用现金会冻结全部现金；未填写可售股数会限制全部期初股数。缺少报价、汇率或非正净值时不能创建。',
            'Unconfirmed cash remains frozen and unconfirmed opening shares cannot be sold. Missing quotes, FX or non-positive NAV block creation.')}</p>
          <details className="text-xs" open><summary>{label('缺口与模型假设', 'Gaps and model assumptions')}</summary><ul>{preview.seed.gaps.map((gap) => <li key={gap}>{gapLabel(gap)}</li>)}</ul></details>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            {label('我已核对可售限制与现金状态，并确认所填费用、滑点和对照；了解行情可能延迟及公司行动需人工核对。',
              'I checked sellability and cash, confirm the fee/slippage/benchmark settings, and understand delayed quotes and corporate-action reconciliation.')}</label>
          <Button disabled={!acknowledged || !name.trim() || !preview.seed.initialEquityUsd || (preview.seed.gaps.includes('CASH_UNKNOWN') && !confirmNoCash) || createMutation.isPending} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? label('正在创建…', 'Creating…') : label('确认并创建新实验', 'Confirm and create experiment')}</Button>
        </div>}
      </DialogContent>
    </Dialog>
  </Card>;
}
