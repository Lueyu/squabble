import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from '../../common/platform';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { cashAccounts, fxRates, holdings, paperAccounts, paperPositions, paperSnapshots } from '../../database/schema';
import { paperEquityObservations, portfolioValuationClaims } from '../../database/portfolio-observations.schema';
import { portfolioValuePoints } from '../../database/portfolio-value-points.schema';
import { PortfolioMetricsService } from './portfolio-metrics.service';
import { PortfolioValuationScheduler } from './portfolio-valuation.scheduler';
import { PortfolioComparisonService } from '../paper-trading/portfolio-comparison.service';
import { MAX_MINUTE_VALUATION_SYMBOLS, minuteValuationSlot, valuationSlot } from './portfolio-sampling.rules';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { HoldingsService } from '../holdings/holdings.service';
import { CashAccountsService } from '../cash-accounts/cash-accounts.service';
import { QuoteService } from '../quote/quote.service';
import { TradingMarketService } from '../paper-trading/trading-market.service';
import type { TradingTicker } from '../../../shared/trading-market.interface';
import { of, throwError } from 'rxjs';

async function fixture(run:(db:PostgresJsDatabase,client:ReturnType<typeof postgres>)=>Promise<void>){
  assert.ok(process.env.EXPERIENCE_TEST_DATABASE_URL,'An isolated EXPERIENCE_TEST_DATABASE_URL is required');
  const url=process.env.EXPERIENCE_TEST_DATABASE_URL!,namespace=`valuation_${randomUUID().replaceAll('-','')}`;
  const admin=postgres(url,{max:1,onnotice:()=>{}}),client=postgres(url,{max:10,onnotice:()=>{},connection:{search_path:namespace}});
  try{await admin`CREATE SCHEMA ${admin(namespace)}`;await client.unsafe(readFileSync('scripts/db/01_schema.sql','utf8'));await run(drizzle(client),client);}
  finally{await client.end();await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`;await admin.end();}
}

test('five-minute collection persists real and paused paper facts; stale sources stay unknown and archived/foreign accounts stay untouched',async()=>fixture(async(db,client)=>{
  const owner=randomUUID(),other=randomUUID();
  await db.insert(holdings).values({owner,ticker:'ACME',market:'US',currency:'USD',shares:'10',buyPrice:'100',currentPrice:'999'});
  await db.insert(cashAccounts).values({owner,currency:'USD',balance:'500',reconciliationStatus:'confirmed'});
  const createdAt = new Date('2026-11-01T00:00:00Z');
  const [paused,archived,foreign]=await db.insert(paperAccounts).values([{owner,createdAt,botEnabled:false,cashBalance:'100'},{owner,createdAt,isActive:false},{owner:other,createdAt,cashBalance:'888'}]).returning();
  await db.insert(paperPositions).values({owner,accountId:paused.id,ticker:'ACME',market:'US',currency:'USD',shares:'2',avgCost:'100',openedAt:new Date('2026-11-01')});
  let quoteAt='2026-11-05T15:59:00Z',calls=0;
  const quote={getValuationQuote:async()=>{calls++;return {symbol:'ACME',market:'US',currency:'USD',price:'110',previousClose:'100',quoteAt,tradingDate:'2026-11-05',source:'fixture'};}};
  const market={getSnapshot:async()=>({corporateActionsChecked:true,corporateActions:[]})};
  const make=()=>new PortfolioValuationScheduler(db,new PortfolioMetricsService(db,quote as never),market as never);
  const at=new Date('2026-11-05T16:00:00Z');
  await Promise.all([make().tick(at),make().tick(at)]);
  const real=await db.select().from(portfolioValuePoints).where(and(eq(portfolioValuePoints.owner,owner),eq(portfolioValuePoints.slot,valuationSlot(at))));
  assert.equal(real.length,1);assert.equal(real[0].totalValueUsd,'1600');assert.equal(real[0].complete,true);
  assert.equal(real[0].marketQuotes[0].quoteAt,'2026-11-05T15:59:00.000Z');
  const first=await db.select().from(paperEquityObservations);
  assert.equal(first.filter(p=>p.accountId===paused.id).length,1,'bot pause never disables valuation');
  assert.equal(first.find(p=>p.accountId===paused.id)!.equityUsd,'320');
  assert.ok(!first.some(p=>p.accountId===archived.id));
  assert.equal(first.find(p=>p.accountId===foreign.id)!.owner,other);
  assert.equal(calls,1,'one source request serves both portfolios and competing workers');
  // Same source timestamps do not become new complete five-minute market observations.
  await make().tick(new Date('2026-11-05T16:05:00Z'));
  assert.equal((await db.select().from(paperEquityObservations).where(eq(paperEquityObservations.accountId,paused.id))).length,1);
  quoteAt='2026-11-05T16:09:00Z';
  await make().tick(new Date('2026-11-05T16:10:00Z'));
  assert.equal((await db.select().from(paperEquityObservations).where(eq(paperEquityObservations.accountId,paused.id))).length,2);
  // Retrieval succeeds with a price, but provider time is over twenty minutes old.
  await make().tick(new Date('2026-11-05T17:00:00Z'));
  const unknown=(await db.select().from(paperEquityObservations).where(and(eq(paperEquityObservations.accountId,paused.id),eq(paperEquityObservations.slot,valuationSlot(new Date('2026-11-05T17:00:00Z'))))))[0];
  assert.equal(unknown.equityUsd,null);assert.equal(unknown.knownValueUsd,'100');assert.deepEqual(unknown.marketQuotes,[]);
  // Legacy daily writer cannot resurrect complete equity after a persisted unknown.
  await db.insert(paperSnapshots).values({owner,accountId:paused.id,snapshotDate:'2026-11-05',valuedAt:new Date('2026-11-05T17:01:00Z'),equity:'999',cash:'100'});
  const comparison=await new PortfolioComparisonService(db).read(owner,'1D',paused.id,new Date('2026-11-05T17:02:00Z'));
  assert.equal(comparison.series[0].equityUsd,null);assert.equal(comparison.series[0].points.at(-1)!.equityUsd,null);
  assert.equal(comparison.granularity,'observations');
  assert.equal((await new PortfolioComparisonService(db).read(owner,'1W',paused.id,new Date('2026-11-05T17:02:00Z'))).granularity,'observations');
  assert.equal((await new PortfolioComparisonService(db).read(owner,'1M',paused.id,new Date('2026-11-05T17:02:00Z'))).granularity,'hourly');
  await assert.rejects(new PortfolioComparisonService(db).read(owner,'1D',foreign.id),/COMPARISON_ACCOUNT_NOT_FOUND/);
  const counts=await client`SELECT (SELECT count(*) FROM paper_trades) AS trades,(SELECT count(*) FROM paper_orders) AS orders,(SELECT count(*) FROM research_current_views) AS research`;
  assert.equal(Number(counts[0].trades),0);assert.equal(Number(counts[0].orders),0);assert.equal(Number(counts[0].research),0);
}));

test('failed minute capture retries on the next tick and publishes its provider quote once', async () => fixture(async (db, client) => {
  const owner = randomUUID(), first = new Date('2026-11-05T16:01:00Z'), retry = new Date('2026-11-05T16:01:30Z');
  const [account] = await db.insert(paperAccounts).values({ owner, createdAt: first, cashBalance: '100' }).returning();
  await db.insert(paperPositions).values({ owner, accountId: account.id, ticker: 'ACME', shares: '2', openedAt: first });
  await client`ALTER TABLE paper_equity_observations ADD CHECK (captured_at <> TIMESTAMPTZ '2026-11-05T16:01:00Z')`;
  let requests = 0;
  const quote = { getValuationQuote: async () => {
    requests++;
    return { symbol: 'ACME', market: 'US', currency: 'USD', price: '110', quoteAt: first.toISOString(),
      tradingDate: '2026-11-05', source: 'fixture' };
  } };
  const market = { getSnapshot: async () => ({ corporateActionsChecked: true, corporateActions: [] }) };
  const sampler = new PortfolioValuationScheduler(db, new PortfolioMetricsService(db, quote as never), market as never);
  const accountClaim = () => db.select().from(portfolioValuationClaims).where(and(
    eq(portfolioValuationClaims.accountKey, account.id), eq(portfolioValuationClaims.slot, minuteValuationSlot(first))));
  await sampler.tick(first);
  const [failed] = await accountClaim();
  assert.equal(failed.completed, false);
  assert.equal((await db.select().from(paperEquityObservations)).length, 0);

  await sampler.tick(retry);
  await sampler.tick(retry);
  const points = await db.select().from(paperEquityObservations);
  assert.equal(points.length, 1);
  assert.equal(points[0].capturedAt.toISOString(), retry.toISOString());
  assert.equal(points[0].equityUsd, '320');
  assert.equal(points[0].marketQuotes[0].quoteAt, first.toISOString());
  const [completed] = await accountClaim();
  assert.equal(completed.completed, true);
  assert.notEqual(completed.token, failed.token);
  assert.equal(requests, 1);
}));

test('a late capture failure preserves the successor lease until its worker completes', async () => fixture(async db => {
  const owner = randomUUID(), at = new Date('2026-11-05T16:01:00Z'), slot = minuteValuationSlot(at);
  const make = () => new PortfolioValuationScheduler(db, new PortfolioMetricsService(db), {} as never);
  let started!: (token: string) => void, release!: () => void;
  const acquired = new Promise<string>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const old = make().collect(owner, 'real', at, async token => {
    started(token);
    await barrier;
    throw new Error('capture failed after takeover');
  }, slot);
  const oldToken = await acquired;
  let unexpectedAcquisitions = 0;
  const compete = () => make().collect(owner, 'real', at, async () => { unexpectedAcquisitions++; }, slot);
  const readClaim = () => db.select().from(portfolioValuationClaims).where(eq(portfolioValuationClaims.owner, owner));
  let successorToken: string | undefined, successorExpiry: Date | undefined;
  try {
    await compete();
    assert.equal(unexpectedAcquisitions, 0, 'a silent worker retains its unexpired lease');
    await db.update(portfolioValuationClaims).set({ leaseUntil: new Date(0) }).where(eq(portfolioValuationClaims.token, oldToken));
    await make().collect(owner, 'real', at, async token => {
      successorToken = token;
      const [claim] = await readClaim();
      successorExpiry = claim.leaseUntil;
      release();
      await old;
      await compete();
    }, slot);
  } finally {
    release();
    await old;
  }
  const [completed] = await readClaim();
  assert.equal(unexpectedAcquisitions, 0, 'a late failure cannot release a live successor');
  assert.notEqual(completed.token, oldToken);
  assert.equal(completed.token, successorToken);
  assert.deepEqual(completed.leaseUntil, successorExpiry);
  assert.equal(completed.completed, true);
}));

test('expired claim takeover fences the original writer and additive migration is repeatable without deleting facts',async()=>fixture(async(db,client)=>{
  const owner=randomUUID(),at=new Date('2026-11-05T16:00:00Z');
  await db.insert(cashAccounts).values({owner,currency:'USD',balance:'100',reconciliationStatus:'confirmed'});
  const metrics=new PortfolioMetricsService(db),sampler=new PortfolioValuationScheduler(db,metrics,{} as never);
  let release!:()=>void,oldToken='',started!:()=>void;
  const barrier=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>started=resolve);
  const old=sampler.collect(owner,'real',at,async token=>{oldToken=token;started();await barrier;await metrics.sample(owner,'UTC',at,token);});
  await entered;
  await db.update(portfolioValuationClaims).set({leaseUntil:new Date(0)}).where(eq(portfolioValuationClaims.token,oldToken));
  await sampler.collect(owner,'real',at,async token=>{assert.notEqual(token,oldToken);await metrics.sample(owner,'UTC',at,token);});
  await db.update(cashAccounts).set({balance:'999'}).where(eq(cashAccounts.owner,owner));
  release();await old;
  const points=await db.select().from(portfolioValuePoints).where(eq(portfolioValuePoints.owner,owner));
  assert.ok(points.length>0);assert.ok(points.every(p=>p.totalValueUsd==='100'),'late worker cannot publish after losing its claim');
  await client.unsafe(readFileSync('scripts/db/67_portfolio_observations.sql','utf8'));
  await client.unsafe(readFileSync('scripts/db/67_portfolio_observations.sql','utf8'));
  assert.deepEqual(await db.select().from(portfolioValuePoints).where(eq(portfolioValuePoints.owner,owner)),points);
}));

test('archive wins an in-flight paper capture, and concurrent account changes produce an unknown fact',async()=>fixture(async db=>{
  const owner=randomUUID();
  const [account]=await db.insert(paperAccounts).values({owner,createdAt:new Date('2026-11-01'),cashBalance:'100',botEnabled:false}).returning();
  await db.insert(paperPositions).values({owner,accountId:account.id,ticker:'ACME',shares:'2',openedAt:new Date('2026-11-01')});
  const market={getSnapshot:async()=>({corporateActionsChecked:true,corporateActions:[]})};
  async function runCapture(at:Date,change:()=>Promise<unknown>){
    let release!:()=>void,entered!:()=>void;
    const wait=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    const metrics=new PortfolioMetricsService(db,{getValuationQuote:async()=>{entered();await wait;return {symbol:'ACME',market:'US',currency:'USD',price:'110',quoteAt:new Date(at.getTime()-60_000).toISOString(),tradingDate:'2026-11-05',source:'fixture'};}} as never);
    const pending=new PortfolioValuationScheduler(db,metrics,market as never).tick(at);
    await started;await change();release();await pending;
  }
  await runCapture(new Date('2026-11-05T16:00:00Z'),()=>db.update(paperAccounts).set({isActive:false}).where(eq(paperAccounts.id,account.id)));
  assert.equal((await db.select().from(paperEquityObservations)).length,0,'archive before commit prevents a late observation');
  await db.update(paperAccounts).set({isActive:true}).where(eq(paperAccounts.id,account.id));
  await runCapture(new Date('2026-11-05T16:05:00Z'),()=>db.update(paperAccounts).set({cashBalance:'200'}).where(eq(paperAccounts.id,account.id)));
  const [point]=await db.select().from(paperEquityObservations);
  assert.equal(point.equityUsd,null);assert.equal(point.complete,false);assert.ok(point.gaps.includes('ACCOUNT_CHANGED_DURING_CAPTURE'));
  assert.equal((await db.select().from(paperAccounts))[0].botEnabled,false);
}));

test('a real holding correction during quote retrieval cannot publish a complete stale inventory valuation',async()=>fixture(async db=>{
  const owner=randomUUID(),at=new Date('2026-11-05T16:00:00Z');
  await db.insert(holdings).values({owner,ticker:'ACME',shares:'2',market:'US',currency:'USD',buyPrice:'100'});
  await db.insert(cashAccounts).values({owner,currency:'USD',balance:'100',reconciliationStatus:'confirmed'});
  let release!:()=>void,entered!:()=>void;
  const wait=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const metrics=new PortfolioMetricsService(db,{getValuationQuote:async()=>{entered();await wait;return {symbol:'ACME',market:'US',currency:'USD',price:'110',quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05',source:'fixture'};}} as never);
  const sampler=new PortfolioValuationScheduler(db,metrics,{} as never),pending=sampler.tick(at);
  await started;
  await db.update(holdings).set({shares:'3'}).where(eq(holdings.owner,owner));release();await pending;
  const [point]=await db.select().from(portfolioValuePoints).where(eq(portfolioValuePoints.owner,owner));
  assert.equal(point.complete,false);assert.equal(point.totalValueUsd,null);assert.ok(point.gaps.includes('ACCOUNT_CHANGED_DURING_CAPTURE'));
  let refreshRelease!:()=>void,refreshEntered!:()=>void;
  const refreshWait=new Promise<void>(resolve=>refreshRelease=resolve),refreshStarted=new Promise<void>(resolve=>refreshEntered=resolve);
  const displayMetrics=new PortfolioMetricsService(db,{getValuationQuote:async()=>{refreshEntered();await refreshWait;return {symbol:'ACME',market:'US',currency:'USD',price:'110',quoteAt:'2026-11-05T16:04:00Z',tradingDate:'2026-11-05',source:'fixture'};}} as never);
  const displayCapture=new PortfolioValuationScheduler(db,displayMetrics,{} as never).tick(new Date('2026-11-05T16:05:00Z'));
  await refreshStarted;
  const [holding]=await db.select().from(holdings).where(eq(holdings.owner,owner));
  const holdingService=new HoldingsService(db,{} as never);
  await holdingService.updatePrices([{ticker:'ACME',price:999}],owner);
  await holdingService.update(holding.id,{company:'Display name'},owner);
  refreshRelease();await displayCapture;
  const [fresh]=await db.select().from(portfolioValuePoints).where(and(eq(portfolioValuePoints.owner,owner),eq(portfolioValuePoints.slot,valuationSlot(new Date('2026-11-05T16:05:00Z')))));
  assert.equal(fresh.complete,true);assert.equal(fresh.totalValueUsd,'430','unrelated display changes do not invalidate trusted quote and quantity facts');
}));

test('unknown native cash and corporate-action uncertainty never establish complete paper equity',async()=>fixture(async db=>{
  const owner=randomUUID(),at=new Date('2026-11-05T16:00:00Z');
  const [cashUnknown,actionsUnknown]=await db.insert(paperAccounts).values([{owner,createdAt:at,ledgerMode:'native_currency'},{owner,createdAt:at,cashBalance:'100'}]).returning();
  await db.insert(paperPositions).values({owner,accountId:actionsUnknown.id,ticker:'ACME',shares:'2',openedAt:new Date('2026-11-01')});
  const metrics=new PortfolioMetricsService(db,{getValuationQuote:async()=>({symbol:'ACME',market:'US',currency:'USD',price:'110',quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05',source:'fixture'})} as never);
  const sampler=new PortfolioValuationScheduler(db,metrics,{getSnapshot:async()=>({corporateActionsChecked:false,corporateActions:[]})} as never);
  await sampler.tick(at);
  const points=await db.select().from(paperEquityObservations);
  assert.ok(points.every(p=>p.equityUsd===null&&!p.complete));
  assert.ok(points.find(p=>p.accountId===cashUnknown.id)!.gaps.includes('CASH_UNCONFIRMED'));
  const action=points.find(p=>p.accountId===actionsUnknown.id)!;
  assert.ok(action.gaps.includes('CORPORATE_ACTION_UNVERIFIED:ACME'));
  assert.equal(action.marketQuotes.length,1,'valid partial market facts stay available for an explicitly partial reference');
}));

test('paper lease expiry while waiting for the owner lock rejects publication and completion',async()=>fixture(async(db,client)=>{
  const owner=randomUUID(),at=new Date('2026-11-05T16:00:00Z');
  const [account]=await db.insert(paperAccounts).values({owner,createdAt:at,cashBalance:'100'}).returning();
  let release!:()=>void,locked!:()=>void,captured!:()=>void;
  const wait=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>locked=resolve),capture=new Promise<void>(resolve=>captured=resolve);
  const blocker=db.transaction(async tx=>{await lockMemoryOwner(tx,owner);locked();await wait;});
  await entered;
  const metrics={captureQuotes:async()=>{
    await client`UPDATE portfolio_valuation_claims SET lease_until=clock_timestamp()+interval '200 milliseconds' WHERE owner=${owner} AND account_key=${account.id}`;
    captured();return [];
  }};
  const pending=new PortfolioValuationScheduler(db,metrics as never,{} as never).tick(at);
  try{await capture;await client`SELECT pg_sleep(0.3)`;}finally{release();}
  await blocker;await pending;
  assert.equal((await db.select().from(paperEquityObservations)).length,0);
  const [claim]=await db.select().from(portfolioValuationClaims).where(eq(portfolioValuationClaims.accountKey,account.id));
  assert.equal(claim.completed,false,'an expired token cannot mark itself completed after lock wait');
}));

test('legacy holding create/update/remove and cash initialization cannot cross the final-check to observation-insert boundary',async()=>fixture(async(db,client)=>{
  const owners=[randomUUID(),randomUUID(),randomUUID(),randomUUID()],at=new Date('2026-11-05T16:00:00Z');
  const positions=await db.insert(holdings).values(owners.map(owner=>({owner,ticker:'ACME',shares:'2',market:'US',currency:'USD',buyPrice:'100'}))).returning();
  await db.insert(cashAccounts).values(owners.map(owner=>({owner,currency:'USD',balance:'100',reconciliationStatus:'confirmed'})));
  const key=Number.parseInt(randomUUID().slice(0,7),16);
  await client.unsafe(`CREATE FUNCTION pause_observation_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}, 67); RETURN NEW; END $$;
    CREATE TRIGGER pause_observation_insert BEFORE INSERT ON portfolio_value_points FOR EACH ROW EXECUTE FUNCTION pause_observation_insert();`);
  let release!:()=>void,locked!:()=>void;
  const wait=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>locked=resolve);
  const blocker=db.transaction(async tx=>{await tx.execute(sql`SELECT pg_advisory_xact_lock(${key},67)`);locked();await wait;});
  await entered;
  const quotes={detectMarket:()=>({market:'US',currency:'USD'}),getValuationQuote:async()=>({symbol:'ACME',market:'US',currency:'USD',price:'110',quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05',source:'fixture'})};
  const metrics=new PortfolioMetricsService(db,quotes as never),sampler=new PortfolioValuationScheduler(db,metrics,{} as never);
  const captures=owners.map(owner=>sampler.collect(owner,'real',at,token=>metrics.sample(owner,'UTC',at,token)));
  let writes:Promise<unknown>[]=[];
  try{
    let waiting=0;
    for(let attempt=0;attempt<200&&waiting<4;attempt++){
      const [row]=await client`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=${key} AND objid=67 AND NOT granted`;
      waiting=row.n;if(waiting<4)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,4,'all observers have passed final validation and are stopped inside their insert');
    const service=new HoldingsService(db,{...quotes,getQuote:quotes.getValuationQuote} as never);
    let finished=0;
    writes=[service.update(positions[0].id,{shares:3},owners[0]),service.remove(positions[1].id,owners[1]),service.create({ticker:'BETA',shares:1},owners[2]),new CashAccountsService(db,{} as never).ensureAccounts(owners[3])].map(work=>work.finally(()=>finished++));
    await client`SELECT pg_sleep(0.1)`;
    assert.equal(finished,0,'each legacy mutation must wait behind the same owner lock');
  }finally{release();await blocker;await Promise.all(captures);await Promise.all(writes);}
  const facts=await db.select().from(portfolioValuePoints);
  assert.equal(facts.length,8);assert.ok(facts.every(point=>point.complete&&point.totalValueUsd==='320'));
  assert.equal((await db.select().from(holdings).where(eq(holdings.owner,owners[0])))[0].shares,'3');
  assert.equal((await db.select().from(holdings).where(eq(holdings.owner,owners[1]))).length,0);
  assert.equal((await db.select().from(holdings).where(eq(holdings.owner,owners[2]))).length,2);
  assert.equal((await db.select().from(cashAccounts).where(eq(cashAccounts.owner,owners[3]))).length,3);
}));

test('display-price refreshes and physical holding order do not invent new financial observations',async()=>fixture(async db=>{
  const owner=randomUUID(),at=new Date('2026-11-05T16:00:00Z');
  const [first]=await db.insert(holdings).values([{owner,ticker:'ACME',shares:'2',market:'US',currency:'USD',buyPrice:'100'},{owner,ticker:'BETA',shares:'3',market:'US',currency:'USD',buyPrice:'100'}]).returning();
  await db.insert(cashAccounts).values({owner,currency:'USD',balance:'100',reconciliationStatus:'confirmed'});
  const quotes={getValuationQuote:async({ticker: symbol}:{ticker: string})=>({symbol,market:'US',currency:'USD',price:'110',quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05',source:'fixture'})};
  const make=()=>new PortfolioValuationScheduler(db,new PortfolioMetricsService(db,quotes as never),{} as never);
  await make().tick(at);
  await db.update(holdings).set({company:'Renamed display',currentPrice:'999',updatedAt:new Date()}).where(eq(holdings.id,first.id));
  await make().tick(new Date('2026-11-05T16:05:00Z'));
  const points=await db.select().from(portfolioValuePoints).where(eq(portfolioValuePoints.owner,owner));
  assert.equal(points.length,2,'source facts are canonical and the display cache is not a financial change');
  assert.ok(points.every(point=>point.totalValueUsd==='650'));
}));

function usMinutePayload(quoteAt: Date) {
  const wall = new Date(quoteAt.getTime() - 5 * 60 * 60_000).toISOString();
  const quote = Array<string>(31).fill('');
  quote[2] = 'ACME.N';
  quote[3] = '110';
  quote[4] = '100';
  quote[30] = wall.slice(0, 19).replace('T', ' ');
  return { code: 0, data: { usACME: {
    qt: { usACME: quote }, pandata: { season: 'EST' },
    data: { date: wall.slice(0, 10).replaceAll('-', ''), data: [wall.slice(11, 16).replace(':', '') + ' 110 100'] },
  } } };
}

for (const [mode, capturedMinutes, providerMinutes, polls] of [
  ['5', [0, 5, 10], [0, 4, 10], 3],
  ['1', [0, 2, 4, 6, 8, 10, 12, 14], [0, 2, 4, 6, 8, 10, 12, 14], 15],
] as const) {
  test(mode + '-minute valuation on a two-minute provider stream counts HTTP requests and saved facts', async t => fixture(async db => {
    const previousMode = process.env.PORTFOLIO_VALUATION_INTERVAL_MINUTES;
    process.env.PORTFOLIO_VALUATION_INTERVAL_MINUTES = mode;
    t.after(() => {
      if (previousMode === undefined) delete process.env.PORTFOLIO_VALUATION_INTERVAL_MINUTES;
      else process.env.PORTFOLIO_VALUATION_INTERVAL_MINUTES = previousMode;
    });
    const start = Date.parse('2026-11-05T16:00:00Z');
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const owner = randomUUID();
    const [account] = await db.insert(paperAccounts).values({ owner, createdAt: new Date(start), cashBalance: '100' }).returning();
    await db.insert(paperPositions).values({ owner, accountId: account.id, ticker: 'ACME', shares: '2' });
    let quoteRequests = 0, actionRequests = 0;
    const http = { get: (url: string) => {
      if (url.includes('usMinute/query')) {
        quoteRequests++;
        const providerAt = new Date(start + Math.floor((Date.now() - start) / 120_000) * 120_000);
        return of({ data: usMinutePayload(providerAt) });
      }
      assert.match(url, /range=6mo/u);
      actionRequests++;
      const meta = { symbol: 'ACME', currency: 'USD', exchangeName: 'NYQ', exchangeTimezoneName: 'America/New_York',
        instrumentType: 'EQUITY', regularMarketPrice: 110, regularMarketTime: Date.now() / 1000 };
      return of({ data: { chart: { result: [{ meta, events: {} }] } } });
    } };
    const sampler = new PortfolioValuationScheduler(db,
      new PortfolioMetricsService(db, new QuoteService(db, http as never)), new TradingMarketService(http as never));
    for (let minute = 0; minute < 15; minute++) {
      const at = start + minute * 60_000;
      t.mock.timers.setTime(at);
      await sampler.tick(new Date(at));
    }
    const observations = await db.select().from(paperEquityObservations).where(eq(paperEquityObservations.accountId, account.id));
    assert.deepEqual(observations.map(row => row.marketQuotes[0]?.quoteAt).sort(),
      providerMinutes.map(minute => new Date(start + minute * 60_000).toISOString()));
    assert.equal(observations.filter(row => row.complete).length, providerMinutes.length);
    assert.equal(quoteRequests, polls);
    assert.equal(actionRequests, 3);
    assert.deepEqual(observations.map(row => row.slot).sort(), capturedMinutes.map(minute => {
      const at = new Date(start + minute * 60_000);
      return minute % 5 === 0 ? valuationSlot(at) : minuteValuationSlot(at);
    }).sort());
    const comparison = new PortfolioComparisonService(db);
    for (const period of ['1D', '1W']) {
      const view = await comparison.read(owner, period, account.id, new Date(start + 15 * 60_000));
      assert.deepEqual(view.series[0].points.map(point => point.timestamp),
        capturedMinutes.map(minute => new Date(start + minute * 60_000).toISOString()));
    }
  }));
}

test('CN/HK/US portfolios use held exchange sessions and retain closing marks after collector restart', async () => fixture(async db => {
  const owner = randomUUID(), createdAt = new Date('2026-11-01T00:00:00Z');
  const assets = [{ ticker: '600519.SH', market: 'CN', currency: 'CNY' },
    { ticker: '700', market: 'HK', currency: 'HKD' }, { ticker: 'ACME', market: 'US', currency: 'USD' }];
  const [account] = await db.insert(paperAccounts).values({ owner, createdAt, cashBalance: '100', botEnabled: false }).returning();
  await db.insert(paperPositions).values(assets.map(asset => ({ ...asset, owner, accountId: account.id, shares: '2', openedAt: createdAt })));
  await db.insert(holdings).values(assets.map(asset => ({ ...asset, owner, shares: '2' })));
  await db.insert(cashAccounts).values(assets.map(asset => ({ owner, currency: asset.currency, balance: '0', reconciliationStatus: 'confirmed' })));
  await db.insert(fxRates).values([{ base: 'CNY', quote: 'USD', rate: '0.14', rateDate: '2026-11-04' },
    { base: 'HKD', quote: 'USD', rate: '0.125', rateDate: '2026-11-04' }]);

  const sourceRequests: string[] = [];
  const quote = { getValuationQuote: async (identity: TradingTicker, at: Date) => {
    const clock = at.toISOString().slice(11, 16);
    sourceRequests.push(clock + ':' + identity.market);
    const quoteAt = identity.market === 'US' && clock < '14:30' ? '2026-11-04T21:00:00.000Z' : at.toISOString();
    return { symbol: identity.ticker, market: identity.market, currency: identity.currency, price: '110', previousClose: '100',
      quoteAt, tradingDate: quoteAt.slice(0, 10), source: 'fixture' };
  } };
  const market = { getSnapshot: async () => ({ corporateActionsChecked: true, corporateActions: [] }) };
  const make = () => new PortfolioValuationScheduler(db, new PortfolioMetricsService(db, quote as never), market as never);
  const time = (clock: string) => new Date('2026-11-05T' + clock + ':00Z');
  const sampler = make();
  for (const clock of ['03:25', '03:29', '03:56', '04:01', '06:56', '06:57', '07:00', '08:00']) {
    await sampler.tick(time(clock));
  }
  await make().tick(time('14:31'));

  assert.deepEqual(sourceRequests.sort(), [
    '03:25:CN', '03:25:HK', '03:25:US', '03:29:CN', '03:29:HK', '03:56:HK',
    '06:56:CN', '06:56:HK', '06:57:HK', '07:00:CN', '07:00:HK', '08:00:HK', '14:31:US',
  ]);
  const paper = await db.select().from(paperEquityObservations).where(eq(paperEquityObservations.accountId, account.id))
    .orderBy(asc(paperEquityObservations.capturedAt));
  assert.ok(paper.every(point => point.complete));
  const afterRestart = { CN: time('07:00').toISOString(), HK: time('08:00').toISOString(), US: time('14:31').toISOString() };
  const latestPaper = paper.at(-1)!;
  assert.equal(latestPaper.slot, minuteValuationSlot(time('14:31')));
  assert.deepEqual(Object.fromEntries(latestPaper.marketQuotes.map(quote => [quote.market, quote.quoteAt])), afterRestart);
  const real = await db.select().from(portfolioValuePoints).where(and(eq(portfolioValuePoints.owner, owner),
    eq(portfolioValuePoints.slot, minuteValuationSlot(time('14:31')))));
  assert.equal(real[0].complete, true);
  assert.deepEqual(Object.fromEntries(real[0].marketQuotes.map(quote => [quote.market, quote.quoteAt])), afterRestart);
}));

test('a provider 429 persists one unknown and cooldown across instances before five-minute recovery', async () => fixture(async db => {
  const owner = randomUUID();
  await db.insert(holdings).values({ owner, ticker: 'ACME', shares: '2', market: 'US', currency: 'USD' });
  await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '100', reconciliationStatus: 'confirmed' });
  const requests: number[] = [];
  const start = Date.parse('2026-11-05T16:00:00Z');
  for (const minute of [0, 1, 1.5, 2, 5, 9, 10, 11, 14, 15, 16]) {
    const at = new Date(start + minute * 60_000);
    const http = { get: (url: string) => {
      assert.match(url, /usMinute\/query/u, 'throttling cannot fan out to a second source');
      requests.push(minute);
      if (minute === 1) return throwError(() => ({ isAxiosError: true, response: { status: 429, headers: { 'retry-after': '420' } } }));
      return of({ data: usMinutePayload(at) });
    } };
    const sampler = new PortfolioValuationScheduler(db, new PortfolioMetricsService(db, new QuoteService(db, http as never)), {} as never);
    await sampler.tick(at);
  }
  assert.deepEqual(requests, [0, 1, 10, 15, 16]);
  const points = await db.select().from(portfolioValuePoints).where(and(eq(portfolioValuePoints.owner, owner),
    ne(portfolioValuePoints.slot, 'origin'))).orderBy(asc(portfolioValuePoints.capturedAt));
  assert.deepEqual(points.map(row => [(row.capturedAt.getTime() - start) / 60_000, row.totalValueUsd]), [
    [0, '320'], [1, null], [10, '320'], [15, '320'], [16, '320'],
  ]);
  assert.deepEqual(points[1].marketQuotes, []);
  assert.equal(points[2].slot, valuationSlot(new Date(start + 10 * 60_000)));
}));

test('a broad book falls back to five-minute slots without starving any of its positions', async () => fixture(async db => {
  const owner = randomUUID(), start = Date.parse('2026-11-05T16:00:00Z');
  const tickers = Array.from({ length: MAX_MINUTE_VALUATION_SYMBOLS + 1 }, (_, i) => 'ZZ' + String.fromCharCode(65 + i));
  await db.insert(holdings).values(tickers.map(ticker => ({ owner, ticker, shares: '2', market: 'US', currency: 'USD' })));
  await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '100', reconciliationStatus: 'confirmed' });
  let requests = 0;
  const quotes = { getValuationQuote: async (identity: TradingTicker, at: Date) => {
    requests++;
    return { symbol: identity.ticker, market: 'US', currency: 'USD', price: '100', previousClose: '100',
      quoteAt: at.toISOString(), tradingDate: '2026-11-05', source: 'fixture' };
  } };
  const sampler = new PortfolioValuationScheduler(db, new PortfolioMetricsService(db, quotes as never), {} as never);
  for (const minute of [0, 1, 4, 5]) await sampler.tick(new Date(start + minute * 60_000));
  assert.equal(requests, tickers.length * 2);
  const points = await db.select().from(portfolioValuePoints).where(and(eq(portfolioValuePoints.owner, owner),
    ne(portfolioValuePoints.slot, 'origin'))).orderBy(asc(portfolioValuePoints.capturedAt));
  assert.deepEqual(points.map(row => row.slot), [0, 5].map(minute => valuationSlot(new Date(start + minute * 60_000))));
  assert.ok(points.every(row => row.complete && row.marketQuotes.length === tickers.length));
}));

test('another instance cannot start source work for a later slot while a collection is in flight', async () => fixture(async db => {
  const owner = randomUUID(), first = new Date('2026-11-05T16:00:00Z'), next = new Date('2026-11-05T16:01:00Z');
  await db.insert(holdings).values({ owner, ticker: 'ACME', shares: '2', market: 'US', currency: 'USD' });
  await db.insert(cashAccounts).values({ owner, currency: 'USD', balance: '100', reconciliationStatus: 'confirmed' });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const calls: Date[] = [];
  const source = { getValuationQuote: async (_ticker: TradingTicker, at: Date) => {
    calls.push(at);
    if (at === first) {
      entered();
      await barrier;
    }
    return { symbol: 'ACME', market: 'US', currency: 'USD', price: '110', previousClose: '100',
      quoteAt: at.toISOString(), tradingDate: '2026-11-05', source: 'fixture' };
  } };
  const make = () => new PortfolioValuationScheduler(db, new PortfolioMetricsService(db, source as never), {} as never);
  const firstTick = make().tick(first);
  await started;
  try {
    await make().tick(next);
    assert.deepEqual(calls, [first]);
  } finally {
    release();
    await firstTick;
  }
  await make().tick(next);
  assert.deepEqual(calls, [first, next]);
  const saved = await db.select().from(portfolioValuePoints).where(eq(portfolioValuePoints.owner, owner));
  assert.ok(saved.some(row => row.slot === minuteValuationSlot(next) && row.complete));
}));
