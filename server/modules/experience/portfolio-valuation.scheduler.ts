import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { cashAccounts, fxRates, holdings, paperAccounts, paperPositions } from '../../database/schema';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { paperEquityObservations, portfolioValuationClaims } from '../../database/portfolio-observations.schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import { PortfolioMetricsService } from './portfolio-metrics.service';
import { resolvePortfolioFx } from './portfolio-metrics';
import { valuationSlot } from './portfolio-sampling.rules';
import { paperRiskDay, paperRiskTimezone } from '../paper-trading/paper-risk-day';
import { readCorporateActionGaps } from '../paper-trading/simulation-corporate-actions';
import { TradingMarketService } from '../paper-trading/trading-market.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Claim = {
    owner: string;
    accountKey: string;
    slot: string;
    token: string;
};
/** Valuation only: no strategy, research, order or settlement service is called here.
 * A durable slot lease bounds duplicate public requests across application processes.
 * The final write locks and checks its token, so an expired worker cannot publish. */
@Injectable()
export class PortfolioValuationScheduler implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PortfolioValuationScheduler.name);
    private timer: ReturnType<typeof setInterval> | undefined;
    private running = false;
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
            // Imported workspaces may predate their local user record. Only owners with actual
            // assets are collected; these reads neither enable experience nor start daily work.
            const assets = await this.db.select({ owner: holdings.owner }).from(holdings);
            const cash = await this.db.select({ owner: cashAccounts.owner }).from(cashAccounts);
            const realOwners = [...new Set([...assets, ...cash].map(row => row.owner))];
            const accounts = await this.db.select().from(paperAccounts).where(eq(paperAccounts.isActive, true));
            for (const owner of realOwners)
                await this.collect(owner, 'real', at, async (token) => {
                    await this.metrics.sample(owner, preferences.find(row => row.owner === owner)?.timezone ?? 'Asia/Shanghai', at, token);
                });
            for (const account of accounts)
                await this.collect(account.owner, account.id, at, async (token) => {
                    await this.samplePaper(account.owner, account.id, at, token);
                });
        }
        finally {
            this.running = false;
        }
    }
    async collect(owner: string, accountKey: string, at: Date, work: (token: string) => Promise<void>): Promise<void> {
        const claim: Claim = { owner, accountKey, slot: valuationSlot(at), token: randomUUID() };
        const leaseUntil = sql `clock_timestamp() + interval '5 minutes'`;
        const [acquired] = await this.db.insert(portfolioValuationClaims).values({ ...claim, leaseUntil })
            .onConflictDoUpdate({ target: [portfolioValuationClaims.owner, portfolioValuationClaims.accountKey, portfolioValuationClaims.slot],
            set: { token: claim.token, leaseUntil }, setWhere: and(eq(portfolioValuationClaims.completed, false), sql `${portfolioValuationClaims.leaseUntil} < clock_timestamp()`) })
            .returning({ token: portfolioValuationClaims.token });
        if (acquired?.token !== claim.token)
            return;
        try {
            await work(claim.token);
            await this.db.update(portfolioValuationClaims).set({ completed: true }).where(and(eq(portfolioValuationClaims.owner, owner), eq(portfolioValuationClaims.accountKey, accountKey), eq(portfolioValuationClaims.slot, claim.slot), eq(portfolioValuationClaims.token, claim.token), gt(portfolioValuationClaims.leaseUntil, sql `clock_timestamp()`)));
        }
        catch {
            // A failed fetch is normally recorded as an unknown fact. An infrastructure failure
            // leaves the lease retryable, without logging holdings or user identifiers.
            this.logger.warn('Portfolio valuation slot waiting after failed capture');
        }
    }
    private async samplePaper(owner: string, accountId: string, at: Date, token: string): Promise<void> {
        const capture = await this.db.transaction(async (tx) => {
            const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId), eq(paperAccounts.isActive, true)));
            if (!account)
                return null;
            const positions = await tx.select().from(paperPositions).where(and(eq(paperPositions.owner, owner), eq(paperPositions.accountId, accountId))).orderBy(asc(paperPositions.id));
            const cash = await tx.select().from(simulationCash).where(and(eq(simulationCash.owner, owner), eq(simulationCash.accountId, accountId))).orderBy(asc(simulationCash.id));
            const rates = await tx.select().from(fxRates);
            const gaps = await readCorporateActionGaps(tx, owner, accountId);
            const timezone = await paperRiskTimezone(tx, owner, accountId);
            return { account, positions, cash, rates, gaps, timezone };
        }, { isolationLevel: 'repeatable read' });
        if (!capture)
            return;
        const { account, positions, cash, rates, timezone } = capture;
        const dateKey = paperRiskDay(at, timezone), gaps: string[] = capture.gaps.map(g => `CORPORATE_ACTION_RECONCILIATION_REQUIRED:${g.ticker}`);
        const marketQuotes = await this.metrics.captureQuotes(positions, at);
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
                const source = await this.market.getSnapshot(position.ticker, at);
                if (!source.corporateActionsChecked)
                    gaps.push(`CORPORATE_ACTION_UNVERIFIED:${position.ticker}`);
                if (source.corporateActions?.some(event => Date.parse(event.occurredAt) >= position.openedAt.getTime() && Date.parse(event.occurredAt) <= at.getTime()))
                    gaps.push(`CORPORATE_ACTION_RECONCILIATION_REQUIRED:${position.ticker}`);
            }
            catch {
                gaps.push(`CORPORATE_ACTION_UNVERIFIED:${position.ticker}`);
            }
        }
        const complete = gaps.length === 0, sourceFingerprint = hash([marketQuotes, knownValueUsd, positions.map(p => [p.id, p.shares, p.updatedAt]), cashRows, capture.gaps]);
        await this.db.transaction(async (tx) => {
            await lockMemoryOwner(tx, owner);
            const [claim] = await tx.select().from(portfolioValuationClaims).where(and(eq(portfolioValuationClaims.owner, owner), eq(portfolioValuationClaims.accountKey, accountId), eq(portfolioValuationClaims.slot, valuationSlot(at)), eq(portfolioValuationClaims.token, token), eq(portfolioValuationClaims.completed, false), gt(portfolioValuationClaims.leaseUntil, sql `clock_timestamp()`))).for('update');
            if (!claim)
                return;
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
            if (complete && !gaps.length && marketQuotes.length > 0 && previous?.complete && previous.sourceFingerprint === sourceFingerprint)
                return;
            await tx.insert(paperEquityObservations).values({ owner, accountId, slot: valuationSlot(at), dateKey, capturedAt: at,
                equityUsd: complete && !gaps.length ? String(knownValueUsd) : null, knownValueUsd: String(knownValueUsd), complete: complete && !gaps.length, estimated: gaps.length > 0,
                marketQuotes, gaps: [...new Set(gaps)], sourceFingerprint }).onConflictDoNothing();
        });
    }
}
