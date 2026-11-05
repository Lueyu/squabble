import type { PortfolioDailyFacts } from '../../../shared/portfolio-report.interface';
import { lastCompletedTradingDate, tradingMarketDate, tradingMarketSchedule } from '../paper-trading/trading-market.calendar';
import { sql } from 'drizzle-orm';
import { transactions, snapshots, fxRates } from '../../database/schema';
import type { ResearchDocumentsTransaction } from './research-documents.service';

interface LedgerRow { id: string; txDate: string; ticker: string; txType: string; currency: string | null; shares: string | number;
  price: string | number; fees: string | number | null; notes: string | null; updatedAt: Date }
interface SnapshotRow { id: string; snapshotDate: string; accountValue: string | number | null; updatedAt: Date }
interface FxRow { base: string; quote: string; rate: string | number; rateDate: string }
function numeric(value: string | number | null): number | null {
  if (value === null || value === '') return null;
  const result = Number(value); return Number.isFinite(result) ? result : null;
}
const rounded = (value: number) => Math.round((value + Number.EPSILON) * 1e8) / 1e8;

export async function capturePortfolioDailyFacts(tx: ResearchDocumentsTransaction, owner: string, at: Date, language: 'en' | 'zh-CN' = 'en'): Promise<PortfolioDailyFacts> {
  const day = tradingMarketDate('CN', at);
  const previous = new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  // A single statement gives all three sources the same MVCC snapshot, including callers whose
  // surrounding transaction uses read committed. No partially updated ledger/snapshot pair is mixed.
  const [capture] = await tx.select({
    ledger: sql<Array<Omit<LedgerRow, 'updatedAt'> & { updatedAt: string }>>`(select coalesce(jsonb_agg(jsonb_build_object(
      'id', ${transactions.id}, 'txDate', ${transactions.txDate}, 'ticker', ${transactions.ticker}, 'txType', ${transactions.txType},
      'currency', ${transactions.currency}, 'shares', ${transactions.shares}, 'price', ${transactions.price}, 'fees', ${transactions.fees},
      'notes', ${transactions.notes}, 'updatedAt', ${transactions.updatedAt}) order by ${transactions.createdAt}, ${transactions.id}), '[]'::jsonb)
      from ${transactions} where ${transactions.owner} = ${owner} and ${transactions.txDate} = ${day}::date)`,
    boundaries: sql<Array<Omit<SnapshotRow, 'updatedAt'> & { updatedAt: string }>>`(select coalesce(jsonb_agg(jsonb_build_object(
      'id', ${snapshots.id}, 'snapshotDate', ${snapshots.snapshotDate}, 'accountValue', ${snapshots.accountValue}, 'updatedAt', ${snapshots.updatedAt})), '[]'::jsonb)
      from ${snapshots} where ${snapshots.owner} = ${owner} and ${snapshots.snapshotDate} in (${previous}::date, ${day}::date))`,
    rates: sql<FxRow[]>`(select coalesce(jsonb_agg(jsonb_build_object('base', ${fxRates.base}, 'quote', ${fxRates.quote}, 'rate', ${fxRates.rate}, 'rateDate', ${fxRates.rateDate})), '[]'::jsonb)
      from ${fxRates} where ${fxRates.rateDate} = ${day}::date)`,
  }).from(sql`(select 1) as report_fact_capture`);
  return buildPortfolioDailyFacts(at, capture.ledger.map(row => ({ ...row, updatedAt: new Date(row.updatedAt) })),
    capture.boundaries.map(row => ({ ...row, updatedAt: new Date(row.updatedAt) })), capture.rates, language);
}

/** Only immutable input rows and exact-date FX contribute. No model arithmetic or 1:1 FX fallback. */
export function buildPortfolioDailyFacts(at: Date, ledger: LedgerRow[], snapshots: SnapshotRow[], rates: FxRow[], language: 'en' | 'zh-CN' = 'en'): PortfolioDailyFacts {
  const say = (en: string, zh: string) => language === 'en' ? en : zh;
  const businessDate = tradingMarketDate('CN', at);
  const previousDate = new Date(Date.parse(`${businessDate}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const gaps = [say('Transaction dates are recorded ledger dates; execution timestamps and completeness are unverified.', '交易日期为账本记录日期；实际成交时点及记录完整性未经核实。'),
    say('Account snapshot valuations and price freshness are not independently verified. Returns exclude external flows and include recorded fees; trade-level attribution is unavailable.', '账户快照估值和价格时效未经独立核实。收益剔除外部资金流、包含已记录费用；逐笔交易归因未知。')];
  const rows = ledger.filter(row => row.txDate === businessDate);
  const transactions = rows.map(row => {
    const shares = numeric(row.shares); const price = numeric(row.price);
    return { id: row.id, date: row.txDate, ticker: row.ticker, type: row.txType, currency: row.currency?.toUpperCase() || 'UNKNOWN',
      shares, price, notional: shares !== null && price !== null && Number.isFinite(shares * price) ? rounded(shares * price) : null,
      fees: numeric(row.fees), updatedAt: row.updatedAt.toISOString(), assumedFunding: !!row.notes?.includes('__AUTO_DEPOSIT_FOR_BUY__:') };
  });
  const sums = new Map<string, PortfolioDailyFacts['byCurrency'][number]>();
  const changes = new Map<string, PortfolioDailyFacts['positionChanges'][number]>();
  let malformed = false;
  for (const row of transactions) {
    if (row.notional === null || row.notional < 0 || row.fees === null || row.fees < 0 || row.currency === 'UNKNOWN') malformed = true;
    const sum = sums.get(row.currency) ?? { currency: row.currency, buys: 0, sells: 0, deposits: 0, withdrawals: 0, fees: 0 };
    const field = ({ Buy: 'buys', Sell: 'sells', Deposit: 'deposits', Withdrawal: 'withdrawals' } as const)[row.type as 'Buy'];
    if (field && row.notional !== null) sum[field] = rounded(sum[field] + row.notional);
    sum.fees = rounded(sum.fees + (row.fees ?? 0)); sums.set(row.currency, sum);
    if ((row.type === 'Buy' || row.type === 'Sell') && row.shares !== null) {
      const change = changes.get(row.ticker) ?? { ticker: row.ticker, boughtShares: 0, soldShares: 0, netShares: 0 };
      if (row.type === 'Buy') change.boughtShares = rounded(change.boughtShares + row.shares);
      else change.soldShares = rounded(change.soldShares + row.shares);
      change.netShares = rounded(change.boughtShares - change.soldShares); changes.set(row.ticker, change);
    }
  }
  const fx: PortfolioDailyFacts['returnBasis']['fx'] = [];
  let flow: number | null = malformed ? null : 0;
  for (const row of transactions.filter(row => row.type === 'Deposit' || row.type === 'Withdrawal')) {
    if (row.notional === null) { flow = null; continue; }
    let rate: number | null = row.currency === 'USD' ? 1 : null;
    const pair = rates.find(item => item.rateDate === businessDate && ((item.base === row.currency && item.quote === 'USD') || (item.base === 'USD' && item.quote === row.currency)));
    const value = pair && numeric(pair.rate);
    if (pair && value !== null && value !== undefined && value > 0) {
      rate = pair.base === row.currency ? value : 1 / value;
      if (!fx.some(item => item.base === pair.base && item.quote === pair.quote)) fx.push({ base: pair.base, quote: pair.quote, rate: value, date: pair.rateDate });
    }
    if (rate === null) { flow = null; gaps.push(say(`No verified ${row.currency}/USD FX for ${businessDate}; return unknown.`, `${businessDate} 的 ${row.currency}/USD 汇率缺失，收益未知。`)); }
    else if (flow !== null) flow = rounded(flow + row.notional * rate * (row.type === 'Deposit' ? 1 : -1));
  }
  const boundary = (date: string) => {
    const row = snapshots.find(item => item.snapshotDate === date);
    return row ? { id: row.id, date, accountValue: numeric(row.accountValue), updatedAt: row.updatedAt.toISOString() } : null;
  };
  const startSnapshot = boundary(previousDate); const endSnapshot = boundary(businessDate);
  const stale = !!endSnapshot && transactions.some(row => row.updatedAt > endSnapshot.updatedAt);
  const opening = transactions.some(row => row.type === 'Opening');
  const unsupported = transactions.some(row => !['Buy', 'Sell', 'Deposit', 'Withdrawal', 'Opening'].includes(row.type));
  if (!startSnapshot || !endSnapshot || startSnapshot.accountValue === null || endSnapshot.accountValue === null) gaps.push(say('Exact previous-day and current-day equity snapshots are required; daily return unknown.', '缺少精确前一日及当日净值快照，当日收益未知。'));
  if (stale) gaps.push(say('Ledger changed after the current-day snapshot; daily return unknown.', '当日快照后账本已有变动，当日收益未知。'));
  if (opening) gaps.push(say('Opening position changes have no verified external-flow basis; daily return unknown.', '期初 Opening 持仓变动缺少可核实资金流口径，当日收益未知。'));
  if (unsupported || malformed) gaps.push(say('Invalid or unsupported ledger fields prevent a complete return calculation.', '账本存在不完整或不支持的字段，无法完整计算收益。'));
  if (transactions.some(row => row.assumedFunding)) gaps.push(say('Some deposits were automatically added to fund buys; verify the funding source.', '部分入金为买入时自动补足的资金，请核对真实来源。'));
  const pnlUsd = !stale && !opening && !unsupported && !malformed && flow !== null && startSnapshot?.accountValue !== null && startSnapshot?.accountValue !== undefined && endSnapshot?.accountValue !== null && endSnapshot?.accountValue !== undefined
    ? rounded(endSnapshot.accountValue - startSnapshot.accountValue - flow) : null;
  const marketSessions = (['US', 'HK', 'CN'] as const).map(market => ({ ...tradingMarketSchedule(market, at), lastCompletedTradingDate: lastCompletedTradingDate(market, at) }));
  if (marketSessions.some(market => !market.calendarVerified)) gaps.push(say('One or more market calendars are unverified for this date.', '此日期的部分市场交易日历未经核实。'));
  return { businessDate, timezone: 'Asia/Shanghai', capturedAt: at.toISOString(), transactions, byCurrency: [...sums.values()], positionChanges: [...changes.values()], marketSessions,
    returnBasis: { method: 'equity_change_minus_external_flows', currency: 'USD', startSnapshot, endSnapshot, fx, netExternalFlowUsd: flow, pnlUsd,
      returnPct: pnlUsd !== null && startSnapshot?.accountValue && startSnapshot.accountValue > 0 ? rounded(pnlUsd / startSnapshot.accountValue * 100) : null }, gaps: [...new Set(gaps)] };
}
