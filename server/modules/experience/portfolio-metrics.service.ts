import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq,ne,gt,sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE_DATABASE,type PostgresJsDatabase } from '../../common/platform';
import { cashAccounts,fxRates,holdings,transactions } from '../../database/schema';
import { portfolioValuePoints } from '../../database/portfolio-value-points.schema';
import { portfolioValuationClaims, type PortfolioMarketQuote } from '../../database/portfolio-observations.schema';
import { positionBaselines } from '../../database/asset-ledger.schema';
import { QuoteService } from '../quote/quote.service';
import type { QuoteResponse } from '../../../shared/api.interface';
import { businessDate } from './simple-experience.rules';
import type { AssetValuationProvenance } from '../../../shared/simple-experience.interface';
import type { Market } from '../../../shared/api.interface';
import { lastCompletedTradingDate,tradingMarketSchedule } from '../paper-trading/trading-market.calendar';
import { computePortfolioMetrics,resolvePortfolioFx,type PortfolioMetrics,type MetricsTransaction } from './portfolio-metrics';
import { valuationSlot, verifiedMarketQuote } from './portfolio-sampling.rules';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';

export interface PortfolioTrend {
  points:Array<{date:string;capturedAt:string;valueUsd:number;complete:boolean}>;
  since:string|null;assetChangeUsd:number|null;netExternalFlowUsd:number|null;investmentPnlUsd:number|null;gaps:string[];
}
export interface PortfolioMetricsReading {metrics:PortfolioMetrics;trend:PortfolioTrend;refreshing:boolean;provenance:AssetValuationProvenance}
interface AssetCapture {positions:Array<typeof holdings.$inferSelect>;cash:Array<typeof cashAccounts.$inferSelect>;rates:Array<typeof fxRates.$inferSelect>;ledger:Array<typeof transactions.$inferSelect>;baselines:Array<typeof positionBaselines.$inferSelect>}
export function portfolioQuoteSymbol(ticker:string,market:string):string {return market==='HK'&&/^\d{1,5}$/u.test(ticker)?`${ticker}.HK`:ticker;}

@Injectable()
export class PortfolioMetricsService {
  private readonly quotes=new Map<string,{value:QuoteResponse|null;at:number}>();
  private readonly pending=new Map<string,Promise<void>>();
  private readonly datedAttempts=new Map<string,number>();
  private activeQuotes=0;
  private readonly quoteWaiters:Array<()=>void>=[];
  constructor(@Inject(DRIZZLE_DATABASE)private readonly db:PostgresJsDatabase,@Optional()private readonly quote?:QuoteService){}
  private rememberQuote(key:string,value:QuoteResponse|null):void {
    this.quotes.delete(key);
    this.quotes.set(key,{value,at:Date.now()});
    while(this.quotes.size>1024){
      const oldest=this.quotes.keys().next().value!;
      this.quotes.delete(oldest);this.datedAttempts.delete(oldest);
    }
  }
  private async limitedQuote(symbol:string,datedUs=false,at=new Date()) {
    if(this.activeQuotes>=4)await new Promise<void>(resolve=>this.quoteWaiters.push(resolve));
    else this.activeQuotes++;
    try{
      if(!datedUs)return await this.quote!.getQuote(symbol);
      const source=this.quote as QuoteService&{fetchUsObservedQuote?:(ticker:string)=>Promise<QuoteResponse|null>};
      const observed=await source.fetchUsObservedQuote?.(symbol).catch(()=>null);
      if(verifiedMarketQuote({ticker:symbol,market:'US',currency:'USD'},observed,at))return observed;
      return await source.fetchUsQuoteYahoo?.(symbol)??null;
    }finally{const next=this.quoteWaiters.shift();if(next)next();else this.activeQuotes--;}
  }
  private async observations(symbols:Array<{ticker:string;market:string}>,wait=false,at=new Date()) {
    for(const {ticker,market} of symbols) {
      const key=`${market}:${ticker}`,cached=this.quotes.get(key);
      if(!this.quote||this.pending.has(key)||cached&&Date.now()-cached.at<60_000)continue;
      const task=this.limitedQuote(portfolioQuoteSymbol(ticker,market)).then(value=>{this.rememberQuote(key,value);}).catch(()=>{
        this.rememberQuote(key,null);
      }).finally(()=>this.pending.delete(key));this.pending.set(key,task);
    }
    let timeout:ReturnType<typeof setTimeout>|undefined;
    if(wait)await Promise.all([...this.pending.values()]);
    else await Promise.race([Promise.all([...this.pending.values()]),new Promise(resolve=>{timeout=setTimeout(resolve,150);})]);
    if(timeout)clearTimeout(timeout);
    if(wait&&this.quote){
      for(const {ticker,market} of symbols){
        const key=`${market}:${ticker}`,datedKey=`${key}:dated`,cached=this.quotes.get(key);
        if(market!=='US'||verifiedMarketQuote({ticker,market,currency:'USD'},cached?.value,at)||Date.now()-(this.datedAttempts.get(key)??0)<60_000)continue;
        this.datedAttempts.set(key,Date.now());
        const task=this.limitedQuote(ticker,true,at).then(value=>{this.rememberQuote(key,value);})
          .catch(()=>{this.rememberQuote(key,null);}).finally(()=>this.pending.delete(datedKey));
        this.pending.set(datedKey,task);
      }
      await Promise.all([...this.pending.values()]);
    }
    return Object.fromEntries(symbols.map(({ticker,market})=>[ticker,this.quotes.get(`${market}:${ticker}`)?.value??null]));
  }
  async sample(owner:string,timezone:string,at:Date,claimToken:string):Promise<void> {
    await this.read(owner,timezone,at,undefined,claimToken);
  }
  async captureQuotes(positions:Array<{ticker:string;market:string;currency:string}>,at:Date):Promise<PortfolioMarketQuote[]> {
    const quotes=await this.observations(positions,true,at);
    return positions.flatMap(position=>{const fact=verifiedMarketQuote(position,quotes[position.ticker],at);return fact?[fact]:[];}).sort((a,b)=>`${a.market}:${a.ticker}:${a.currency}`.localeCompare(`${b.market}:${b.ticker}:${b.currency}`));
  }
  async read(owner:string,timezone:string,at=new Date(),capture?:AssetCapture,claimToken?:string):Promise<PortfolioMetricsReading> {
    const [positions,cash,rates,ledger,baselines]=capture?[capture.positions,capture.cash,capture.rates,capture.ledger,capture.baselines]:await this.db.transaction(async tx=>Promise.all([
      tx.select().from(holdings).where(eq(holdings.owner,owner)),tx.select().from(cashAccounts).where(eq(cashAccounts.owner,owner)),
      tx.select().from(fxRates),tx.select().from(transactions).where(eq(transactions.owner,owner)),
      tx.select().from(positionBaselines).where(eq(positionBaselines.owner,owner)),
    ]),{isolationLevel:'repeatable read'});
    const tickers=[...new Set([...positions.map(p=>p.ticker),...ledger.filter(t=>['Buy','Sell'].includes(t.txType)&&t.txDate>=new Date(at.getTime()-14*86_400_000).toISOString().slice(0,10)).map(t=>t.ticker)])].filter(Boolean);
    const symbols=tickers.map(ticker=>{const position=positions.find(p=>p.ticker===ticker),currency=position?.currency??ledger.find(t=>t.ticker===ticker)?.currency;return {ticker,market:position?.market??(currency==='HKD'?'HK':currency==='CNY'?'CN':'US')};});
    const rawQuotes=await this.observations(symbols,!!claimToken,at);
    const marketQuotes=positions.flatMap(position=>{
      const fact=verifiedMarketQuote({ticker:position.ticker,market:position.market??'US',currency:position.currency??'USD'},rawQuotes[position.ticker],at);
      return fact?[fact]:[];
    }).sort((a,b)=>`${a.market}:${a.ticker}:${a.currency}`.localeCompare(`${b.market}:${b.ticker}:${b.currency}`));
    const quotes=claimToken?Object.fromEntries(symbols.map(s=>[s.ticker,marketQuotes.some(q=>q.ticker===s.ticker)?rawQuotes[s.ticker]:null])):rawQuotes;
    const metrics=computePortfolioMetrics({at,timezone,holdings:claimToken?positions.map(p=>({...p,currentPrice:null})):positions,cash,rates,quotes,transactions:ledger});
    const positionCheckpoints=[...baselines.map(b=>({kind:'baseline' as const,id:b.id,fingerprint:this.hash([b.ticker,b.currency,Number(b.shares),[...b.coveredTransactionIds].sort()])})),
      ...ledger.filter(r=>r.txType==='Opening').map(r=>({kind:'opening' as const,id:r.id,fingerprint:this.hash([r.ticker,r.currency,r.txDate,Number(r.shares)])}))].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    if(positions.length||cash.some(c=>c.reconciliationStatus==='confirmed'))await this.observe(owner,timezone,at,metrics,ledger,cash,positionCheckpoints,marketQuotes,positions.filter(p=>Number(p.shares)>0).every(p=>marketQuotes.some(q=>q.ticker===p.ticker)),claimToken,this.assetFingerprint([positions,cash,ledger,baselines]));
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
  private async observe(owner:string,timezone:string,at:Date,metrics:PortfolioMetrics,ledger:Array<MetricsTransaction&{id:string}>,cash:AssetCapture['cash'],positionCheckpoints:typeof portfolioValuePoints.$inferSelect['positionCheckpoints'],marketQuotes:PortfolioMarketQuote[],quotesComplete:boolean,claimToken?:string,captureFingerprint?:string) {
    const dateKey=businessDate(at,timezone),externalFlows=ledger.filter(r=>['Deposit','Withdrawal'].includes(r.txType)).map(r=>({id:r.id,fingerprint:this.flowFingerprint(r)})).sort((a,b)=>a.id.localeCompare(b.id));
    const cashCheckpoints=cash.map(c=>({currency:c.currency,confirmedAt:c.confirmedAt?.toISOString()??null})).sort((a,b)=>a.currency.localeCompare(b.currency));
    const values={owner,dateKey,capturedAt:at,totalValueUsd:metrics.totalValueUsd===null?null:String(metrics.totalValueUsd),knownValueUsd:String(metrics.knownValueUsd),
      complete:metrics.totalValueUsd!==null&&quotesComplete&&metrics.marketTimes.every(m=>m.dataAsOf!==null),estimated:metrics.estimated,externalFlows,cashCheckpoints,positionCheckpoints,
      marketQuotes,gaps:metrics.gaps,sourceFingerprint:this.hash([marketQuotes,metrics.totalValueUsd,metrics.knownValueUsd,externalFlows,cashCheckpoints,positionCheckpoints])};
    await this.db.transaction(async tx=>{
      await lockMemoryOwner(tx,owner);
      if(claimToken){
        const [claim]=await tx.select().from(portfolioValuationClaims).where(and(eq(portfolioValuationClaims.owner,owner),eq(portfolioValuationClaims.accountKey,'real'),eq(portfolioValuationClaims.slot,valuationSlot(at)),eq(portfolioValuationClaims.token,claimToken),eq(portfolioValuationClaims.completed,false),gt(portfolioValuationClaims.leaseUntil,sql`clock_timestamp()`))).for('update');
        if(!claim)return;
      }
      if(captureFingerprint){
        const current=await Promise.all([tx.select().from(holdings).where(eq(holdings.owner,owner)),tx.select().from(cashAccounts).where(eq(cashAccounts.owner,owner)),tx.select().from(transactions).where(eq(transactions.owner,owner)),tx.select().from(positionBaselines).where(eq(positionBaselines.owner,owner))]);
        if(this.assetFingerprint(current)!==captureFingerprint){values.complete=false;values.totalValueUsd=null;values.estimated=true;values.gaps=[...values.gaps,'ACCOUNT_CHANGED_DURING_CAPTURE'];}
      }
      const [previous]=await tx.select().from(portfolioValuePoints).where(and(eq(portfolioValuePoints.owner,owner),ne(portfolioValuePoints.slot,'origin'))).orderBy(desc(portfolioValuePoints.capturedAt)).limit(1);
      if(values.complete&&marketQuotes.length>0&&previous?.complete&&previous.sourceFingerprint===values.sourceFingerprint)return;
      if(values.complete)await tx.insert(portfolioValuePoints).values({...values,slot:'origin'}).onConflictDoNothing();
      const slot=valuationSlot(at);
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
