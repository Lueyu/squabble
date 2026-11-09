import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { simulationReviewGapText } from '@shared/simulation-review-reading';
import type { AiInvestmentPreview, InvestmentConstraint } from '@shared/investment-policy.interface';
import { fetchAiInvestment, previewAiInvestment, pauseAiInvestment, resumeAiInvestment, pauseLegacyInvestment, proposeInvestmentConstraint, revokeInvestmentConstraint, type ConstraintProposal } from '@/api/ai-investment';
import { reviewSimulationExperiment, listSimulationExperiments } from '@/api/simulation-experiments';
import { fetchStrategyMandates } from '@/api/strategy-mandates';
import { createRequestIntent } from '@/utils/simple-experience';
import { constraintDraft, effectiveInvestmentStatus, returnLabel, validCashSeed } from '@/utils/ai-investment';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ConstraintProposalCard from '@/pages/Council/ConstraintProposalCard';
import InvestmentStatus from './InvestmentStatus';
import StartInvestmentCard, { limitLabels } from './StartInvestmentCard';
import DecisionCard from './DecisionCard';
import LegacyDecisionPage from './LegacyDecisionPage';
import InvestmentStrategySection from '@/features/investment-strategies/InvestmentStrategySection';

export function constraintLabel(constraint: InvestmentConstraint, zh: boolean) {
  switch (constraint.kind) {
    case 'no_buy': return `${constraint.ticker} · ${zh ? '禁止新增买入' : 'No additional buys'}`;
    case 'no_sell': return `${constraint.ticker} · ${zh ? '禁止卖出（包括自动止损）' : 'No sales (including stop-loss)'}`;
    case 'no_increase': return zh ? '停止增加风险仓位' : 'No position increases';
    case 'position_cap': return `${constraint.ticker} · ${zh ? '仓位上限' : 'Position cap'} ${constraint.percent}%`;
    case 'cash_floor': return `${zh ? '最低现金' : 'Minimum cash'} ${constraint.percent}%`;
    case 'markets': return `${zh ? '允许市场' : 'Allowed markets'}: ${constraint.markets.join(', ')}`;
  }
}

export default function AiInvestmentPage() {
  const [params] = useSearchParams();
  if (params.has('strategyId')) return <LegacyDecisionPage strategyId={params.get('strategyId')!} versionId={params.get('sourceReportVersionId') || undefined} />;
  return <AiInvestmentAccount />;
}

function AiInvestmentAccount() {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh'); const client = useQueryClient();
  const [params] = useSearchParams();
  const location = useLocation(); const navigate = useNavigate(); const seedReal = params.get('seedReal') === '1';
  const requestedStrategyId = params.get('investmentStrategyId');
  const requestedOrderId = params.get('orderId');
  const locatedOrder = useRef<string | null>(null);
  const query = useQuery({ queryKey: ['ai-investment'], queryFn: fetchAiInvestment, refetchInterval: 10_000 });
  const data = query.data; const accountId = data?.account?.id;
  const review = useQuery({ queryKey: ['investment-performance', accountId], queryFn: () => reviewSimulationExperiment(accountId!), enabled: Boolean(accountId), refetchInterval: 30_000, retry: false });
  const decisions = useQuery({ queryKey: ['investment-decisions', accountId], queryFn: () => fetchStrategyMandates(accountId!), enabled: Boolean(accountId), refetchInterval: 15_000 });
  const [preview, setPreview] = useState<AiInvestmentPreview | null>(null); const [cashMode, setCashMode] = useState(false);
  const [previewAccountId, setPreviewAccountId] = useState<string | undefined>();
  const [previewPending, setPreviewPending] = useState(false); const [previewError, setPreviewError] = useState('');
  const previewLock = useRef(false); const previewGeneration = useRef(0); const seedHandled = useRef(false);
  const previewIntent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const [amount, setAmount] = useState(''); const [currency, setCurrency] = useState<'USD' | 'HKD' | 'CNY'>('USD');
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const [restart, setRestart] = useState(false); const [historyOpen, setHistoryOpen] = useState(false);
  const [restriction, setRestriction] = useState(''); const [proposal, setProposal] = useState<ConstraintProposal | null>(null);
  const [restrictionKind, setRestrictionKind] = useState<'text' | InvestmentConstraint['kind']>('text');
  const [restrictionTicker, setRestrictionTicker] = useState(''); const [restrictionPercent, setRestrictionPercent] = useState('');
  const [restrictionMarkets, setRestrictionMarkets] = useState<Array<'US' | 'HK' | 'CN'>>([]); const [restrictionExpiry, setRestrictionExpiry] = useState('');
  const intent = useRef(createRequestIntent(() => crypto.randomUUID())); const lock = useRef(false);
  const history = useQuery({ queryKey: ['investment-history'], queryFn: listSimulationExperiments, enabled: historyOpen || Boolean(data?.policy), retry: false });
  useEffect(() => {
    if (!requestedOrderId) { locatedOrder.current = null; return; }
    if (locatedOrder.current === requestedOrderId) return;
    const element = document.getElementById(`paper-order-${requestedOrderId}`);
    if (!element) return;
    element.scrollIntoView({ block: 'center' });
    locatedOrder.current = requestedOrderId;
  }, [requestedOrderId, data?.actions]);
  const mutate = async (kind: string, payload: object, work: (requestKey: string) => Promise<unknown>, after?: () => void) => {
    if (lock.current) return; lock.current = true; setPending(true); setError('');
    try { await work(intent.current.keyFor({ kind, ...payload })); intent.current.complete(); after?.(); await client.invalidateQueries({ queryKey: ['ai-investment'] }); }
    catch { setError(zh ? '操作未能确认。请重试；重试沿用同一次请求，不会重复处理。' : 'The operation could not be confirmed. Retry reuses the same request and will not duplicate it.'); }
    finally { lock.current = false; setPending(false); }
  };
  const hasPolicy = Boolean(data?.policy);
  const prepare = useCallback(async (cash = cashMode) => {
    if (previewLock.current || cash && !validCashSeed(amount, currency)) return;
    previewLock.current = true;
    const generation = ++previewGeneration.current;
    // A polling update must never redirect this confirmation to a different account.
    const expectedAccountId = hasPolicy ? accountId : undefined;
    setCashMode(cash); setRestart(hasPolicy); setPreview(null); setPreviewPending(true); setPreviewError('');
    const payload = cash ? { origin: 'cash' as const, cash: { amount: Number(amount), currency } } : { origin: 'holdings' as const };
    try {
      const result = await previewAiInvestment({ ...payload, requestKey: previewIntent.current.keyFor(payload) });
      if (generation !== previewGeneration.current) return;
      setPreviewAccountId(expectedAccountId); setPreview(result); previewIntent.current.complete();
    } catch {
      if (generation === previewGeneration.current) setPreviewError(cash
        ? (zh ? '模拟现金预览未能完成，请重试。' : 'The simulated cash preview could not be prepared. Please retry.')
        : (zh ? '持仓预览未能完成，请重试。持仓较多时可能需要更长时间。' : 'The holdings preview could not be prepared. Please retry; many positions can take longer.'));
    } finally {
      if (generation === previewGeneration.current) { previewLock.current = false; setPreviewPending(false); }
    }
  }, [cashMode, amount, currency, hasPolicy, accountId, zh]);
  useEffect(() => {
    if (!seedReal) { seedHandled.current = false; return; }
    if (query.isPending || !data || seedHandled.current) return;
    seedHandled.current = true;
    void prepare(false);
  }, [seedReal, query.isPending, data, prepare]);
  const clearSeedReal = () => {
    if (!params.has('seedReal')) return;
    const next = new URLSearchParams(location.search); next.delete('seedReal');
    navigate({ pathname: location.pathname, search: next.toString(), hash: location.hash }, { replace: true });
  };
  const cancelPreview = () => {
    ++previewGeneration.current; previewLock.current = false; previewIntent.current.complete();
    setPreview(null); setPreviewPending(false); setPreviewError(''); setRestart(false); clearSeedReal();
  };
  if (query.isPending) return <p role="status" className="p-6">{zh ? '正在读取 AI 账户…' : 'Loading AI account…'}</p>;
  if (!data) return <div role="alert" className="space-y-3 p-6"><p>{zh ? 'AI 账户暂时不可用。' : 'The AI account is unavailable.'}</p><Button onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>;
  const started = Boolean(data.policy); const reviewData = review.data;
  const percentage = (value: string | null | undefined) => value == null ? null : Number(value);
  const buyHoldReturn = reviewData?.buyAndHoldEquityUsd != null && Number(reviewData.initialEquityUsd) > 0
    ? (Number(reviewData.buyAndHoldEquityUsd) / Number(reviewData.initialEquityUsd) - 1) * 100 : null;
  const status = effectiveInvestmentStatus(data);
  const structuredRestriction = restrictionKind === 'text' ? null : constraintDraft({ kind: restrictionKind, ticker: restrictionTicker, percent: restrictionPercent, markets: restrictionMarkets, expiresAt: restrictionExpiry });
  return <div className="mx-auto w-full max-w-5xl space-y-6 p-3 pb-12 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{zh ? 'AI 模拟盘' : 'AI simulation'}</h1><p className="mt-1 text-sm text-muted-foreground">{zh ? '核对策略后开始监控，成交和新建议会出现在频道。' : 'Review a strategy to start monitoring. Trades and new suggestions appear in the channel.'}</p></div>
      {started && data.currentStrategy && <Button variant={data.policy.status === 'paused' ? 'default' : 'outline'} disabled={pending} onClick={() => {
        const payload = { expectedRevision: data.policy!.revision };
        void mutate(data.policy!.status === 'paused' ? 'resume' : 'pause', payload, key => data.policy!.status === 'paused' ? resumeAiInvestment({ ...payload, requestKey: key }) : pauseAiInvestment({ ...payload, requestKey: key }));
      }}>{pending ? (zh ? '正在处理…' : 'Working…') : data.policy.status === 'paused' ? (zh ? '恢复并重新评估' : 'Resume and reassess') : (zh ? '暂停自动交易' : 'Pause automatic trading')}</Button>}</header>
    <nav className="flex flex-wrap gap-2 text-sm" aria-label={zh ? '每日投资流程' : 'Daily investing journey'}>
      <Button asChild variant="outline" size="sm"><Link to="/">{zh ? '1 · 看今日报告' : '1 · Read today’s report'}</Link></Button>
      <Button asChild variant="outline" size="sm"><a href={started ? '#investment-strategy' : '#simulation-setup'} aria-current="step">{zh ? '2 · 管理模拟策略' : '2 · Manage simulation strategy'}</a></Button>
      <Button asChild variant="outline" size="sm"><Link to="/council">{zh ? '3 · 看频道动态' : '3 · Follow the channel'}</Link></Button>
    </nav>
    <InvestmentStatus status={status} lastHeartbeatAt={data.lastHeartbeatAt} />
    {!started && requestedStrategyId && <p role="status" className="rounded-xl bg-primary/5 p-4 text-sm leading-6">{zh ? '刚复制的策略已保存。先建立模拟账户，完成后会自动打开这份策略供你核对。' : 'Your copied strategy is saved. Create your simulated account below; then this strategy opens for your review.'}</p>}
    {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {(previewPending || previewError) && <section className="space-y-3 rounded-xl border bg-card p-4">
      {previewPending && <p role="status" className="text-sm">{cashMode ? (zh ? '正在准备模拟现金预览…' : 'Preparing your simulated cash preview…') : (zh ? '正在准备持仓预览…持仓较多时请稍候，完成后由你确认复制。' : 'Preparing your holdings preview… Many positions can take a moment; you will confirm the copy next.')}</p>}
      {previewError && <><p role="alert" className="text-sm text-destructive">{previewError}</p><Button onClick={() => void prepare()}>{zh ? '重试预览' : 'Retry preview'}</Button></>}
      <Button variant="outline" onClick={cancelPreview}>{zh ? '取消复制' : 'Cancel copy'}</Button>
    </section>}
    {!started && !!data.legacyAccounts.length && <section className="space-y-3 rounded-xl border border-amber-500/30 p-4"><h2 className="font-semibold">{zh ? '已有旧版账户' : 'Existing legacy account'}</h2><p className="text-sm leading-6">{zh ? '旧自动交易将暂停，核对新的投资范围后继续。仅查看页面不会接管账户。' : 'Legacy automatic trading will pause once you confirm the new scope. Viewing this page does not take over the account.'}</p>{data.legacyAccounts.map(account => <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 text-sm"><span>{account.name} · {account.botEnabled && account.active ? (zh ? '旧自动交易已开启' : 'Legacy automatic trading enabled') : (zh ? '未自动交易' : 'Automatic trading disabled')}</span>{account.active && account.botEnabled && <Button size="sm" variant="outline" disabled={pending} onClick={() => void mutate('legacy-pause', { accountId: account.id }, key => pauseLegacyInvestment(account.id, key))}>{zh ? '暂停全部自动交易' : 'Pause all automatic trading'}</Button>}</div>)}</section>}
    {(!started || restart) && !preview && !previewPending && !previewError && <section id="simulation-setup" className="scroll-mt-6 space-y-4 rounded-xl border bg-card p-4 sm:p-6"><h2 className="text-lg font-semibold">{restart ? (zh ? '从新的起点重新开始' : 'Start again from a fresh seed') : (zh ? '建立你的模拟账户' : 'Create your simulated account')}</h2><p className="text-sm leading-6 text-muted-foreground">{zh ? '选择当前持仓或模拟现金作为起点。建立后再确认策略，之后独立运行。' : 'Start with your current holdings or simulated cash. Review a strategy after setup; the simulation then runs independently.'}</p>
      <div className="flex flex-wrap gap-2"><Button disabled={pending} onClick={() => prepare(false)}>{zh ? '复制当前持仓' : 'Copy current holdings'}</Button><Button variant="outline" asChild><Link to="/import">{zh ? '先导入持仓' : 'Import holdings first'}</Link></Button><Button variant="ghost" onClick={() => setCashMode(!cashMode)}>{zh ? '用模拟现金开始' : 'Start with simulated cash'}</Button></div>
      {cashMode && <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); prepare(true); }}><label className="min-w-0 flex-1 space-y-2 text-sm"><span>{zh ? '模拟现金金额' : 'Simulated cash amount'}</span><Input type="number" min="0" step="any" value={amount} onChange={event => setAmount(event.target.value)} /></label><label className="space-y-2 text-sm"><span>{zh ? '币种' : 'Currency'}</span><select className="block h-9 rounded-md border bg-background px-2" value={currency} onChange={event => setCurrency(event.target.value as typeof currency)}>{['USD', 'HKD', 'CNY'].map(value => <option key={value}>{value}</option>)}</select></label><Button disabled={pending || !validCashSeed(amount, currency)} type="submit">{zh ? '预览起点' : 'Preview starting point'}</Button></form>}
    </section>}
    {preview && <StartInvestmentCard key={preview.id} preview={preview} restartAccountId={previewAccountId} onCancel={cancelPreview}
      onRefresh={() => { void prepare(); }} onStarted={() => { setPreview(null); setRestart(false); clearSeedReal(); void query.refetch(); }} />}
    {started && <InvestmentStrategySection timezone={data.policy?.baseConfig?.timezone ?? 'Asia/Shanghai'} />}
    {started && <>
      <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-6"><div className="grid gap-3 sm:grid-cols-3">{[[zh ? '模拟净资产（美元）' : 'Net assets (USD)', data.netAssetUsd], [zh ? '今日变化（美元）' : 'Today’s change (USD)', data.todayChangeUsd], [zh ? '创建以来收益' : 'Return since baseline', returnLabel(percentage(reviewData?.returnPct))]].map(([label, value]) => <div key={label} className="rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-xl font-semibold tabular-nums">{value ?? '—'}</p></div>)}</div><div className="space-y-2 border-t pt-3"><h2 className="font-semibold">{zh ? '当前策略' : 'Current strategy'}</h2><p className="text-sm">{data.currentStrategy?.content.title ?? (zh ? '先观察，等待选择策略' : 'Observing until you choose a strategy')}</p>{data.currentStrategy && <p className="text-xs text-muted-foreground">{zh ? '确认于' : 'Confirmed at'} {new Date(data.currentStrategy.confirmedAt).toLocaleString(i18n.language)}</p>}<Button asChild size="sm" variant="outline"><a href="#investment-strategy">{zh ? '查看和修改策略' : 'View and edit strategy'}</a></Button></div>{data.lastCheckAt && <p className="text-xs text-muted-foreground">{zh ? '最近检查' : 'Last check'} {new Date(data.lastCheckAt).toLocaleString(i18n.language)}</p>}{!!data.waitingReasons?.length && <details className="text-sm"><summary className="cursor-pointer">{zh ? '检查结果和等待原因' : 'Checks and reasons for waiting'}</summary><ul className="mt-2 list-inside list-disc space-y-1 break-words text-xs text-muted-foreground">{data.waitingReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details>}</section>
      <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-6"><h2 className="text-lg font-semibold">{zh ? '从同一起点以来' : 'Since the same starting point'}</h2><div className="grid gap-3 sm:grid-cols-3">{[[zh ? 'AI 账户' : 'AI account', returnLabel(percentage(reviewData?.returnPct))], [zh ? '起点持仓保持不动' : 'Keep starting holdings unchanged', returnLabel(buyHoldReturn)], [zh ? '相对起点持仓' : 'Versus starting holdings', returnLabel(percentage(reviewData?.excessReturnPct))]].map(([label, value]) => <div key={label} className="rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-xl font-semibold tabular-nums">{value}</p></div>)}</div>
        {history.data?.find(account => account.id === accountId)?.sourceChanged && <p className="text-sm text-muted-foreground">{zh ? '真实盘已变化。此处继续比较同一起点，真实交易不会自动复制到 AI 账户。' : 'Your real portfolio has changed. This comparison keeps the original seed; real trades are not automatically copied to the AI account.'}</p>}
        <p className="text-xs leading-6 text-muted-foreground">{zh ? '使用相同起点、估值币种和可获得资料；真实持仓的后续交易不计入此对照。' : 'Uses the same seed, valuation currency and available data. Later real-account trades are outside this comparison.'}</p>
        {!reviewData && <p className="text-sm text-muted-foreground">{zh ? '缺少可信区间或估值，收益暂时未知。' : 'Returns are unknown without reliable boundaries and valuation.'}</p>}
        {!!reviewData?.gaps.length && <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">{reviewData.gaps.map(gap => <li key={gap}>{simulationReviewGapText(gap, zh)}</li>)}</ul>}
        {reviewData && <p className="text-xs text-muted-foreground">{zh ? '累计费用（美元）' : 'Cumulative fees (USD)'} {reviewData.feesUsd} · {zh ? '估值截至' : 'Valuation as of'} {reviewData.valuationAsOf || (zh ? '未知' : 'Unknown')}</p>}
      </section>
      <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-6"><h2 className="text-lg font-semibold">{zh ? '当前投资思路' : 'Current investment thinking'}</h2><p className="whitespace-pre-wrap break-words text-sm leading-7">{data.currentThinking || (zh ? '正在核对当前资料；没有足够依据时继续观察。' : 'Checking current information; observe while evidence is insufficient.')}</p>{data.cycles.filter(cycle => cycle.reason).map(cycle => <p key={cycle.id} className="break-words text-sm text-muted-foreground">{cycle.market} · {cycle.reason}</p>)}<Button asChild size="sm" variant="outline"><Link to="/council">{zh ? '和大家聊聊' : 'Discuss with the team'}</Link></Button></section>
      <section className="space-y-3"><h2 className="text-lg font-semibold">{zh ? '最近行动' : 'Recent actions'}</h2>{data.actions.length ? <div className="grid gap-3 md:grid-cols-2">{data.actions.map(action => <div key={action.id} id={`paper-order-${action.id}`} className={requestedOrderId === action.id ? 'scroll-mt-6 rounded-xl ring-2 ring-primary' : undefined}><DecisionCard action={action} decision={decisions.data?.decisions.find(decision => decision.orderId === action.id)} /></div>)}</div> : <p className="rounded-xl border p-4 text-sm text-muted-foreground">{zh ? '尚无模拟成交。继续观察也是完整判断。' : 'No simulated trades yet. Continuing to observe is a complete decision.'}</p>}</section>
      <section className="space-y-3 rounded-xl border p-4 sm:p-6"><h2 className="text-lg font-semibold">{zh ? '当前持仓' : 'Current positions'}</h2>{data.holdings.length ? data.holdings.map(holding => <div key={holding.id} className="flex flex-wrap justify-between gap-2 border-b py-2 text-sm last:border-0"><Link className="font-medium text-primary underline" to={`/analysis?ticker=${encodeURIComponent(holding.ticker)}`}>{holding.ticker}</Link><span>{holding.shares} · {holding.currency} · {zh ? '模拟成本' : 'Simulation cost'} {Number(holding.avgCost) > 0 ? holding.avgCost : (zh ? '等待起点估值' : 'Awaiting initial valuation')}{holding.originalCost !== undefined && <span className="ml-2 text-xs text-muted-foreground">{zh ? '原成本参考' : 'Original cost reference'} {holding.originalCost ?? (zh ? '未知' : 'Unknown')}</span>}</span></div>) : <p className="text-sm text-muted-foreground">{zh ? '当前为空仓。' : 'No current positions.'}</p>}</section>
      <details className="rounded-xl border p-4 sm:p-6"><summary className="cursor-pointer font-semibold">{zh ? '投资限制与账户设置' : 'Investment restrictions and account settings'}</summary><div className="mt-4 space-y-5">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">{Object.entries(limitLabels(zh)).map(([key, label]) => <div key={key}><dt className="text-xs text-muted-foreground">{label}</dt><dd>{data.limits[key]}%</dd></div>)}</dl>
        <form className="space-y-3" onSubmit={event => {
          event.preventDefault();
          const payload = restrictionKind === 'text' ? { text: restriction.trim() } : structuredRestriction ? { text: constraintLabel(structuredRestriction, zh), constraint: structuredRestriction } : null;
          if (payload?.text) void mutate('propose', payload, async key => setProposal(await proposeInvestmentConstraint({ ...payload, requestKey: key })));
        }}><label htmlFor="restriction-kind" className="block space-y-2 text-sm font-medium"><span>{zh ? '告诉 AI 你的限制' : 'Tell AI your restriction'}</span><select id="restriction-kind" className="block h-9 w-full rounded-md border bg-background px-2 text-sm" value={restrictionKind} onChange={event => setRestrictionKind(event.target.value as typeof restrictionKind)}>{[['text', zh ? '用自己的话说明' : 'Describe in your own words'], ['no_buy', zh ? '禁止新增买入某股' : 'Do not buy a security'], ['no_sell', zh ? '完全禁止卖出某股' : 'Do not sell a security'], ['no_increase', zh ? '停止加仓' : 'Stop increasing positions'], ['position_cap', zh ? '调整单股上限' : 'Change a security’s position cap'], ['cash_floor', zh ? '调整最低现金' : 'Change minimum cash'], ['markets', zh ? '调整允许市场' : 'Change allowed markets']].map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
          {restrictionKind === 'text' ? <Input aria-label={zh ? '限制内容' : 'Restriction text'} value={restriction} onChange={event => setRestriction(event.target.value)} placeholder={zh ? '例如：不要再买 TEST，或最低现金 30%' : 'For example: do not buy TEST, or minimum cash 30%'} /> : <div className="space-y-3">
            {['no_buy', 'no_sell', 'position_cap'].includes(restrictionKind) && <label className="block space-y-1 text-sm"><span>{zh ? '股票代码' : 'Security symbol'}</span><Input value={restrictionTicker} onChange={event => setRestrictionTicker(event.target.value)} placeholder="TEST" /></label>}
            {['position_cap', 'cash_floor'].includes(restrictionKind) && <label className="block space-y-1 text-sm"><span>{zh ? '比例（%）' : 'Percentage (%)'}</span><Input type="number" min="0" max="100" value={restrictionPercent} onChange={event => setRestrictionPercent(event.target.value)} /></label>}
            {restrictionKind === 'markets' && <fieldset><legend className="mb-2 text-sm">{zh ? '允许市场' : 'Allowed markets'}</legend><div className="flex flex-wrap gap-4">{(['US', 'HK', 'CN'] as const).map(market => <label key={market} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={restrictionMarkets.includes(market)} onChange={event => setRestrictionMarkets(current => event.target.checked ? [...current, market] : current.filter(value => value !== market))} />{market}</label>)}</div></fieldset>}
            <label className="block space-y-1 text-sm"><span>{zh ? '到期时间（留空持续到取消）' : 'Expires at (blank means until revoked)'}</span><Input type="datetime-local" value={restrictionExpiry} onChange={event => setRestrictionExpiry(event.target.value)} /><span className="text-xs text-muted-foreground">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span></label>
          </div>}
          <Button type="submit" size="sm" variant="outline" disabled={pending || (restrictionKind === 'text' ? !restriction.trim() : !structuredRestriction)}>{zh ? '查看影响并确认' : 'Review impact and confirm'}</Button></form>
        {proposal && <ConstraintProposalCard proposal={proposal} onClose={() => setProposal(null)} />}
        {data.constraints.map(record => <div key={record.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/30 p-3 text-sm"><div><p>{constraintLabel(record.constraint, zh)}</p><p className="mt-1 text-xs text-muted-foreground">{record.status} · {record.constraint.expiresAt ? new Date(record.constraint.expiresAt).toLocaleString(i18n.language) : (zh ? '直到取消' : 'Until revoked')}</p></div>{record.status === 'active' && <Button size="sm" variant="outline" disabled={pending} onClick={() => void mutate('revoke', { id: record.proposalId, revision: data.policy!.revision }, key => revokeInvestmentConstraint(record.proposalId, { expectedPolicyRevision: data.policy!.revision, requestKey: key }))}>{zh ? '撤销限制' : 'Revoke restriction'}</Button>}</div>)}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={pending} onClick={() => { setRestart(true); setPreview(null); }}>{zh ? '重新从真实持仓开始' : 'Start again from real holdings'}</Button><Button size="sm" variant="ghost" onClick={() => setHistoryOpen(!historyOpen)}>{zh ? '只读历史账户' : 'Read-only account history'}</Button></div>
      </div></details>
    </>}
    {historyOpen && <section className="space-y-2 rounded-xl border p-4"><h2 className="font-semibold">{zh ? '历史账户（只读）' : 'Historical accounts (read only)'}</h2>{history.data?.filter(account => account.id !== accountId).map(account => <details key={account.id} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">{account.name} · {new Date(account.createdAt).toLocaleDateString(i18n.language)}</summary><p className="mt-2 text-sm">{zh ? '起点估值（美元）' : 'Starting equity (USD)'} {account.initialEquityUsd}</p><ul className="mt-2 text-xs text-muted-foreground">{account.seed?.positions.map(position => <li key={position.ticker}>{position.ticker}: {position.shares}</li>)}</ul></details>)}</section>}
  </div>;
}
