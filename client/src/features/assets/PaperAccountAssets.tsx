import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Search } from 'lucide-react';
import type { PortfolioAccountAssets } from '@shared/portfolio-workspace.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { paperAssetsQueryOptions } from './account-context';
import { ExecutionProvenance } from './ExecutionProvenance';

type Position = PortfolioAccountAssets['positions'][number];

export default function PaperAccountAssets({ accountId, accountName, archived, mode }: {
  accountId: string; accountName: string; archived?: boolean; mode: 'holdings' | 'transactions';
}) {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const query = useQuery(paperAssetsQueryOptions(accountId));
  const search = params.get('q') ?? '';
  const market = params.get('market') ?? 'all';
  const sort = params.get('sort') ?? 'ticker';
  const orderId = params.get('orderId');
  const tradeId = params.get('tradeId');
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params); next.set(key, value); setParams(next, { replace: true });
  };
  const data = query.data?.accountId === accountId ? query.data : undefined;
  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (data?.positions ?? []).filter(item => (market === 'all' || item.market === market) &&
      (!needle || `${item.ticker} ${item.company ?? ''}`.toLocaleLowerCase().includes(needle))).sort((a, b) => {
      if (sort === 'ticker') return a.ticker.localeCompare(b.ticker);
      const left = a[sort as keyof Position]; const right = b[sort as keyof Position];
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return Number(right) - Number(left);
    });
  }, [data, search, market, sort]);
  useEffect(() => {
    if (mode === 'transactions' && orderId && data) document.getElementById(`asset-order-${orderId}`)?.scrollIntoView({ block: 'center' });
    if (mode === 'transactions' && tradeId && data) document.getElementById(`asset-trade-${tradeId}`)?.scrollIntoView({ block: 'center' });
  }, [data, mode, orderId, tradeId]);
  const number = (value: string | null) => value !== null && value.trim() !== '' && Number.isFinite(Number(value))
    ? new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 8 }).format(Number(value)) : '—';
  const money = (value: string | null, currency: string) => value === null ? '—' : `${number(value)} ${currency}`;
  const fields: Array<[keyof Position, string]> = [
    ['shares', 'assets.shares'], ['avgCost', 'assets.averageCost'], ['currentPrice', 'assets.currentPrice'],
    ['marketValue', 'assets.marketValue'], ['unrealizedPl', 'assets.unrealizedPl'],
  ];
  if (query.isPending) return <p role="status" className="p-8">{t('assets.loadingAccount', { name: accountName })}</p>;
  if (!data) return <section role="alert" className="space-y-4 rounded-xl border p-6">
    <h1 className="text-xl font-semibold">{t('assets.unavailableAccount', { name: accountName })}</h1>
    <p className="text-sm text-muted-foreground">{t('assets.noFallback')}</p>
    <Button variant="outline" onClick={() => void query.refetch()}>{t('common.retry')}</Button>
  </section>;
  const filter = (ticker: string) => !search.trim() || ticker.toLowerCase().includes(search.trim().toLowerCase());
  return <div className="space-y-5" data-account-id={accountId}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="break-words font-serif text-2xl font-semibold">{accountName} · {t(mode === 'holdings' ? 'assets.holdings' : 'assets.ledger')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('assets.readOnly')}{archived ? ` · ${t('assets.archived')}` : ''}</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={15} />{t('assets.refresh')}</Button>
        <Button asChild variant="outline"><Link to={`/paper/${encodeURIComponent(accountId)}/strategies`}>{t('assets.strategyCombination')}</Link></Button></div>
    </header>
    {query.isError && <p role="alert" className="text-sm text-destructive">{t('assets.refreshFailed')}</p>}
    <section className="rounded-xl bg-muted/35 p-4" aria-label={t('assets.valuation')}>
      <p className="text-xs text-muted-foreground">{t('assets.savedValuation')}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{money(data.equityUsd, 'USD')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{data.valuedAt ? `${t('assets.asOf')} ${new Date(data.valuedAt).toLocaleString(i18n.language)}` : t('assets.incompleteValuation')}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('assets.savedValuationHint')}</p>
      {!!data.gaps.length && <details className="mt-3 text-sm"><summary>{t('assets.coverageGaps', { count: data.gaps.length })}</summary><ul className="mt-2 list-disc space-y-1 pl-5">{data.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></details>}
    </section>
    <div className="flex flex-col gap-3 sm:flex-row"><div className="relative flex-1"><Search size={16} className="absolute left-3 top-3 text-muted-foreground" /><Input aria-label={t('assets.search')} placeholder={t('assets.search')} className="pl-9" value={search} onChange={event => update('q', event.target.value)} /></div>
      {mode === 'holdings' && <><Select value={market} onValueChange={value => update('market', value)}><SelectTrigger aria-label={t('assets.marketFilter')} className="sm:w-40"><SelectValue /></SelectTrigger><SelectContent>{['all', 'US', 'HK', 'CN'].map(value => <SelectItem key={value} value={value}>{value === 'all' ? t('assets.allMarkets') : value}</SelectItem>)}</SelectContent></Select>
        <Select value={sort} onValueChange={value => update('sort', value)}><SelectTrigger aria-label={t('assets.sort')} className="sm:w-44"><SelectValue /></SelectTrigger><SelectContent>{['ticker', 'shares', 'avgCost', 'currentPrice', 'marketValue', 'unrealizedPl'].map(value => <SelectItem key={value} value={value}>{t(`assets.${value === 'ticker' ? 'security' : value === 'avgCost' ? 'averageCost' : value}`)}</SelectItem>)}</SelectContent></Select></>}
    </div>
    {mode === 'holdings' ? <>
      <div className="hidden rounded-xl border md:block"><Table><TableHeader><TableRow><TableHead>{t('assets.security')}</TableHead>{fields.map(([, label]) => <TableHead key={label}>{t(label)}</TableHead>)}<TableHead>{t('assets.currency')}</TableHead></TableRow></TableHeader><TableBody>{rows.map(item => <TableRow key={item.id}><TableCell><strong>{item.ticker}</strong><p className="text-xs text-muted-foreground">{item.company ?? item.ticker} · {item.market}</p></TableCell>{fields.map(([key]) => <TableCell key={key} className="tabular-nums">{key === 'avgCost' && item.avgCost === null ? t('assets.costNotRecorded') : number(item[key] as string | null)}</TableCell>)}<TableCell>{item.currency}</TableCell></TableRow>)}</TableBody></Table></div>
      <div className="space-y-3 md:hidden">{rows.map(item => <article key={item.id} className="rounded-xl border p-4"><h2 className="font-semibold">{item.company ?? item.ticker} · {item.ticker}</h2><p className="mt-1 text-xs text-muted-foreground">{item.market} · {item.currency}</p><dl className="mt-3 grid grid-cols-2 gap-3">{fields.map(([key, label]) => <div key={key}><dt className="text-xs text-muted-foreground">{t(label)}</dt><dd className="mt-1 tabular-nums">{key === 'avgCost' && item.avgCost === null ? t('assets.costNotRecorded') : number(item[key] as string | null)}</dd></div>)}</dl></article>)}</div>
      {!rows.length && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{t(data.positions.length ? 'assets.noMatchingHoldings' : 'assets.noHoldings')}</p>}
      <p className="text-xs text-muted-foreground">{t('assets.priceUnavailableHint')}</p>
      <section className="rounded-xl border p-4"><h2 className="font-semibold">{t('assets.cashByCurrency')}</h2><div className="mt-3 grid gap-4 sm:grid-cols-3">{data.cash.map(cash => <dl key={cash.currency} className="space-y-2"><dt className="font-medium">{cash.currency}</dt>{[['available', 'assets.available'], ['frozen', 'assets.frozen'], ['unsettled', 'assets.unsettled']].map(([key, label]) => <div key={key} className="flex justify-between gap-3 text-sm"><dt className="text-muted-foreground">{t(label)}</dt><dd className="tabular-nums">{number(cash[key as 'available' | 'frozen' | 'unsettled'])}</dd></div>)}{!cash.availabilityKnown && <dd className="text-xs text-muted-foreground">{t('assets.cashUnknown')}</dd>}</dl>)}</div>{!data.cash.length && <p className="mt-3 text-sm text-muted-foreground">{t('assets.cashUnknown')}</p>}</section>
    </> : <>
      <p className="text-sm text-muted-foreground">{t('assets.paperLedgerHint')}</p>
      {orderId && !data.orders.some(order => order.id === orderId) && <p role="status" className="rounded-xl bg-muted p-4 text-sm">{t('assets.orderNotInAccount')}</p>}
      <section className="space-y-3"><h2 className="font-semibold">{t('assets.orders')}</h2>{data.orders.filter(order => filter(order.ticker)).map(order => <article key={order.id} id={`asset-order-${order.id}`} className="rounded-xl border p-4"><div className="flex flex-wrap justify-between gap-2"><strong>{order.ticker} · {t(order.side === 'buy' ? 'assets.buy' : 'assets.sell')} {number(order.quantity)}</strong><span>{t(`assets.orderStatus.${order.status}`, { defaultValue: order.status })}</span></div><p className="mt-2 text-sm text-muted-foreground">{t('assets.filledPrice')}: {money(order.filledPrice, order.currency)} · {order.filledAt ? new Date(order.filledAt).toLocaleString(i18n.language) : t('assets.notFilled')}</p>{order.reason && <p className="mt-2 break-words text-sm">{order.reason}</p>}<p className="mt-2 text-xs text-muted-foreground">{t('assets.createdAt')} {new Date(order.createdAt).toLocaleString(i18n.language)}</p><ExecutionProvenance entries={data.executionProvenance?.filter(item => item.kind === 'order' && item.targetId === order.id)} /></article>)}{!data.orders.length && <p className="text-sm text-muted-foreground">{t('assets.noOrders')}</p>}</section>
      <section className="space-y-3"><h2 className="font-semibold">{t('assets.fills')}</h2>{data.trades.filter(trade => filter(trade.ticker)).map(trade => <article key={trade.id} id={`asset-trade-${trade.id}`} className="rounded-xl border p-4"><div className="flex flex-wrap justify-between gap-2"><strong>{trade.ticker} · {t(trade.side === 'buy' ? 'assets.buy' : 'assets.sell')} {number(trade.quantity)}</strong><time>{new Date(trade.createdAt).toLocaleString(i18n.language)}</time></div><p className="mt-2 text-sm">{t('assets.recordedFillPrice')}: {number(trade.price)} · {t('assets.recordedFee')}: {number(trade.fee)}</p><p className="mt-1 text-sm text-muted-foreground">{t('assets.realizedPl')}: {number(trade.realizedPl)}</p><ExecutionProvenance entries={data.executionProvenance?.filter(item => item.kind === 'trade' && item.targetId === trade.id)} /></article>)}{!data.trades.length && <p className="text-sm text-muted-foreground">{t('assets.noFills')}</p>}</section>
    </>}
  </div>;
}
