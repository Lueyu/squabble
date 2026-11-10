import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PostgresJsDatabase } from '../../common/platform';
import { paperAccounts, paperOrders, paperPositions, paperSnapshots, paperTrades } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { userInvestmentStrategies } from '../../database/user-investment-strategies.schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import { strategySignals } from '../../database/strategy.schema';
import type { ChannelRuntimeSnapshot } from '../../../shared/channel.interface';
import type { InvestmentConfig } from '../../../shared/investment-policy.interface';

/** Owner-level draft pointers are not execution authority for a selected account. */
export function channelAssignments(config?: InvestmentConfig) {
  return config?.portfolio?.filter(a => a.enabled) ?? (config?.userStrategy ? [{ strategyId: config.userStrategy.id,
    strategyRevision: config.userStrategy.revision, allocationPct: 100, enabled: true, snapshot: config.userStrategy }] : []);
}

/** Exact decimal addition for ledger quantities and currency balances. */
export function sumChannelDecimals(values: string[]): string {
  const digits = Math.max(0, ...values.map(v => v.split('.')[1]?.length ?? 0));
  const total = values.reduce((n, value) => {
    if (!/^-?\d+(?:\.\d+)?$/u.test(value)) throw new Error('Invalid ledger decimal');
    const negative = value.startsWith('-'), [whole, fractional = ''] = value.replace(/^-/, '').split('.');
    const units = BigInt(whole + fractional.padEnd(digits, '0'));
    return n + (negative ? -units : units);
  }, 0n);
  const sign = total < 0n ? '-' : '', raw = (total < 0n ? -total : total).toString().padStart(digits + 1, '0');
  if (!digits) return sign + raw;
  return (sign + raw.slice(0, -digits) + '.' + raw.slice(-digits)).replace(/\.?0+$/u, '') || '0';
}

/** Read-only projection: channel language never writes the investment or fill ledgers. */
export async function readChannelRuntime(db: PostgresJsDatabase, owner: string, accountId?: string): Promise<ChannelRuntimeSnapshot> {
  return db.transaction(tx => readRuntimeInSnapshot(tx, owner, accountId), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Writers already holding the owner fence reuse their existing transaction. */
export async function readRuntimeInSnapshot(db: Pick<PostgresJsDatabase, 'select'>, owner: string, accountId?: string): Promise<ChannelRuntimeSnapshot> {
  if (accountId && !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu.test(accountId)) throw new BadRequestException('INVALID_ACCOUNT_ID');
  const accounts = await db.select().from(paperAccounts).where(eq(paperAccounts.owner, owner)).orderBy(desc(paperAccounts.createdAt));
  const active = accounts.filter(a => a.isActive);
  const selectionRequired = !accountId && active.length > 1;
  const account = accountId ? accounts.find(a => a.id === accountId) : active.length === 1 ? active[0] : undefined;
  if (accountId && !account) throw new NotFoundException('ACCOUNT_NOT_FOUND');
  const [policies, drafts] = await Promise.all([
    account ? db.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, account.id))).limit(1) : Promise.resolve([]),
    db.select().from(userInvestmentStrategies).where(and(eq(userInvestmentStrategies.owner, owner), eq(userInvestmentStrategies.status, 'draft'), isNull(userInvestmentStrategies.deletedAt))).orderBy(desc(userInvestmentStrategies.updatedAt)).limit(10),
  ]);
  const policy = policies[0];
  const assignments = channelAssignments(policy?.baseConfig);
  const strategy = assignments.length === 1 ? assignments[0].snapshot : undefined;
  const now = Date.now();
  const strategyExpired = assignments.length > 0 && assignments.every(a => Date.parse(a.snapshot.content.endsAt) <= now);
  const strategyNotStarted = assignments.length > 0 && assignments.every(a => Date.parse(a.snapshot.content.startsAt) > now);
  const allEntriesExpired = assignments.length > 0 && assignments.every(a => a.snapshot.content.entries.length > 0
    && a.snapshot.content.entries.every(entry => Date.parse(entry.endsAt ?? a.snapshot.content.endsAt) <= now));
  const observationOnly = assignments.length > 0 && assignments.every(a => !a.snapshot.preview?.directives?.length && !a.snapshot.preview?.mandateRules?.length);
  const archived = Boolean(account && (!account.isActive || policy?.status === 'archived'));
  const monitoringStatus: ChannelRuntimeSnapshot['monitoringStatus'] = archived ? 'stopped' : !assignments.length ? 'observing' : policy?.status === 'paused' ? 'paused'
    : strategyExpired || allEntriesExpired || !account?.botEnabled || process.env.PAPER_TRADING_ENABLED === 'false' ? 'stopped' : observationOnly || strategyNotStarted ? 'observing' : 'running';
  const monitoringReason = selectionRequired ? 'ACCOUNT_SELECTION_REQUIRED' : archived ? 'ACCOUNT_ARCHIVED' : !assignments.length ? 'NO_APPLIED_STRATEGY' : policy?.status === 'paused' ? 'PAUSED_INCLUDING_PROTECTIVE_EXITS'
    : strategyExpired ? 'STRATEGY_EXPIRED' : allEntriesExpired ? 'ALL_ENTRIES_EXPIRED' : !account?.botEnabled || process.env.PAPER_TRADING_ENABLED === 'false' ? 'EXECUTION_DISABLED' : observationOnly ? 'OBSERVATION_ONLY' : strategyNotStarted ? 'STRATEGY_NOT_STARTED' : null;
  const [positions, cash, orders, trades, snapshots] = account ? await Promise.all([
    db.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, account.id))),
    db.select().from(simulationCash).where(and(eq(simulationCash.owner, owner), eq(simulationCash.accountId, account.id))),
    db.select().from(paperOrders).where(and(eq(paperOrders.owner, owner), eq(paperOrders.accountId, account.id))).orderBy(desc(paperOrders.createdAt)).limit(20),
    db.select().from(paperTrades).where(and(eq(paperTrades.owner, owner), eq(paperTrades.accountId, account.id))),
    db.select().from(paperSnapshots).where(and(eq(paperSnapshots.owner, owner), eq(paperSnapshots.accountId, account.id))).orderBy(desc(paperSnapshots.createdAt)).limit(1),
  ]) : [[], [], [], [], []];
  const signals = orders.length ? await db.select().from(strategySignals).where(and(eq(strategySignals.owner, owner), inArray(strategySignals.orderId, orders.map(o => o.id)))) : [];
  const confirmedAt = new Date(Math.max(0, ...[account?.updatedAt, policy?.updatedAt, ...drafts.map(d => d.updatedAt), ...orders.map(o => o.filledAt ?? o.createdAt), ...trades.map(t => t.createdAt)].filter((d): d is Date => d instanceof Date).map(d => d.getTime()))).toISOString();
  return {
    accounts: accounts.map(a => ({ id: a.id, name: a.name, status: !a.isActive ? 'archived' : a.botEnabled ? 'running' : 'paused' })),
    accountName: account?.name ?? null, selectionRequired,
    accountId: account?.id ?? null, accountKind: 'paper', revision: Date.parse(confirmedAt), confirmedAt, monitoringStatus, monitoringReason,
    current: {
      strategyId: strategy?.id ?? null, strategyRevision: strategy?.revision ?? null,
      strategies: assignments.map(a => ({ id: a.strategyId, revision: a.strategyRevision, title: a.snapshot.content.title, allocationPct: a.allocationPct })),
      rules: assignments.flatMap(assignment => assignment.snapshot.content.entries.map(entry => {
        const source = assignment.snapshot;
        const expired = Date.parse(entry.endsAt ?? source.content.endsAt) <= now || Date.parse(source.content.endsAt) <= now;
        const notStarted = Date.parse(entry.startsAt ?? source.content.startsAt) > now || Date.parse(source.content.startsAt) > now;
        const entryExecutable = Boolean(source.preview?.directives?.some(d => d.entryId === entry.id) || source.preview?.mandateRules?.some(r => r.id === entry.id));
        const reason = policy?.status === 'paused' ? 'paused' as const : expired ? 'expired' as const : notStarted ? 'not_started' as const : !entryExecutable ? 'observation_only' as const : monitoringStatus !== 'running' ? 'stopped' as const : null;
        return { id: `${source.id}:${entry.id}`, label: entry.ticker ?? source.content.title,
          strategyId: source.id, strategyRevision: source.revision, entryId: entry.id, accountId: account!.id, accountName: account!.name,
          status: 'active' as const, effective: reason === null, effectiveReason: reason,
          value: entry.directive?.stopLossPrice !== undefined ? `保护线 ${entry.directive.stopLossPrice}` : entry.directive?.trigger.price !== undefined ? `触发价 ${entry.directive.trigger.price}` : entry.text };
      })),
      positions: positions.map(p => ({ symbol: p.ticker, quantity: String(p.shares) })),
      cash: cash.length ? cash.map(c => ({ currency: c.currency, amount: sumChannelDecimals([String(c.available), String(c.frozen), String(c.unsettled)]) })) : account ? [{ currency: account.baseCurrency, amount: String(account.cashBalance) }] : [],
      valuationAsOf: snapshots[0]?.valuedAt?.toISOString() ?? null,
    },
    proposals: drafts.map(d => ({ id: d.id, revision: d.revision, status: 'proposed' as const,
      before: assignments.map(a => a.snapshot.content.title).join(' + ') || '尚未应用策略', after: d.content.title, reasonCardId: `strategy:${d.id}:${d.revision}` })),
    executions: orders.map(o => {
      const relatedTrades = trades.filter(t => t.orderId === o.id);
      const filledAmount = relatedTrades.length ? sumChannelDecimals(relatedTrades.map(t => String(t.quantity))) : o.status === 'filled' && o.filledAt && Number(o.filledPrice) > 0 ? String(o.quantity) : '0';
      const filled = Number(filledAmount), requested = Number(o.quantity), remaining = Math.max(0, requested - filled);
      const status: ChannelRuntimeSnapshot['executions'][number]['status'] = filled >= requested && filled > 0 ? 'filled' : filled > 0 && remaining > 0 && !['cancelled','rejected_risk','rejected'].includes(o.status) ? 'partially_filled'
        : o.status === 'cancelled' ? 'cancelled' : ['rejected_risk','rejected','failed'].includes(o.status) ? 'failed' : o.status === 'pending' ? 'working' : 'queued';
      const source = signals.find(signal => signal.orderId === o.id && (!signal.candidate.accountId || signal.candidate.accountId === account?.id))?.candidate;
      return { id: o.id, symbol: o.ticker, strategyId: source?.userStrategyId ?? null,
        accountId: account!.id, accountName: account!.name, entryId: source?.userEntryId ?? source?.ruleId ?? null,
        // Zero means unknown/legacy origin; never borrow the CURRENT strategy revision.
        strategyRevision: source?.userStrategyRevision ?? 0, status, requestedQuantity: String(o.quantity), filledQuantity: filledAmount,
        remainingQuantity: remaining === 0 ? '0' : sumChannelDecimals([String(o.quantity), '-' + filledAmount]),
        updatedAt: new Date(Math.max(o.createdAt.getTime(), o.filledAt?.getTime() ?? 0, ...relatedTrades.map(t => t.createdAt.getTime()))).toISOString() };
    }),
  };
}
