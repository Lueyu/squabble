import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {eq} from 'drizzle-orm';
import {CouncilService} from './council.service';
import {parseContribution} from './council.dialogue';
import type {CouncilEvidence} from './council.rules';
import {councilMessages,councilSessions} from '../../database/council.schema';
import {ResearchDocumentsService} from '../research-documents/research-documents.service';
import {UserInvestmentStrategyService} from '../paper-trading/user-investment-strategy.service';
import {ChannelService} from '../channel/channel.service';
import {DailyChannelResearchService} from '../experience/daily-channel-research.service';
import {businessDate} from '../experience/simple-experience.rules';
import {strategyContentHash} from '../paper-trading/user-investment-strategy.rules';
import {waitForSavedAvailability} from './council-test.fixture';

const url=process.env.COUNCIL_TEST_DATABASE_URL;
test('daily generation publishes and hands off an executable immutable proposal without another extraction call',{skip:!url},async()=>{
 const namespace=`report_plan_${randomUUID().replaceAll('-','')}`;
 const admin=postgres(url!,{max:1,onnotice:()=>{}}),client=postgres(url!,{max:6,onnotice:()=>{},connection:{search_path:namespace}});
 await admin`CREATE SCHEMA ${admin(namespace)}`;
 try{
  for(const file of readdirSync('scripts/db').filter(n=>/^\d\d_.*\.sql$/u.test(n)&&!n.startsWith('02_')).sort())await client.unsafe(readFileSync(`scripts/db/${file}`,'utf8'));
  const owner=randomUUID();await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},${'plan-'+owner.slice(0,12)},'fixture-only')`;
  const db=drizzle(client),documents=new ResearchDocumentsService(db);let evidenceId='',calls=0,extractions=0;
  const now=new Date(),text='AI proposal: Sell FICT 1 share when price reaches 110 USD. Risk: the condition may not be reached.';
  const proposal={schemaVersion:1,parameterOrigin:'ai_proposed',strategy:{title:'Fictional conditional reduction',body:'Review all proposed parameters before applying.',timezone:'Asia/Shanghai',startsAt:new Date(now.getTime()-60000).toISOString(),endsAt:new Date(now.getTime()+86400000).toISOString(),
   limits:{maxPositionPct:20,maxDailyIncreasePct:5,maxDailyTurnoverPct:20,minCashPct:10,maxGrossExposurePct:90,maxOrderPct:5},
   entries:[{id:'trim',text,sourceKeys:[],directive:{ticker:'FICT',side:'sell',quantity:1,trigger:{kind:'price_gte',price:110},reviewedText:text,numericEvidence:[{field:'quantity',value:1,quote:'1 share'},{field:'trigger.price',value:110,quote:'110 USD'}]}}]},evidenceIds:[] as string[],gaps:[]};
  const llm={validateConnectionIds:async()=>{},isConfigured:async()=>true,chatFastJSON:async(messages:Array<{content:string}>)=>{
   calls++;const input=JSON.parse(messages[1].content);
   if(!evidenceId){const [current]=await db.select().from(councilSessions).where(eq(councilSessions.owner,owner));evidenceId=current.evidenceSnapshot.find(e=>e.sourceName==='Portfolio Data')?.id??current.checkpoint?.simple?.commonEvidence?.[0]?.id??'';assert.ok(evidenceId,'Frozen evidence must be available to the first independent job');}
   return {data:{response:{thesis:'Independent review supports a conditional proposal, not an immediate order.',evidencePoints:['Supplied portfolio context'],risks:['Execution condition may not occur'],nextChecks:['Recheck the original filing']},evidenceIds:[evidenceId],
    ...(input.phase==='challenge'?{reverseCheck:{outcome:'no_counterevidence_found',checked:['Check the original data periods'],findings:[],gaps:[],affectedPremises:['Portfolio exposure'],evidenceIds:[evidenceId]}}:{}),
    ...(input.phase==='summary'?{executionPlan:{...proposal,evidenceIds:[evidenceId]}}:{})},tokens:1};}};
  const council=new CouncilService(db,llm as never,{collectEvidence:async()=>[]} as never,{getPortfolioContext:async()=>({totalValue:1000,cash:500,holdings:[{ticker:'FICT',shares:5,marketValue:500}]})} as never,{listRuns:async()=>({items:[]})} as never,undefined,undefined,undefined,undefined,documents);
  const session=await council.createSession(owner,{scene:'portfolio_daily',subject:'Fictional portfolio',language:'en',members:[{id:'data',name:'Data',role:'researcher',model:'fast',instructions:''},{id:'check',name:'Check',role:'challenger',model:'fast',instructions:''},{id:'summary',name:'Summary',role:'manager',model:'fast',instructions:''}]},{independent:true});
  const [stored]=await db.select().from(councilSessions).where(eq(councilSessions.id,session.id));
  await db.update(councilSessions).set({checkpoint:{...stored.checkpoint!,simple:{...stored.checkpoint!.simple!,researchOnly:true,contextDate:businessDate(now,'Asia/Shanghai')}}}).where(eq(councilSessions.id,session.id));
  await council.runSession(owner,session.id);let result=await council.getSession(owner,session.id);
  for(let i=0;i<1000&&result.status==='running';i++){await new Promise(r=>setTimeout(r,10));result=await council.getSession(owner,session.id);}
  assert.equal(result.status,'completed',result.error??'');assert.equal(calls,5);
  const report=result.reports.at(-1)!;assert.equal(report.coverage?.executionPlan?.readiness,'ready');
  const version=await documents.getVersion(owner,report.researchVersionId!);
  assert.equal(version.sourceStatus,'available','The exact generated report retains its original source');
  await waitForSavedAvailability(version.availableAt);
  assert.equal(version.snapshot?.executionPlan?.readiness,'ready');assert.equal(version.snapshot?.executionPlan?.strategy.entries[0].directive?.quantity,1);
  assert.match(version.sections.find(s=>s.id==='execution-strategy')!.content,/110/);assert.doesNotMatch(version.sections.find(s=>s.id==='execution-strategy')!.content,/"numericEvidence"/);
  const strategies=new UserInvestmentStrategyService(db,documents,{json:async()=>{extractions++;throw Error('Unexpected extraction');}} as never);
  const channel=new ChannelService(db,{} as never);await channel.onModuleInit();
  const sync=new DailyChannelResearchService({} as never,db,channel,strategies);await sync.syncPublished();await sync.syncPublished();
  const workspace=await strategies.workspace(owner);assert.equal(workspace.drafts.length,1);const draft=workspace.drafts[0];
  assert.equal(draft.preview?.canConfirm,true);assert.equal(draft.preview?.directives[0].quantity,1);assert.equal(extractions,0);
  assert.equal(draft.preview!.contentHash,strategyContentHash(draft.content,draft.sources));
  let activations=0;await db.transaction(tx=>strategies.confirmInTransaction(tx,owner,draft.id,draft.revision,draft.preview!.contentHash,null,async()=>{activations++;}));
  assert.equal(activations,1);await sync.syncPublished();assert.equal((await strategies.workspace(owner)).drafts.length,0);
  assert.equal(extractions,0);assert.equal((await documents.getVersion(owner,version.id)).contentHash,version.contentHash);
  const revisedSections=version.sections.map(s=>s.id==='execution-strategy'?{...s,content:'Observation only. The old trading proposal was withdrawn by this manual revision.'}:s);
  const revision=await documents.createDraft(owner,version.id,{title:version.title,content:'Manually revised report.',changeReason:'Withdraw the old proposal',sections:revisedSections});
  const manual=await documents.publishDraft(owner,revision.id,revision.revision);
  assert.equal(manual.snapshot?.executionPlan,undefined,'manual report changes cannot inherit hidden executable authority');
  assert.equal(manual.snapshot?.executionPlanError,undefined);
  await assert.rejects(strategies.importSource(owner,{kind:'report',versionId:manual.id,sectionId:'execution-strategy'}),/No validated report execution strategy/);
  // A native summary adds sources after the mandatory reverse gate. Both artifacts keep their raw evidence.
  const inventory=Array.from({length:72},(_,index)=>({...stored.evidenceSnapshot[0],id:`retained-${index}`} as CouncilEvidence));
  const claimId=randomUUID(),summaryTurn={memberId:'summary',phase:'summary' as const};
  const checkpoint={...stored.checkpoint!,simple:{...stored.checkpoint!.simple!,stage:'discussion' as const,researchOnly:true},turns:[summaryTurn],nextTurn:0,inflight:{id:claimId,turn:0,revision:stored.revision}};
  await db.update(councilSessions).set({status:'running',checkpoint,evidenceSnapshot:inventory.slice(0,60)}).where(eq(councilSessions.id,session.id));
  await db.insert(councilMessages).values({owner,sessionId:session.id,role:'challenger',memberName:'Reverse evidence fixture',revision:stored.revision,content:'Check original source.',metadata:{cycleId:checkpoint.cycleId,reverseCheck:{outcome:'no_counterevidence_found',checked:['Original source'],findings:[],gaps:[],affectedPremises:['Portfolio exposure'],evidenceIds:['retained-40']}}});
  const contribution=parseContribution({response:{thesis:'Conditional proposal',evidencePoints:[],risks:[],nextChecks:[]},evidenceIds:[],executionPlan:{...proposal,evidenceIds:inventory.slice(0,40).map(e=>e.id)}},new Set(inventory.map(e=>e.id)),summaryTurn,null);
  const [current]=await db.select().from(councilSessions).where(eq(councilSessions.id,session.id));
  const retained=await (council as unknown as {recordTurn(...args:unknown[]):Promise<boolean>}).recordTurn(owner,current,summaryTurn,claimId,{member:{id:'summary',name:'Summary',role:'manager',model:'fast',instructions:''},contribution,tokens:1,replyToMessageId:null,sources:inventory.slice(60)});
  assert.equal(retained,true);
  const [saved]=await db.select().from(councilSessions).where(eq(councilSessions.id,session.id));
  assert.equal(saved.evidenceSnapshot.length,60);
  for(const id of [...inventory.slice(0,40).map(e=>e.id),'retained-40'])assert.ok(saved.evidenceSnapshot.some(e=>e.id===id),`Missing cited raw evidence: ${id}`);

 }finally{await client.end();await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;await admin.end();}
});
