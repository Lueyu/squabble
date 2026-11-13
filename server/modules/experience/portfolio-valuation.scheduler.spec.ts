import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioValuationScheduler } from './portfolio-valuation.scheduler';

test('the global paper switch disables even manually invoked valuation ticks',async()=>{
  const previous=process.env.PAPER_TRADING_ENABLED;
  process.env.PAPER_TRADING_ENABLED='false';
  try{
    const db={select(){throw new Error('must not read accounts or dispatch sources');}};
    const service=new PortfolioValuationScheduler(db as never,{} as never,{} as never);
    await service.tick();
    service.onModuleInit();service.onModuleDestroy();
  }finally{if(previous===undefined)delete process.env.PAPER_TRADING_ENABLED;else process.env.PAPER_TRADING_ENABLED=previous;}
});

test('a running valuation tick cannot overlap itself',async()=>{
  const previous=process.env.PAPER_TRADING_ENABLED;delete process.env.PAPER_TRADING_ENABLED;
  let release!:()=>void,reads=0;
  const barrier=new Promise<void>(resolve=>release=resolve);
  const db={select(){reads++;return {from:()=>({then:(resolve:(rows:unknown[])=>void)=>barrier.then(()=>resolve([])),where:async()=>[]})};}};
  const service=new PortfolioValuationScheduler(db as never,{} as never,{} as never);
  try{
    const first=service.tick();
    await service.tick();
    assert.equal(reads,1);
    release();
    await first;
  }finally{if(previous!==undefined)process.env.PAPER_TRADING_ENABLED=previous;}
});
