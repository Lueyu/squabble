import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { cashAccounts,holdings,transactions } from '../../database/schema';
import { PortfolioMetricsService } from './portfolio-metrics.service';
import { ImportService } from '../import/import.service';
import { TransactionsService } from '../transactions/transactions.service';
import { businessDate } from './simple-experience.rules';
import { lastCompletedTradingDate, tradingMarketSchedule } from '../paper-trading/trading-market.calendar';
const url=process.env.EXPERIENCE_TEST_DATABASE_URL??process.env.RESEARCH_TEST_DATABASE_URL;

test('observed equity keeps a first boundary, rejects foreign history and separates later external funding',{skip:!url},async()=>{
  const namespace='metrics_'+randomUUID().replaceAll('-',''),admin=postgres(url!,{max:1,onnotice:()=>{}});
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  const client=postgres(url!,{max:4,onnotice:()=>{},connection:{search_path:namespace}});
  try{
    for(const f of readdirSync('scripts/db').filter(f=>/^\d\d_.*\.sql$/u.test(f)&&!f.startsWith('02_')).sort())await client.unsafe(readFileSync('scripts/db/'+f,'utf8'));
    const db=drizzle(client),owner=randomUUID();
    await db.insert(holdings).values({owner,ticker:'ACME',shares:'10',buyPrice:'100',currentPrice:'110',currency:'USD',market:'US'});
    await db.insert(cashAccounts).values({owner,currency:'USD',balance:'500',reconciliationStatus:'confirmed'});
    const quotes={getQuote:async()=>({symbol:'ACME',price:'110',previousClose:'100',currency:'USD',market:'US',quoteAt:'2026-11-05T21:00:00Z',tradingDate:'2026-11-05',source:'fixture'})};
    const service=new PortfolioMetricsService(db,quotes as never);
    const first=await service.read(owner,'Asia/Shanghai',new Date('2026-11-06T04:00:00Z'));
    assert.equal(first.metrics.totalValueUsd,1600);
    assert.ok(first.provenance,'quote observation and retrieval dates must remain separately inspectable');
    assert.equal(first.provenance.quotes[0].previousCloseDate,'2026-11-04');
    assert.equal(first.provenance.quotes[0].quoteAt,'2026-11-05T21:00:00Z');
    assert.ok(first.provenance.quotes[0].retrievedAt);
    assert.ok(first.trend.points.length>=1,'a trustworthy first observed valuation must be kept');
    assert.equal(first.trend.assetChangeUsd,0);
    const undatedService=new PortfolioMetricsService(db,{getQuote:async()=>({symbol:'ACME',price:'110',previousClose:'100',currency:'USD',market:'US'})} as never);
    const undated=await undatedService.read(owner,'Asia/Shanghai',new Date('2026-11-06T04:15:00Z'));
    assert.equal(undated.trend.investmentPnlUsd,null,'an undated estimate cannot become complete interval performance');
    assert.ok(undated.trend.gaps.includes('CURRENT_VALUATION_UNVERIFIED'));
    await db.update(cashAccounts).set({balance:'1500'}).where(eq(cashAccounts.owner,owner));
    await db.insert(transactions).values({owner,ticker:'',txType:'Deposit',txDate:'2026-11-06',shares:'1000',price:'1',fees:'0'});
    const funded=await service.read(owner,'Asia/Shanghai',new Date('2026-11-06T05:00:00Z'));
    assert.equal(funded.trend.assetChangeUsd,1000);
    assert.equal(funded.trend.netExternalFlowUsd,1000);
    assert.equal(funded.trend.investmentPnlUsd,0);
    assert.ok(funded.trend.points.some(p=>p.capturedAt==='2026-11-06T04:00:00.000Z'),'later reads preserve the initial boundary');
    await db.update(cashAccounts).set({balance:'1525',confirmedAt:new Date('2026-11-06T05:30:00Z')}).where(eq(cashAccounts.owner,owner));
    const reconciled=await service.read(owner,'Asia/Shanghai',new Date('2026-11-06T06:00:00Z'));
    assert.equal(reconciled.trend.investmentPnlUsd,null,'explicit cash corrections cannot manufacture investment profit');
    assert.ok(reconciled.trend.gaps.includes('CASH_BASELINE_CHANGED'));
    const outsider=await service.read(randomUUID(),'Asia/Shanghai',new Date('2026-11-06T05:00:00Z'));
    assert.equal(outsider.trend.points.length,0);
  }finally{await client.end();await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;await admin.end();}
});

test('position snapshot corrections and opening adjustments are not investment returns',{skip:!url},async t=>{
  // Imported checkpoints and the dated ledger fixture must share the same business day.
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-06T04:00:00Z')});
  const namespace='metrics_positions_'+randomUUID().replaceAll('-',''),admin=postgres(url!,{max:1,onnotice:()=>{}});
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  const client=postgres(url!,{max:4,onnotice:()=>{},connection:{search_path:namespace}});
  try{
    for(const f of readdirSync('scripts/db').filter(f=>/^\d\d_.*\.sql$/u.test(f)&&!f.startsWith('02_')).sort())await client.unsafe(readFileSync('scripts/db/'+f,'utf8'));
    const day=businessDate(new Date(),'Asia/Shanghai'),originAt=new Date(`${day}T04:00:00Z`),laterAt=new Date(`${day}T05:00:00Z`);
    const quoteDay=lastCompletedTradingDate('US',originAt);assert.ok(quoteDay);
    const quoteAt=tradingMarketSchedule('US',new Date(`${quoteDay}T12:00:00Z`)).closesAt;assert.ok(quoteAt);
    const db=drizzle(client),quotes={detectMarket:()=>({market:'US',currency:'USD'}),getQuote:async()=>({symbol:'ACME',price:'110',previousClose:'100',currency:'USD',market:'US',quoteAt,tradingDate:quoteDay,source:'fixture'})};
    const service=new PortfolioMetricsService(db,quotes as never),importer=new ImportService(db,quotes as never),ledger=new TransactionsService(db,quotes as never);
    for(const adjustment of ['snapshot','opening','same-snapshot']){
      const owner=randomUUID();
      await importer.commit(owner,{source:'csv',rows:[{ticker:'ACME',shares:10,avgCost:100,currency:'USD'}]});
      await db.update(holdings).set({currentPrice:'110'}).where(eq(holdings.owner,owner));
      await db.insert(cashAccounts).values({owner,currency:'USD',balance:'500',reconciliationStatus:'confirmed'});
      const origin=await service.read(owner,'Asia/Shanghai',originAt);
      assert.equal(origin.trend.investmentPnlUsd,0);
      if(adjustment==='opening')await ledger.create(owner,{ticker:'ACME',txType:'Opening',txDate:day,shares:2,price:100,currency:'USD'});
      else await importer.commit(owner,{source:'csv',rows:[{ticker:'ACME',shares:adjustment==='snapshot'?12:10,avgCost:100,currency:'USD'}]});
      const later=await service.read(owner,'Asia/Shanghai',laterAt);
      assert.equal(later.trend.assetChangeUsd,adjustment==='same-snapshot'?0:220);
      assert.equal(later.trend.investmentPnlUsd,adjustment==='same-snapshot'?0:null,'noncash balance corrections cannot manufacture investment profit');
      assert.equal(later.trend.gaps.includes('POSITION_BASELINE_CHANGED'),adjustment!=='same-snapshot');
    }
  }finally{t.mock.timers.reset();await client.end();await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;await admin.end();}
});
