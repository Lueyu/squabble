import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import { cashAccounts, holdings, paperAccounts, paperPositions, paperSnapshots } from '../../database/schema';
import { paperEquityObservations, portfolioValuationClaims } from '../../database/portfolio-observations.schema';
import { portfolioValuePoints } from '../../database/portfolio-value-points.schema';
import { PortfolioMetricsService } from './portfolio-metrics.service';
import { PortfolioValuationScheduler } from './portfolio-valuation.scheduler';
import { PortfolioComparisonService } from '../paper-trading/portfolio-comparison.service';
import { valuationSlot } from './portfolio-sampling.rules';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { HoldingsService } from '../holdings/holdings.service';
import { CashAccountsService } from '../cash-accounts/cash-accounts.service';

async function fixture(run:(db:ReturnType<typeof drizzle>,client:ReturnType<typeof postgres>)=>Promise<void>){
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
  const [paused,archived,foreign]=await db.insert(paperAccounts).values([{owner,botEnabled:false,cashBalance:'100'},{owner,isActive:false},{owner:other,cashBalance:'888'}]).returning();
  await db.insert(paperPositions).values({owner,accountId:paused.id,ticker:'ACME',market:'US',currency:'USD',shares:'2',avgCost:'100',openedAt:new Date('2026-11-01')});
  let quoteAt='2026-11-05T15:59:00Z',calls=0;
  const quote={getQuote:async()=>{calls++;return {symbol:'ACME',market:'US',currency:'USD',price:'110',previousClose:'100',quoteAt,tradingDate:'2026-11-05',source:'fixture'};}};
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
  assert.ok(calls<=2,'durable claims prevent duplicate source work in the same slot across workers');
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
  const [account]=await db.insert(paperAccounts).values({owner,cashBalance:'100',botEnabled:false}).returning();
  await db.insert(paperPositions).values({owner,accountId:account.id,ticker:'ACME',shares:'2',openedAt:new Date('2026-11-01')});
  const market={getSnapshot:async()=>({corporateActionsChecked:true,corporateActions:[]})};
  async function runCapture(at:Date,change:()=>Promise<unknown>){
    let release!:()=>void,entered!:()=>void;
    const wait=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    const metrics=new PortfolioMetricsService(db,{getQuote:async()=>{entered();await wait;return {symbol:'ACME',market:'US',currency:'USD',price:'110',quoteAt:new Date(at.getTime()-60_000).toISOString(),tradingDate:'2026-11-05',source:'fixture'};}} as never);
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
  const metrics=new PortfolioMetricsService(db,{getQuote:async()=>{entered();await wait;return {symbol:'ACME',market:'US',currency:'USD',price:'110',quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05',source:'fixture'};}} as never);
  const sampler=new PortfolioValuationScheduler(db,metrics,{} as never),pending=sampler.tick(at);
  await started;
  await db.update(holdings).set({shares:'3'}).where(eq(holdings.owner,owner));release();await pending;
  const [point]=await db.select().from(portfolioValuePoints).where(eq(portfolioValuePoints.owner,owner));
  assert.equal(point.complete,false);assert.equal(point.totalValueUsd,null);assert.ok(point.gaps.includes('ACCOUNT_CHANGED_DURING_CAPTURE'));
  let refreshRelease!:()=>void,refreshEntered!:()=>void;
  const refreshWait=new Promise<void>(resolve=>refreshRelease=resolve),refreshStarted=new Promise<void>(resolve=>refreshEntered=resolve);
  const displayMetrics=new PortfolioMetricsService(db,{getQuote:async()=>{refreshEntered();await refreshWait;return {symbol:'ACME',market:'US',currency:'USD',price:'110',quoteAt:'2026-11-05T16:04:00Z',tradingDate:'2026-11-05',source:'fixture'};}} as never);
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
  const [cashUnknown,actionsUnknown]=await db.insert(paperAccounts).values([{owner,ledgerMode:'native_currency'},{owner,cashBalance:'100'}]).returning();
  await db.insert(paperPositions).values({owner,accountId:actionsUnknown.id,ticker:'ACME',shares:'2',openedAt:new Date('2026-11-01')});
  const metrics=new PortfolioMetricsService(db,{getQuote:async()=>({symbol:'ACME',market:'US',currency:'USD',price:'110',quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05',source:'fixture'})} as never);
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
  const [account]=await db.insert(paperAccounts).values({owner,cashBalance:'100'}).returning();
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
  const [claim]=await db.select().from(portfolioValuationClaims);
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
  const quotes={detectMarket:()=>({market:'US',currency:'USD'}),getQuote:async()=>({symbol:'ACME',market:'US',currency:'USD',price:'110',quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05',source:'fixture'})};
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
    const service=new HoldingsService(db,quotes as never);
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
  const quotes={getQuote:async(symbol:string)=>({symbol,market:'US',currency:'USD',price:'110',quoteAt:'2026-11-05T15:59:00Z',tradingDate:'2026-11-05',source:'fixture'})};
  const make=()=>new PortfolioValuationScheduler(db,new PortfolioMetricsService(db,quotes as never),{} as never);
  await make().tick(at);
  await db.update(holdings).set({company:'Renamed display',currentPrice:'999',updatedAt:new Date()}).where(eq(holdings.id,first.id));
  await make().tick(new Date('2026-11-05T16:05:00Z'));
  const points=await db.select().from(portfolioValuePoints).where(eq(portfolioValuePoints.owner,owner));
  assert.equal(points.length,2,'source facts are canonical and the display cache is not a financial change');
  assert.ok(points.every(point=>point.totalValueUsd==='650'));
}));
