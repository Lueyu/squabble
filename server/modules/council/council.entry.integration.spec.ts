import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { SimpleCouncilService } from './simple-council.service';
import { CouncilService } from './council.service';
import { holdings, paperAccounts, paperOrders } from '../../database/schema';
import { councilSessions } from '../../database/council.schema';
import { eq } from 'drizzle-orm';
import { experiencePreferences } from '../../database/simple-experience.schema';

const url = process.env.COUNCIL_TEST_DATABASE_URL;
test('restart recovers only unpaid initializing receipts once and closes disabled or stopped receipts',async()=>{
  assert.ok(url,'Temporary database required');
  const namespace=`receipt_restart_${randomUUID().replaceAll('-','')}`,admin=postgres(url!,{max:1,onnotice:()=>{}}),client=postgres(url!,{max:6,onnotice:()=>{},connection:{search_path:namespace}});
  try{
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    for(const file of readdirSync('scripts/db').filter(name=>/^\d+.*\.sql$/u.test(name)&&!name.startsWith('02_')).sort())await client.unsafe(readFileSync(`scripts/db/${file}`,'utf8'));
    const owner=randomUUID();await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},'restart-receipt','fixture')`;
    const db=drizzle(client),llm={validateConnectionIds:async()=>{},isConfigured:async()=>false};
    const council=new CouncilService(db,llm as never,{} as never,{} as never,{} as never);
    const lost=new SimpleCouncilService(db,council,llm as never);
    lost.resolveMembers=()=>new Promise(()=>{});
    const pending=await lost.create(owner,{message:'Question survives process loss',requestKey:'unpaid-receipt'});
    assert.ok('id' in pending&&pending.initializing);if(!('id' in pending))throw Error('Unexpected clarification');
    let resolutions=0,starts=0;
    const restarted=new SimpleCouncilService(db,{getSession:council.getSession.bind(council),runSession:async()=>{starts++;}} as never,llm as never);
    restarted.resolveMembers=async()=>{resolutions++;return{members:[{id:'fixture',name:'Fixture',role:'researcher',model:'fast',instructions:''}],executors:[{memberId:'fixture',identity:'fixture:only',connection:'fixture',provider:'fixture',model:'fixture'}]};};
    await restarted.onApplicationBootstrap();await restarted.onApplicationBootstrap();
    const restored=await restarted.get(owner,pending.id);assert.equal(restored.initializing,false);assert.equal(restored.members?.length,1);assert.equal(resolutions,1);assert.equal(starts,1);
    const disabled=await lost.create(owner,{message:'Disabled after receipt',requestKey:'disabled-receipt'});if(!('id' in disabled))throw Error('Unexpected clarification');
    await db.insert(experiencePreferences).values({owner,enabled:false});
    await restarted.onApplicationBootstrap();
    const paused=await restarted.get(owner,disabled.id);assert.equal(paused.initializing,false);assert.equal(paused.status,'paused');assert.match(paused.error??'',/暂停|paused/iu);assert.equal(resolutions,1);assert.equal(starts,1);
    await db.update(experiencePreferences).set({enabled:true}).where(eq(experiencePreferences.owner,owner));
    const stopped=await lost.create(owner,{message:'Stopped after receipt',requestKey:'stopped-receipt'});if(!('id' in stopped))throw Error('Unexpected clarification');
    await db.update(councilSessions).set({status:'paused',revision:2}).where(eq(councilSessions.id,stopped.id));
    await restarted.onApplicationBootstrap();
    const fenced=await restarted.get(owner,stopped.id);assert.equal(fenced.initializing,false);assert.equal(fenced.status,'paused');assert.equal(resolutions,1);assert.equal(starts,1);
  }finally{await client.end();await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`;await admin.end();}
});
test('zero-form general discussion is owner scoped, idempotent, and persists without inventing an AI response', { skip: !url }, async () => {
  const namespace = `simple_entry_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  const client = postgres(url!, { max: 8, onnotice: () => {}, connection: { search_path: namespace } });
  try {
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    for (const file of readdirSync('scripts/db').filter(name => /^\d+.*\.sql$/u.test(name) && !name.startsWith('02_') && Number(name.slice(0, 2)) <= 34).sort()) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    const owner = randomUUID();
    const db = drizzle(client);
    await client`INSERT INTO users (id,username,password_hash) VALUES (${owner},'simple-entry','fixture')`;
    const llm = { validateConnectionIds: async () => {}, isConfigured: async () => false };
    const council = new CouncilService(db, llm as never, {} as never, {} as never, {} as never);
    const service = new SimpleCouncilService(db, council, llm as never);
    const slow=new SimpleCouncilService(db,council,llm as never);
    let finishDetection!:()=>void;const detection=new Promise<void>(resolve=>{finishDetection=resolve;});
    slow.resolveMembers=async()=>{await detection;return{members:[],executors:[]};};
    const receiptRequest=slow.create(owner,{message:'Cold detection receipt fixture',requestKey:'cold-receipt'});
    const receipt=await Promise.race([receiptRequest.then(value=>({value})),new Promise<{timeout:true}>(resolve=>setTimeout(()=>resolve({timeout:true}),1000))]);
    finishDetection();await receiptRequest;
    assert.equal('timeout' in receipt,false,'cold CLI probes must not delay the durable receipt');
    if('value' in receipt&&'id' in receipt.value)assert.equal(receipt.value.initializing,true);
    await client`DELETE FROM council_sessions WHERE owner=${owner}`;
    const input = { message: 'How should an investor think about uncertainty?', requestKey: 'first' };
    const results = await Promise.all([service.create(owner, input), service.create(owner, input)]);
    assert.ok(results.every(result => 'id' in result));
    const first = results[0];
    if (!('id' in first)) throw new Error('Unexpected clarification');
    assert.equal(results[1] && 'id' in results[1] ? results[1].id : null, first.id);
    assert.equal(first.mode, 'unavailable');
    assert.equal(first.ticker, 'PORTFOLIO');
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].content, input.message);
    assert.equal((await client`SELECT count(*)::int AS count FROM council_sessions`)[0].count, 1);
    await assert.rejects(service.create(owner, { ...input, message: 'Different payload' }), /REQUEST_KEY_CONFLICT/u);
    await assert.rejects(service.get(randomUUID(), first.id), /not found/u);
    await assert.rejects(service.create(owner, { ...input, requestKey: 'foreign', context: { kind: 'report', documentId: randomUUID() } }), /unavailable|not found|NOT_FOUND/u);
    const followup = { message: 'Do not buy ACME.', requestKey: 'followup' };
    await Promise.all([service.addMessage(owner, first.id, followup), service.addMessage(owner, first.id, followup)]);
    assert.equal((await service.get(owner, first.id)).messages.length, 2);
    await assert.rejects(service.addMessage(owner, first.id, { ...followup, message: 'Other instruction' }), /REQUEST_KEY_CONFLICT/u);
    await service.rename(owner, first.id, { title: 'Uncertainty', requestKey: 'rename' });
    assert.equal((await service.get(owner, first.id)).title, 'Uncertainty');
    await client`INSERT INTO model_connections(owner,name,base_url,fast_model,slow_model,api_key_enc) VALUES
      (${owner},'Duplicate API','https://provider.example/v1','same-model','same-model','fixture')`;
    const sameProvider = new SimpleCouncilService(db, council, llm as never, undefined, {
      getDefaultModelRoute: async () => ({ mode: 'api' }),
      getLlmConfig: async () => ({ baseUrl: 'https://provider.example/v1', fastModel: 'same-model', apiKey: 'fixture' }),
    } as never);
    const resolved = await sameProvider.resolveMembers(owner);
    assert.equal(resolved.executors.length, 1, 'two connection labels cannot manufacture two independent sources');
    assert.equal(resolved.executors[0].identityVerified, true);
    const native = new SimpleCouncilService(db, council, llm as never, { status: async () => ({ items: [
      { id: 'native-codex', provider: 'codex', name: 'Codex', available: true, connected: true, busy: false },
      { id: 'native-opencode', provider: 'opencode', name: 'OpenCode', available: true, connected: true, busy: false },
    ] }) } as never);
    const nativeSources = await native.resolveMembers(owner);
    assert.equal(nativeSources.executors[0].identityVerified, true, 'a connected fixed-provider native execution origin is a real source');
    assert.equal(nativeSources.executors[0].modelVerified, false, 'verifying execution origin never invents the unreported model');
    assert.equal(nativeSources.executors[1].identityVerified, false, 'a configurable model aggregator needs actual provider identification');
    await db.insert(holdings).values([{ owner, ticker: 'ACME', company: 'Example Company', shares: '1' },
      { owner, ticker: '1234.HK', company: 'Example Company', shares: '1' }]);
    const portfolioQuestion=await service.create(owner,{message:'我的持仓里最值得担心的是什么？',requestKey:'own-portfolio-context'});
    assert.ok('id' in portfolioQuestion);
    if('id' in portfolioQuestion){
      const [portfolioSession]=await db.select().from(councilSessions).where(eq(councilSessions.id,portfolioQuestion.id));
      assert.match(JSON.stringify(portfolioSession.evidenceSnapshot),/ACME/,'a clear own-portfolio question carries actual owned holdings');
      assert.match(JSON.stringify(portfolioSession.evidenceSnapshot),/1234.HK/);
    }
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
    const datedPortfolio=await service.create(owner,{message:'今天持仓有什么风险？',context:{kind:'portfolio',date:today},requestKey:'dated-portfolio-context'});
    if(!('id' in datedPortfolio))throw new Error('Unexpected portfolio clarification');
    const [datedSession]=await db.select().from(councilSessions).where(eq(councilSessions.id,datedPortfolio.id));
    assert.match(JSON.stringify(datedSession.evidenceSnapshot),/ACME/,'today header carries actual current holdings even before a daily report exists');
    assert.equal(datedSession.checkpoint?.simple?.contextDate,today);
    const ambiguous = await service.create(owner, { message: 'Example Company 有什么风险？', requestKey: 'ambiguous-company' });
    assert.ok('needsInput' in ambiguous);
    if ('needsInput' in ambiguous) assert.equal(ambiguous.needsInput.options.length, 2);
    const [account] = await db.insert(paperAccounts).values({ owner }).returning();
    const [order] = await db.insert(paperOrders).values({ owner, accountId: account.id, ticker: 'ACME', side: 'buy', quantity: '1',
      status: 'filled', reason: 'HISTORICAL_IMMUTABLE_REASON', filledPrice: '10' }).returning();
    const decision = await service.create(owner, { message: 'Why did this happen?', requestKey: 'decision-context', context: { kind: 'decision', orderId: order.id } });
    assert.ok('id' in decision);
    if ('id' in decision) {
      const [stored] = await db.select().from(councilSessions).where(eq(councilSessions.id, decision.id));
      assert.equal(JSON.stringify(stored.evidenceSnapshot).includes('HISTORICAL_IMMUTABLE_REASON'), true);
      assert.deepEqual(stored.references, [], 'missing historical evidence must not be replaced with a current report');
      assert.equal(stored.candidate, null, 'asking about a decision grants no execution capability');
    }
    const availableModel = { validateConnectionIds: async () => {}, isConfigured: async () => true,
      getExecutionInfo: async () => ({ provider: 'fixture', modelFast: 'fixture' }),
      chatFastJSON: async () => ({ data: { content: 'Real connected analysis', evidenceIds: [] }, tokens: 1 }) };
    const availableCouncil = new CouncilService(db, availableModel as never, {} as never, {} as never, {} as never);
    const available = new SimpleCouncilService(db, availableCouncil, availableModel as never);
    const resumed = await available.addMessage(owner, first.id, { message: 'Now the AI is connected, please continue.', requestKey: 'connected' });
    assert.equal(resumed.mode, 'single', 'a previously unavailable conversation can acquire a real connected source');
    for (let i = 0; i < 200; i++) {
      if ((await available.get(owner, first.id)).status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { await client.end(); await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`; await admin.end(); }
});
