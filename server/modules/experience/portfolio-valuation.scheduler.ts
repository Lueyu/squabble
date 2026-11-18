import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { cashAccounts, fxRates, holdings, paperAccounts, paperPositions } from '../../database/schema';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { paperEquityObservations, portfolioValuationClaims } from '../../database/portfolio-observations.schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import { PortfolioMetricsService } from './portfolio-metrics.service';
import { resolvePortfolioFx } from './portfolio-metrics';
import { resolveTradingTicker, type TradingTicker } from '../../../shared/trading-market.interface';
import {
    isLegacyValuationMinute, MAX_MINUTE_VALUATION_SYMBOLS, minuteValuationSlot, portfolioQuoteSymbol,
    shouldSaveValuation, valuationMarketPhase, VALUATION_MARKETS, VALUATION_SLOT_MS, valuationSlot,
    type ValuationSourcePolicy,
} from './portfolio-sampling.rules';
import { tradingMarketSchedule } from '../paper-trading/trading-market.calendar';
import { paperRiskDay, paperRiskTimezone } from '../paper-trading/paper-risk-day';
import { readCorporateActionGaps } from '../paper-trading/simulation-corporate-actions';
import { TradingMarketService } from '../paper-trading/trading-market.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
const schedulerOwner = 'portfolio-valuation';
const schedulerAccount = 'source';
const cooldownSlot = 'cooldown';
const sourceLeaseSlot = 'poll';

interface HeldSymbol {
    ticker: string;
    market: string | null;
    currency: string | null;
    shares: string;
}

interface CaptureAccount {
    owner: string;
    accountKey: string;
    symbols: TradingTicker[];
}

function heldSymbols(positions: HeldSymbol[]): TradingTicker[] {
    return positions.flatMap(position => {
        if (!(Number(position.shares) > 0)) return [];
        const market = position.market ?? 'US', currency = position.currency ?? 'USD';
        const symbol = resolveTradingTicker(portfolioQuoteSymbol(position.ticker, market));
        return symbol?.market === market && symbol.currency === currency ? [symbol] : [];
    });
}

type CorporateActions = Awaited<ReturnType<TradingMarketService['getSnapshot']>>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Claim = {
    owner: string;
    accountKey: string;
    slot: string;
    token: string;
};
/** The collector shares a source lease across processes. Each valuation has its
 * own account/slot claim, checked under the owner lock before publication. */
@Injectable()
export class PortfolioValuationScheduler implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PortfolioValuationScheduler.name);
    private timer: ReturnType<typeof setInterval> | undefined;
    private running = false;
    private readonly actionChecks = new Map<string, {
        slot: string;
        snapshot: Pick<CorporateActions, 'corporateActionsChecked' | 'corporateActions'>;
    }>();
    constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase, private readonly metrics: PortfolioMetricsService, private readonly market: TradingMarketService) { }
    onModuleInit(): void {
        if (process.env.PAPER_TRADING_ENABLED === 'false')
            return;
        this.timer = setInterval(() => { void this.tick().catch(() => this.logger.warn('Portfolio valuation collection failed')); }, 30000);
        this.timer.unref();
        void this.tick().catch(() => this.logger.warn('Portfolio valuation collection waiting'));
    }
    onModuleDestroy(): void { if (this.timer)
        clearInterval(this.timer); }
    async tick(at = new Date()): Promise<void> {
        if (this.running || process.env.PAPER_TRADING_ENABLED === 'false')
            return;
        this.running = true;
        try {
            const preferences = await this.db.select().from(experiencePreferences);
            const assets = await this.db.select({
                owner: holdings.owner, market: holdings.market, ticker: holdings.ticker,
                currency: holdings.currency, shares: holdings.shares,
            }).from(holdings);
            const cash = await this.db.select({ owner: cashAccounts.owner }).from(cashAccounts);
            const realOwners = [...new Set([...assets, ...cash].map(row => row.owner))];
            const accounts = await this.db.select().from(paperAccounts).where(eq(paperAccounts.isActive, true));
            const positions = accounts.length ? await this.db.select({
                accountId: paperPositions.accountId, owner: paperPositions.owner, market: paperPositions.market,
                currency: paperPositions.currency, ticker: paperPositions.ticker, shares: paperPositions.shares,
            }).from(paperPositions).innerJoin(paperAccounts,
                and(eq(paperAccounts.owner, paperPositions.owner), eq(paperAccounts.id, paperPositions.accountId),
                    eq(paperAccounts.isActive, true))) : [];
            const targets: CaptureAccount[] = [
                ...realOwners.map(owner => ({ owner, accountKey: 'real', symbols: heldSymbols(assets.filter(row => row.owner === owner)) })),
                ...accounts.map(account => ({ owner: account.owner, accountKey: account.id,
                    symbols: heldSymbols(positions.filter(row => row.accountId === account.id && row.owner === account.owner)) })),
            ];
            if (!targets.length) return;

            const schedules = new Map(VALUATION_MARKETS.map(market => [market, tradingMarketSchedule(market, at)]));
            const open = targets.filter(target => target.symbols.some(symbol => schedules.get(symbol.market)?.isOpen));
            const activeBook = new Set(open.flatMap(target => target.symbols.map(symbol => symbol.providerSymbol)));
            let resumeAt = await this.cooldownUntil();
            const legacyOnly = process.env.PORTFOLIO_VALUATION_INTERVAL_MINUTES === '5'
                || activeBook.size > MAX_MINUTE_VALUATION_SYMBOLS || at.getTime() < resumeAt + VALUATION_SLOT_MS;
            const legacy = legacyOnly || isLegacyValuationMinute(at);
            const slot = legacy ? valuationSlot(at) : minuteValuationSlot(at);
            const eligible = legacy ? targets.filter(({ symbols }) => !symbols.length || symbols.some(symbol => {
                const schedule = schedules.get(symbol.market);
                return schedule && (!schedule.calendarVerified || valuationMarketPhase(schedule, at) !== 'closed');
            })) : open;
            if (!eligible.length) return;

            await this.withSourceLease(async mayDispatch => {
                resumeAt = Math.max(resumeAt, await this.cooldownUntil());
                if (!legacy && at.getTime() < resumeAt + VALUATION_SLOT_MS) return;
                const policy: ValuationSourcePolicy = {
                    slot, legacy, blocked: () => !mayDispatch() || at.getTime() < resumeAt,
                    onThrottle: async retryAfterMs => {
                        const retryAt = at.getTime() + Math.max(VALUATION_SLOT_MS, retryAfterMs);
                        resumeAt = Math.max(resumeAt, Math.ceil(retryAt / VALUATION_SLOT_MS) * VALUATION_SLOT_MS);
                        await this.delaySource(new Date(resumeAt));
                    },
                };
                for (const { owner, accountKey } of eligible) {
                    if (!mayDispatch()) break;
                    await this.collect(owner, accountKey, at, async token => {
                        if (accountKey === 'real') {
                            const timezone = preferences.find(row => row.owner === owner)?.timezone ?? 'Asia/Shanghai';
                            await this.metrics.sample(owner, timezone, at, token, policy);
                        } else {
                            await this.samplePaper(owner, accountKey, at, token, policy);
                        }
                    }, slot);
                }
            });
        }
        finally {
            this.running = false;
        }
    }
    private async cooldownUntil(): Promise<number> {
        const [cooldown] = await this.db.select({ until: portfolioValuationClaims.leaseUntil }).from(portfolioValuationClaims)
            .where(and(eq(portfolioValuationClaims.owner, schedulerOwner), eq(portfolioValuationClaims.accountKey, schedulerAccount),
                eq(portfolioValuationClaims.slot, cooldownSlot)));
        return cooldown?.until.getTime() ?? -Infinity;
    }

    private async delaySource(until: Date): Promise<void> {
        await this.db.insert(portfolioValuationClaims).values({
            owner: schedulerOwner, accountKey: schedulerAccount, slot: cooldownSlot, token: randomUUID(), leaseUntil: until,
        }).onConflictDoUpdate({
            target: [portfolioValuationClaims.owner, portfolioValuationClaims.accountKey, portfolioValuationClaims.slot],
            set: { leaseUntil: sql`greatest(${portfolioValuationClaims.leaseUntil}, ${until.toISOString()}::timestamptz)` },
        });
    }

    private claimToken(claim: Claim) {
        return and(eq(portfolioValuationClaims.owner, claim.owner), eq(portfolioValuationClaims.accountKey, claim.accountKey),
            eq(portfolioValuationClaims.slot, claim.slot), eq(portfolioValuationClaims.token, claim.token));
    }

    private async acquire(claim: Claim): Promise<boolean> {
        const leaseUntil = sql`clock_timestamp() + interval '5 minutes'`;
        const [acquired] = await this.db.insert(portfolioValuationClaims).values({ ...claim, leaseUntil })
            .onConflictDoUpdate({
                target: [portfolioValuationClaims.owner, portfolioValuationClaims.accountKey, portfolioValuationClaims.slot],
                set: { token: claim.token, leaseUntil },
                setWhere: and(eq(portfolioValuationClaims.completed, false), sql`${portfolioValuationClaims.leaseUntil} < clock_timestamp()`),
            }).returning({ token: portfolioValuationClaims.token });
        return acquired?.token === claim.token;
    }

    private async release(claim: Claim): Promise<void> {
        await this.db.update(portfolioValuationClaims).set({ leaseUntil: sql`clock_timestamp()` })
            .where(and(this.claimToken(claim), eq(portfolioValuationClaims.completed, false)));
    }

    private async withSourceLease(work: (mayDispatch: () => boolean) => Promise<void>): Promise<void> {
        const claim = { owner: schedulerOwner, accountKey: schedulerAccount, slot: sourceLeaseSlot, token: randomUUID() };
        const deadline = performance.now() + VALUATION_SLOT_MS;
        if (!await this.acquire(claim)) return;
        try {
            await work(() => performance.now() < deadline);
        } finally {
            await this.release(claim);
        }
    }

    async collect(owner: string, accountKey: string, at: Date, work: (token: string) => Promise<void>, slot = valuationSlot(at)): Promise<void> {
        const claim = { owner, accountKey, slot, token: randomUUID() };
        if (!await this.acquire(claim)) return;
        try {
            await work(claim.token);
        } catch {
            this.logger.warn('Portfolio valuation capture failed');
            await this.release(claim).catch(() => this.logger.warn('Portfolio valuation lease release failed'));
            return;
        }
        await this.db.update(portfolioValuationClaims).set({ completed: true }).where(
            and(this.claimToken(claim), gt(portfolioValuationClaims.leaseUntil, sql`clock_timestamp()`)))
            .catch(() => this.logger.warn('Portfolio valuation completion could not be confirmed'));
    }

    private async corporateActions(position: HeldSymbol, at: Date, policy: ValuationSourcePolicy) {
        const ticker = portfolioQuoteSymbol(position.ticker, position.market ?? 'US');
        const key = resolveTradingTicker(ticker)?.providerSymbol ?? ticker, slot = valuationSlot(at);
        const cached = this.actionChecks.get(key);
        if (cached?.slot === slot) return cached.snapshot;
        // Event evidence is read on the pre-existing five-minute cadence, shared
        // by all paper accounts. Minute marks reuse that evidence within the bucket.
        if (policy.blocked()) return {};
        const { corporateActionsChecked, corporateActions } = await this.market.getSnapshot(ticker, at, false, policy.onThrottle);
        const snapshot = { corporateActionsChecked, corporateActions };
        this.actionChecks.delete(key);
        this.actionChecks.set(key, { slot, snapshot });
        while (this.actionChecks.size > 1024) {
            const oldest = this.actionChecks.keys().next().value;
            if (oldest !== undefined) this.actionChecks.delete(oldest);
        }
        return snapshot;
    }

    private async samplePaper(owner: string, accountId: string, at: Date, token: string, policy: ValuationSourcePolicy): Promise<void> {
        const capture = await this.db.transaction(async (tx) => {
            const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId), eq(paperAccounts.isActive, true)));
            if (!account || account.createdAt > at)
                return null;
            const positions = await tx.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, accountId))).orderBy(asc(paperPositions.id));
            const cash = await tx.select().from(simulationCash).where(and(eq(simulationCash.owner, owner), eq(simulationCash.accountId, accountId))).orderBy(asc(simulationCash.id));
            const rates = await tx.select().from(fxRates);
            const gaps = await readCorporateActionGaps(tx, owner, accountId);
            const timezone = await paperRiskTimezone(tx, owner, accountId);
            const [previous] = await tx.select({ marketQuotes: paperEquityObservations.marketQuotes }).from(paperEquityObservations)
                .where(and(eq(paperEquityObservations.owner, owner), eq(paperEquityObservations.accountId, accountId),
                    lte(paperEquityObservations.capturedAt, at), sql`jsonb_array_length(${paperEquityObservations.marketQuotes}) > 0`))
                .orderBy(desc(paperEquityObservations.capturedAt)).limit(1);
            return { account, positions, cash, rates, gaps, timezone, retained: previous?.marketQuotes ?? [] };
        }, { isolationLevel: 'repeatable read' });
        if (!capture)
            return;
        const { account, positions, cash, rates, timezone } = capture;
        const dateKey = paperRiskDay(at, timezone), gaps: string[] = capture.gaps.map(g => `CORPORATE_ACTION_RECONCILIATION_REQUIRED:${g.ticker}`);
        const marketQuotes = await this.metrics.captureQuotes(positions.filter(position => Number(position.shares) > 0), at, policy, capture.retained);
        let knownValueUsd = 0;
        const cashRows = account.ledgerMode === 'native_currency' ? cash.map(row => ({ currency: row.currency, balance: Number(row.available) + Number(row.frozen) + Number(row.unsettled), known: row.availabilityKnown }))
            : [{ currency: 'USD', balance: Number(account.cashBalance), known: true }];
        if (!cashRows.length)
            gaps.push('CASH_UNCONFIRMED');
        for (const row of cashRows) {
            const fx = resolvePortfolioFx(rates, row.currency, dateKey);
            if (!row.known || !Number.isFinite(row.balance) || row.balance < 0) {
                gaps.push(`CASH_UNCONFIRMED:${row.currency}`);
                continue;
            }
            if (!fx && row.balance !== 0) {
                gaps.push(`FX_MISSING:${row.currency}`);
                continue;
            }
            knownValueUsd += row.balance * (fx?.rate ?? 0);
        }
        for (const position of positions) {
            const quote = marketQuotes.find(q => q.ticker === position.ticker), fx = resolvePortfolioFx(rates, position.currency, dateKey);
            if (!Number.isFinite(Number(position.shares)) || Number(position.shares) < 0) {
                gaps.push(`HOLDING_INVALID:${position.ticker}`);
                continue;
            }
            if (Number(position.shares) === 0)
                continue;
            if (!quote)
                gaps.push(`QUOTE_TIME_UNVERIFIED:${position.ticker}`);
            if (!fx)
                gaps.push(`FX_MISSING:${position.currency}`);
            if (quote && fx)
                knownValueUsd += Number(position.shares) * quote.price * fx.rate;
            // Check existing corporate-action source without changing its ledger, bot or policy.
            try {
                const source = await this.corporateActions(position, at, policy);
                if (!source.corporateActionsChecked)
                    gaps.push(`CORPORATE_ACTION_UNVERIFIED:${position.ticker}`);
                if (source.corporateActions?.some(event => Date.parse(event.occurredAt) >= position.openedAt.getTime() && Date.parse(event.occurredAt) <= at.getTime()))
                    gaps.push(`CORPORATE_ACTION_RECONCILIATION_REQUIRED:${position.ticker}`);
            }
            catch {
                gaps.push(`CORPORATE_ACTION_UNVERIFIED:${position.ticker}`);
            }
        }
        const sourceFingerprint = hash([marketQuotes, knownValueUsd, positions.map(p => [p.id, p.shares, p.updatedAt]), cashRows, capture.gaps]);
        await this.db.transaction(async (tx) => {
            await lockMemoryOwner(tx, owner);
            const [current] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId))).for('update');
            if (!current?.isActive)
                return;
            const currentPositions = await tx.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, accountId))).orderBy(asc(paperPositions.id));
            const currentCash = await tx.select().from(simulationCash).where(and(eq(simulationCash.owner, owner), eq(simulationCash.accountId, accountId))).orderBy(asc(simulationCash.id));
            if (hash([currentPositions, currentCash, current.cashBalance]) !== hash([positions, cash, account.cashBalance]))
                gaps.push('ACCOUNT_CHANGED_DURING_CAPTURE');
            const currentGaps = await readCorporateActionGaps(tx, owner, accountId);
            if (hash(currentGaps) !== hash(capture.gaps))
                gaps.push('CORPORATE_ACTION_CHANGED_DURING_CAPTURE');
            const [previous] = await tx.select().from(paperEquityObservations).where(and(eq(paperEquityObservations.owner, owner), eq(paperEquityObservations.accountId, accountId))).orderBy(desc(paperEquityObservations.capturedAt)).limit(1);
            const complete = gaps.length === 0;
            if (!shouldSaveValuation(at, previous, { complete, gaps, sourceFingerprint }))
                return;
            const [claim] = await tx.select().from(portfolioValuationClaims).where(and(eq(portfolioValuationClaims.owner, owner), eq(portfolioValuationClaims.accountKey, accountId), eq(portfolioValuationClaims.slot, policy.slot), eq(portfolioValuationClaims.token, token), eq(portfolioValuationClaims.completed, false), gt(portfolioValuationClaims.leaseUntil, sql `clock_timestamp()`))).for('update');
            if (!claim)
                return;
            await tx.insert(paperEquityObservations).values({ owner, accountId, slot: policy.slot, dateKey, capturedAt: at,
                equityUsd: complete ? String(knownValueUsd) : null, knownValueUsd: String(knownValueUsd), complete, estimated: !complete,
                marketQuotes, gaps: [...new Set(gaps)], sourceFingerprint }).onConflictDoNothing();
        });
    }
}
