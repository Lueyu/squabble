import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, ne, gt, lte, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE_DATABASE,type PostgresJsDatabase } from '../../common/platform';
import { cashAccounts,fxRates,holdings,transactions } from '../../database/schema';
import { portfolioValuePoints } from '../../database/portfolio-value-points.schema';
import { portfolioValuationClaims, type PortfolioMarketQuote } from '../../database/portfolio-observations.schema';
import { positionBaselines } from '../../database/asset-ledger.schema';
import { QuoteService } from '../quote/quote.service';
import type { QuoteResponse } from '../../../shared/api.interface';
import { resolveTradingTicker } from '../../../shared/trading-market.interface';
import { ValuationSourceThrottled } from '../quote/valuation-rate-limit';
import { businessDate } from './simple-experience.rules';
import type { AssetValuationProvenance } from '../../../shared/simple-experience.interface';
import type { Market } from '../../../shared/api.interface';
import { lastCompletedTradingDate, tradingMarketDate, tradingMarketSchedule } from '../paper-trading/trading-market.calendar';
import { computePortfolioMetrics,resolvePortfolioFx,type PortfolioMetrics,type MetricsTransaction } from './portfolio-metrics';
import { portfolioQuoteSymbol, shouldSaveValuation, valuationMarketPhase, valuationSlot, verifiedMarketQuote, type ValuationSourcePolicy } from './portfolio-sampling.rules';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

export interface PortfolioTrend {
  points:Array<{date:string;capturedAt:string;valueUsd:number;complete:boolean}>;
  since:string|null;assetChangeUsd:number|null;netExternalFlowUsd:number|null;investmentPnlUsd:number|null;gaps:string[];
}
export interface PortfolioMetricsReading {metrics:PortfolioMetrics;trend:PortfolioTrend;refreshing:boolean;provenance:AssetValuationProvenance}
interface AssetCapture {positions:Array<typeof holdings.$inferSelect>;cash:Array<typeof cashAccounts.$inferSelect>;rates:Array<typeof fxRates.$inferSelect>;ledger:Array<typeof transactions.$inferSelect>;baselines:Array<typeof positionBaselines.$inferSelect>}
interface SamplePosition { ticker: string; market: string; currency: string }
type SampleQuote = Pick<QuoteResponse, 'symbol' | 'market' | 'currency' | 'price' | 'quoteAt' | 'tradingDate' | 'source' | 'previousClose'>;
interface SampledQuote { slot: string; attemptedAt: number; reading: SampleQuote | null; lastVerified: SampleQuote | null }

@Injectable()
export class PortfolioMetricsService {
  private readonly quotes=new Map<string,{value:QuoteResponse|null;at:number}>();
  private readonly pending=new Map<string,Promise<void>>();
  private readonly sampledQuotes = new Map<string, SampledQuote>();
  private readonly pendingSamples = new Map<string, Promise<SampleQuote | null>>();
  private activeQuotes=0;
  private readonly quoteWaiters:Array<()=>void>=[];
  constructor(@Inject(DRIZZLE_DATABASE)private readonly db:PostgresJsDatabase,@Optional()private readonly quote?:QuoteService){}
  private rememberQuote(key:string,value:QuoteResponse|null):void {
    this.quotes.delete(key);
    this.quotes.set(key,{value,at:Date.now()});
    while(this.quotes.size>1024){
      const oldest=this.quotes.keys().next().value!;
      this.quotes.delete(oldest);
    }
  }
  private async limitedQuote<T>(request: () => Promise<T>): Promise<T> {
    if (this.activeQuotes >= 4) await new Promise<void>(resolve => this.quoteWaiters.push(resolve));
    else this.activeQuotes++;
    try {
      return await request();
    } finally {
      const next = this.quoteWaiters.shift();
      if (next) next();
      else this.activeQuotes--;
    }
  }

  private async observations(symbols: Array<{ticker: string; market: string}>) {
    for (const { ticker, market } of symbols) {
      const key = market + ':' + ticker, cached = this.quotes.get(key);
      const source = this.quote;
      if (!source || this.pending.has(key) || cached && Date.now() - cached.at < 60_000) continue;
      const task = this.limitedQuote(() => source.getQuote(portfolioQuoteSymbol(ticker, market)))
        .then(value => this.rememberQuote(key, value))
        .catch(() => this.rememberQuote(key, null))
        .finally(() => this.pending.delete(key));
      this.pending.set(key, task);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...this.pending.values()]), new Promise(resolve => { timeout = setTimeout(resolve, 150); })]);
    if (timeout) clearTimeout(timeout);
    return Object.fromEntries(symbols.map(({ticker, market}) => [ticker, this.quotes.get(market + ':' + ticker)?.value ?? null]));
  }

  private async sampledQuote(position: SamplePosition, at: Date, retained: PortfolioMarketQuote[],
    policy?: ValuationSourcePolicy): Promise<SampleQuote | null> {
    const source = this.quote;
    const identity = resolveTradingTicker(portfolioQuoteSymbol(position.ticker, position.market));
    if (!source || !identity || identity.market !== position.market || identity.currency !== position.currency)
      return null;
    const slot = policy?.slot ?? valuationSlot(at);
    const key = identity.providerSymbol;
    const schedule = tradingMarketSchedule(identity.market, at);
    if (!schedule.calendarVerified) return null;
    const cached = this.sampledQuotes.get(key);
    if (cached?.slot === slot && cached.reading) return cached.reading;
    const phase = valuationMarketPhase(schedule, at);
    let last = cached?.lastVerified ?? null;
    const saved = retained.find(fact => fact.ticker === position.ticker && fact.market === identity.market && fact.currency === identity.currency);
    const savedAt = Date.parse(saved?.quoteAt ?? '');
    if (saved && Number.isFinite(savedAt) && (!last?.quoteAt || savedAt > Date.parse(last.quoteAt))) {
      last = { symbol: identity.ticker, market: identity.market, currency: identity.currency, price: String(saved.price),
        quoteAt: saved.quoteAt, tradingDate: tradingMarketDate(identity.market, new Date(savedAt)), source: saved.source };
    }
    const carried = phase !== 'open' && verifiedMarketQuote(position, last, at);
    if (carried && (phase !== 'closing' || (schedule.closesAt !== null && carried.quoteAt >= schedule.closesAt))) return last;
    if (cached?.slot === slot || policy?.blocked() || phase !== 'open' && policy?.legacy === false) return carried ? last : null;
    const pendingKey = slot + ':' + key;
    const pending = this.pendingSamples.get(pendingKey);
    if (pending) return pending;

    const task = this.limitedQuote(async () => {
      let quote: SampleQuote | null = null;
      const lastTime = Date.parse(last?.quoteAt ?? '');
      try {
        quote = await source.getValuationQuote(identity, at, {
          legacy: policy?.legacy ?? true,
          mayRequest: () => !policy?.blocked(),
          accepts: candidate => verifiedMarketQuote(position, candidate, at) !== null
            && !(Date.parse(candidate.quoteAt ?? '') < lastTime),
        });
      } catch (error) {
        if (error instanceof ValuationSourceThrottled) await policy?.onThrottle(error.retryAfterMs);
      }
      const fact = verifiedMarketQuote(position, quote, at);
      const reading = fact && !(Date.parse(fact.quoteAt) < lastTime) ? quote : null;
      const latest = this.sampledQuotes.get(key);
      if (!latest || latest.attemptedAt <= at.getTime()) {
        this.sampledQuotes.delete(key);
        this.sampledQuotes.set(key, { slot, attemptedAt: at.getTime(), reading, lastVerified: reading ?? last });
        while (this.sampledQuotes.size > 1024) {
          const oldest = this.sampledQuotes.keys().next().value;
          if (oldest !== undefined) this.sampledQuotes.delete(oldest);
        }
      }
      return reading;
    }).finally(() => this.pendingSamples.delete(pendingKey));
    this.pendingSamples.set(pendingKey, task);
    return task;
  }

  private async sampledReadings(positions: SamplePosition[], at: Date, retained: PortfolioMarketQuote[], policy?: ValuationSourcePolicy) {
    const raw = await Promise.all(positions.map(position => this.sampledQuote(position, at, retained, policy)));
    const facts: PortfolioMarketQuote[] = [];
    const quotes: Record<string, SampleQuote | null> = {};
    for (const [index, position] of positions.entries()) {
      const fact = verifiedMarketQuote(position, raw[index], at);
      const previous = retained.find(row => row.ticker === position.ticker && row.market === position.market && row.currency === position.currency);
      const usable = fact && !(previous && Date.parse(fact.quoteAt) < Date.parse(previous.quoteAt));
      quotes[position.ticker] = usable ? raw[index] : null;
      if (usable) facts.push(fact);
    }
    facts.sort((a, b) => [a.market, a.ticker, a.currency].join(':').localeCompare([b.market, b.ticker, b.currency].join(':')));
    return { quotes, facts };
  }

  async captureQuotes(positions: SamplePosition[], at: Date, policy?: ValuationSourcePolicy,
    retained: PortfolioMarketQuote[] = []): Promise<PortfolioMarketQuote[]> {
    return (await this.sampledReadings(positions, at, retained, policy)).facts;
  }

  async sample(owner: string, timezone: string, at: Date, claimToken: string, policy?: ValuationSourcePolicy): Promise<void> {
    const { positions, cash, rates, ledger, baselines } = await this.loadCapture(owner);
    const holdingsForValuation = positions.filter(row => Number(row.shares) !== 0).map(row => ({
      ...row, market: row.market ?? 'US', currency: row.currency ?? 'USD', currentPrice: null,
    }));
    if (!holdingsForValuation.length && !cash.some(row => row.reconciliationStatus === 'confirmed')) return;
    const [previous] = await this.db.select({ marketQuotes: portfolioValuePoints.marketQuotes }).from(portfolioValuePoints)
      .where(and(eq(portfolioValuePoints.owner, owner), ne(portfolioValuePoints.slot, 'origin'), lte(portfolioValuePoints.capturedAt, at),
        sql`jsonb_array_length(${portfolioValuePoints.marketQuotes}) > 0`))
      .orderBy(desc(portfolioValuePoints.capturedAt)).limit(1);
    const { quotes, facts } = await this.sampledReadings(holdingsForValuation.filter(row => Number(row.shares) > 0),
      at, previous?.marketQuotes ?? [], policy);
    const metrics = computePortfolioMetrics({ at, timezone, holdings: holdingsForValuation, cash, rates, quotes,
      transactions: ledger, scheduledQuotes: true });
    const checkpoints = this.positionCheckpoints(baselines, ledger);
    const quotesComplete = holdingsForValuation.filter(row => Number(row.shares) > 0).every(row => quotes[row.ticker]);
    await this.observe(owner, timezone, at, metrics, ledger, cash, checkpoints, facts, quotesComplete,
      this.assetFingerprint([positions, cash, ledger, baselines]), { token: claimToken, slot: policy?.slot ?? valuationSlot(at) });
  }

  private async loadCapture(owner: string): Promise<AssetCapture> {
    const [positions, cash, rates, ledger, baselines] = await this.db.transaction(async tx => Promise.all([
      tx.select().from(holdings).where(eq(holdings.owner, owner)),
      tx.select().from(cashAccounts).where(eq(cashAccounts.owner, owner)),
      tx.select().from(fxRates),
      tx.select().from(transactions).where(eq(transactions.owner, owner)),
      tx.select().from(positionBaselines).where(eq(positionBaselines.owner, owner)),
    ]), { isolationLevel: 'repeatable read' });
    return { positions, cash, rates, ledger, baselines };
  }

  private positionCheckpoints(baselines: AssetCapture['baselines'], ledger: AssetCapture['ledger']) {
    return [...baselines.map(b => ({ kind: 'baseline' as const, id: b.id,
      fingerprint: this.hash([b.ticker, b.currency, Number(b.shares), [...b.coveredTransactionIds].sort()]) })),
    ...ledger.filter(r => r.txType === 'Opening').map(r => ({ kind: 'opening' as const, id: r.id,
      fingerprint: this.hash([r.ticker, r.currency, r.txDate, Number(r.shares)]) }))]
      .sort((a, b) => (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id));
  }

  async read(owner:string,timezone:string,at=new Date(),capture?:AssetCapture):Promise<PortfolioMetricsReading> {
    const { positions, cash, rates, ledger, baselines } = capture ?? await this.loadCapture(owner);
    const tickers=[...new Set([...positions.map(p=>p.ticker),...ledger.filter(t=>['Buy','Sell'].includes(t.txType)&&t.txDate>=new Date(at.getTime()-14*86_400_000).toISOString().slice(0,10)).map(t=>t.ticker)])].filter(Boolean);
    const symbols=tickers.map(ticker=>{const position=positions.find(p=>p.ticker===ticker),currency=position?.currency??ledger.find(t=>t.ticker===ticker)?.currency;return {ticker,market:position?.market??(currency==='HKD'?'HK':currency==='CNY'?'CN':'US')};});
    const quotes=await this.observations(symbols);
    const marketQuotes=positions.flatMap(position=>{
      const fact=verifiedMarketQuote({ticker:position.ticker,market:position.market??'US',currency:position.currency??'USD'},quotes[position.ticker],at);
      return fact?[fact]:[];
    }).sort((a,b)=>`${a.market}:${a.ticker}:${a.currency}`.localeCompare(`${b.market}:${b.ticker}:${b.currency}`));
    const metrics=computePortfolioMetrics({at,timezone,holdings:positions,cash,rates,quotes,transactions:ledger});
    const positionCheckpoints=this.positionCheckpoints(baselines,ledger);
    if(positions.length||cash.some(c=>c.reconciliationStatus==='confirmed'))await this.observe(owner,timezone,at,metrics,ledger,cash,positionCheckpoints,marketQuotes,positions.filter(p=>Number(p.shares)>0).every(p=>marketQuotes.some(q=>q.ticker===p.ticker)),this.assetFingerprint([positions,cash,ledger,baselines]));
    const day=businessDate(at,timezone);
    const provenance:AssetValuationProvenance={fx:[...new Set([...positions.map(p=>p.currency??'USD'),...cash.filter(c=>Number(c.balance)!==0).map(c=>c.currency)])].map(currency=>{
      const rate=resolvePortfolioFx(rates,currency,day);const direct=currency==='USD'||!!rates.find(r=>r.base===currency&&r.quote==='USD'&&r.rateDate===rate?.date);
      return {currency,usdRate:rate?.rate??null,rateDate:rate?.date??null,source:currency==='USD'?'identity':rate?'recorded':'missing',direction:rate?(direct?'direct':'inverse'):null};
    }),quotes:symbols.map(({ticker,market})=>{
      const q=quotes[ticker],time=q?.quoteAt?new Date(q.quoteAt):null;
      const schedule=time&&Number.isFinite(time.getTime())?tradingMarketSchedule(market as Market,time):null;
      const previousCloseDate=q?.previousClose&&schedule?.opensAt?lastCompletedTradingDate(market as Market,new Date(Date.parse(schedule.opensAt)-1)):null;
      return {ticker,market,source:q?.source??'imported',quoteAt:q?.quoteAt??null,retrievedAt:q?new Date(this.quotes.get(`${market}:${ticker}`)!.at).toISOString():null,tradingDate:q?.tradingDate??null,previousCloseDate};
    })};
    return {metrics,trend:await this.trend(owner,ledger,rates,timezone,metrics,cash,positionCheckpoints),refreshing:symbols.some(s=>this.pending.has(`${s.market}:${s.ticker}`)),provenance};
  }
  private hash(value:unknown) {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
  private assetFingerprint([positions,cash,ledger,baselines]:[AssetCapture['positions'],AssetCapture['cash'],AssetCapture['ledger'],AssetCapture['baselines']]) {
    const sorted=(rows:unknown[][])=>rows.sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
    return this.hash([
      sorted(positions.map(p=>[p.id,p.ticker,p.market,p.currency,p.shares])),
      sorted(cash.map(c=>[c.id,c.currency,c.balance,c.reconciliationStatus,c.confirmedAt?.toISOString()??null])),
      sorted(ledger.map(t=>[t.id,t.ticker,t.currency,t.txType,t.txDate,t.shares,t.price,t.fees])),
      sorted(baselines.map(b=>[b.id,b.ticker,b.currency,b.shares,[...b.coveredTransactionIds].sort()])),
    ]);
  }
  private flowFingerprint(row:MetricsTransaction) {return createHash('sha256').update(JSON.stringify([row.txDate,row.txType,row.currency,row.shares,row.price,row.fees])).digest('hex');}
  private async observe(owner:string,timezone:string,at:Date,metrics:PortfolioMetrics,ledger:Array<MetricsTransaction&{id:string}>,cash:AssetCapture['cash'],positionCheckpoints:typeof portfolioValuePoints.$inferSelect['positionCheckpoints'],marketQuotes:PortfolioMarketQuote[],quotesComplete:boolean,captureFingerprint:string,claim?:{token:string;slot:string}) {
    const dateKey=businessDate(at,timezone),externalFlows=ledger.filter(r=>['Deposit','Withdrawal'].includes(r.txType)).map(r=>({id:r.id,fingerprint:this.flowFingerprint(r)})).sort((a,b)=>a.id.localeCompare(b.id));
    const cashCheckpoints=cash.map(c=>({currency:c.currency,confirmedAt:c.confirmedAt?.toISOString()??null})).sort((a,b)=>a.currency.localeCompare(b.currency));
    const values={owner,dateKey,capturedAt:at,totalValueUsd:metrics.totalValueUsd===null?null:String(metrics.totalValueUsd),knownValueUsd:String(metrics.knownValueUsd),
      complete:metrics.totalValueUsd!==null&&quotesComplete&&metrics.marketTimes.every(m=>m.dataAsOf!==null),estimated:metrics.estimated,externalFlows,cashCheckpoints,positionCheckpoints,
      marketQuotes,gaps:metrics.gaps,sourceFingerprint:this.hash([marketQuotes,metrics.totalValueUsd,metrics.knownValueUsd,externalFlows,cashCheckpoints,positionCheckpoints])};
    await this.db.transaction(async tx=>{
      await lockMemoryOwner(tx,owner);
      const current=await Promise.all([tx.select().from(holdings).where(eq(holdings.owner,owner)),tx.select().from(cashAccounts).where(eq(cashAccounts.owner,owner)),tx.select().from(transactions).where(eq(transactions.owner,owner)),tx.select().from(positionBaselines).where(eq(positionBaselines.owner,owner))]);
      if(this.assetFingerprint(current)!==captureFingerprint){values.complete=false;values.totalValueUsd=null;values.estimated=true;values.gaps=[...values.gaps,'ACCOUNT_CHANGED_DURING_CAPTURE'];}
      const [previous]=await tx.select().from(portfolioValuePoints).where(and(eq(portfolioValuePoints.owner,owner),ne(portfolioValuePoints.slot,'origin'))).orderBy(desc(portfolioValuePoints.capturedAt)).limit(1);
      if (!shouldSaveValuation(at, previous, values)) return;
      if (claim) {
        const [lease] = await tx.select().from(portfolioValuationClaims).where(and(eq(portfolioValuationClaims.owner, owner), eq(portfolioValuationClaims.accountKey, 'real'), eq(portfolioValuationClaims.slot, claim.slot), eq(portfolioValuationClaims.token, claim.token), eq(portfolioValuationClaims.completed, false), gt(portfolioValuationClaims.leaseUntil, sql`clock_timestamp()`))).for('update');
        if (!lease) return;
      }
      if(values.complete)await tx.insert(portfolioValuePoints).values({...values,slot:'origin'}).onConflictDoNothing();
      const slot=claim?.slot??valuationSlot(at);
      // Slot facts are immutable, including unknowns. A foreground refresh cannot
      // replace the background observer's unknown with an older saved price.
      await tx.insert(portfolioValuePoints).values({...values,slot}).onConflictDoNothing();
    });
  }
  private async trend(owner:string,ledger:Array<MetricsTransaction&{id:string}>,rates:Array<{base:string;quote:string;rate:string;rateDate:string}>,timezone:string,metrics:PortfolioMetrics,cash:AssetCapture['cash'],positionCheckpoints:typeof portfolioValuePoints.$inferSelect['positionCheckpoints']):Promise<PortfolioTrend> {
    const [origin]=await this.db.select().from(portfolioValuePoints).where(and(eq(portfolioValuePoints.owner,owner),eq(portfolioValuePoints.slot,'origin')));
    const recent=await this.db.select().from(portfolioValuePoints).where(and(eq(portfolioValuePoints.owner,owner),ne(portfolioValuePoints.slot,'origin'))).orderBy(desc(portfolioValuePoints.capturedAt)).limit(3000);
    const points=[...recent,...origin?[origin]:[]].sort((a,b)=>a.capturedAt.getTime()-b.capturedAt.getTime());
    const unique=points.filter((p,i)=>i===0||p.capturedAt.getTime()!==points[i-1].capturedAt.getTime());
    const gaps:string[]=[];let netFlow=0,flowKnown=true;
    if(origin){
      const checkpoints=cash.map(c=>({currency:c.currency,confirmedAt:c.confirmedAt?.toISOString()??null})).sort((a,b)=>a.currency.localeCompare(b.currency));
      if(JSON.stringify(checkpoints)!==JSON.stringify(origin.cashCheckpoints)){flowKnown=false;gaps.push('CASH_BASELINE_CHANGED');}
      if(this.hash(positionCheckpoints.map(p=>[p.kind,p.id,p.fingerprint]))!==this.hash(origin.positionCheckpoints.map(p=>[p.kind,p.id,p.fingerprint]))){flowKnown=false;gaps.push('POSITION_BASELINE_CHANGED');}
      const flows=ledger.filter(r=>['Deposit','Withdrawal'].includes(r.txType));
      const original=new Map(origin.externalFlows.map(r=>[r.id,r.fingerprint]));
      for(const [id,fingerprint] of original){const row=flows.find(r=>r.id===id);if(!row||this.flowFingerprint(row)!==fingerprint){flowKnown=false;gaps.push('FLOW_HISTORY_CHANGED');}}
      for(const row of flows.filter(r=>!original.has(r.id))){
        const fx=resolvePortfolioFx(rates,row.currency??'USD',row.txDate),amount=Number(row.shares)*Number(row.price);
        if(row.txDate<businessDate(origin.capturedAt,timezone)||!fx||!Number.isFinite(amount)){flowKnown=false;gaps.push('FLOW_HISTORY_REQUIRES_RECONCILIATION');continue;}
        netFlow+=amount*fx.rate*(row.txType==='Deposit'?1:-1);
      }
    }
    const assetChange=origin&&metrics.totalValueUsd!==null?metrics.totalValueUsd-Number(origin.totalValueUsd):null;
    const currentVerified=metrics.totalValueUsd!==null&&metrics.marketTimes.every(m=>m.dataAsOf!==null);
    if(origin&&!currentVerified)gaps.push('CURRENT_VALUATION_UNVERIFIED');
    return {points:unique.map(p=>({date:p.dateKey,capturedAt:p.capturedAt.toISOString(),valueUsd:Number(p.knownValueUsd),complete:p.complete})),since:origin?.capturedAt.toISOString()??null,
      assetChangeUsd:assetChange,netExternalFlowUsd:origin&&flowKnown?netFlow:null,investmentPnlUsd:assetChange!==null&&flowKnown&&currentVerified?assetChange-netFlow:null,gaps:[...new Set(gaps)]};
  }
}
