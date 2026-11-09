import 'reflect-metadata';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {eq} from 'drizzle-orm';
import {PortfolioResearchRouteService} from './portfolio-research-route.service';
import {CurrentResearchService} from '../experience/current-research.service';
import {PortfolioAnalysisService} from '../multi-agent/portfolio-analysis.service';
import {ResearchDocumentsService} from '../research-documents/research-documents.service';
import {portfolioAnalysisRuns,holdings} from '../../database/schema';
import {modelConnections} from '../../database/model-connections.schema';
import {experiencePreferences,researchCurrentViews} from '../../database/simple-experience.schema';
import type {PortfolioReportSnapshot} from '../../../shared/portfolio-report.interface';

test('named-only API portfolios retain owner, connection and model identity through dispatch and durable queue',async()=>{
  const url=process.env.EXPERIENCE_TEST_DATABASE_URL??process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url,'Temporary database required');
  const namespace=`named_portfolio_${randomUUID().replaceAll('-','')}`,admin=postgres(url!,{max:1,onnotice:()=>{}}),client=postgres(url!,{max:6,onnotice:()=>{},connection:{search_path:namespace}});
  try{
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    for(const file of readdirSync('scripts/db').filter(f=>/^\d\d_.*\.sql$/u.test(f)&&!f.startsWith('02_')).sort())await client.unsafe(readFileSync(`scripts/db/${file}`,'utf8'));
    const db=drizzle(client),owner=randomUUID(),foreign=randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},'named-owner','fixture'),(${foreign},'named-foreign','fixture')`;
    await db.insert(holdings).values({owner,ticker:'ACME',company:'Fixture company',shares:'2',buyPrice:'10',currentPrice:'12',currency:'USD',market:'US'});
    const [connection]=await db.insert(modelConnections).values({owner,name:'Named research',baseUrl:'https://named.example/v1',fastModel:'named-fast',slowModel:'named-slow-v1',apiKeyEnc:'ENCRYPTED_FIXTURE'}).returning();
    const [foreignConnection]=await db.insert(modelConnections).values({owner:foreign,name:'Foreign research',baseUrl:'https://foreign.example/v1',fastModel:'other',slowModel:'other',apiKeyEnc:'ENCRYPTED_FOREIGN'}).returning();
    let slowModel='named-slow-v1';const validated:string[]=[],chatted:string[]=[];
    const settings={getDefaultModelRoute:async()=>({mode:'basic'}),getLlmConfig:async(actualOwner:string,id?:string)=>actualOwner===owner&&id===connection.id?{baseUrl:'https://named.example/v1',fastModel:'named-fast',slowModel,apiKey:'NEVER_STORE_THIS_KEY'}:null};
    const llm={isConfigured:async(actualOwner:string,id?:string)=>{assert.equal(actualOwner,owner);assert.equal(id,connection.id);validated.push(id!);return true;},
      validateRoute:async()=>{throw new Error('Named API must not validate the absent default API');},chatSlowJSON:async(_messages:unknown,actualOwner:string,options:{connectionId?:string})=>{
        assert.equal(actualOwner,owner);assert.equal(options.connectionId,connection.id);chatted.push(options.connectionId!);
        return{data:{summary:'Named API researched the frozen portfolio.',allocationRisks:[],actions:[],uncertainties:['Fixture price freshness needs verification.'],holdings:[{ticker:'ACME',stance:'watch',rationale:'Two fictional shares require a fresh quote.',evidenceRefs:['holding:ACME:shares'],triggers:['Verify the next issuer statement.']}]},tokens:2,tokensKnown:true};}};
    const routes=new PortfolioResearchRouteService(db,{readiness:async()=>[]} as never,settings as never,llm as never);
    const selected=await routes.resolve(owner);assert.equal(selected?.connectionId,connection.id,'named API is executable even with no default API');
    await db.insert(experiencePreferences).values({owner,defaultMembers:[foreignConnection.id]});
    assert.equal(await routes.resolve(owner),null,'foreign connection IDs cannot become routes');
    await db.update(experiencePreferences).set({defaultMembers:[connection.id]}).where(eq(experiencePreferences.owner,owner));
    const portfolio=new PortfolioAnalysisService(db,{convert:async(value:number)=>value} as never,settings as never,llm as never);
    const documents=new ResearchDocumentsService(db),current=new CurrentResearchService(db,documents,portfolio,{} as never,routes);
    const snapshot:PortfolioReportSnapshot={capturedAt:new Date().toISOString(),holdings:[{ticker:'ACME',company:'Fixture company',market:'US',currency:'USD',shares:2,currentPrice:12,costPrice:10,marketValueUsd:24,weightPct:null}],cashUsd:null,totalValueUsd:null,gaps:['Fixture cash unavailable.']};
    const wait=async(id:string)=>{for(let i=0;i<200;i++){const run=await portfolio.get(owner,id);if(['completed','failed'].includes(run.status)){assert.equal(run.status,'completed');return run;}await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Named portfolio fixture did not settle');};
    const first=await current.refresh(owner,{topicKey:'portfolio',requestKey:'first'},{shares:0},'Asia/Shanghai',{snapshot});
    const firstRun=await wait(first.taskId!);assert.equal(firstRun.snapshot.executionConnectionId,connection.id);await current.reconcile();
    const [identity]=await db.select().from(researchCurrentViews).where(eq(researchCurrentViews.owner,owner));
    await current.refresh(owner,{topicKey:'portfolio',requestKey:'same'},{shares:0},'Asia/Shanghai',{snapshot});assert.equal(chatted.length,1);
    slowModel='named-slow-v2';await db.update(modelConnections).set({slowModel}).where(eq(modelConnections.id,connection.id));
    const second=await current.refresh(owner,{topicKey:'portfolio',requestKey:'different-model'},{shares:0},'Asia/Shanghai',{snapshot});await wait(second.taskId!);await current.reconcile();
    const [newIdentity]=await db.select().from(researchCurrentViews).where(eq(researchCurrentViews.owner,owner));assert.notEqual(newIdentity.generationKey,identity.generationKey);assert.equal(chatted.length,2);
    const [blocker]=await db.insert(portfolioAnalysisRuns).values({owner,status:'pending',route:{mode:'basic'},snapshot:{},progress:{}}).returning();
    await current.refresh(owner,{topicKey:'portfolio',requestKey:'queue-without-snapshot',trigger:'manual'},{shares:1},'Asia/Shanghai');
    const [queued]=await db.select().from(researchCurrentViews).where(eq(researchCurrentViews.owner,owner));assert.equal(queued.taskKind,'waiting_portfolio');assert.equal(queued.dispatchConnectionId,connection.id);assert.equal(queued.dispatchSnapshot,null);
    await db.update(portfolioAnalysisRuns).set({status:'failed'}).where(eq(portfolioAnalysisRuns.id,blocker.id));
    const restarted=new CurrentResearchService(db,documents,portfolio,{} as never,routes);await restarted.reconcile();
    const [dispatched]=await db.select().from(researchCurrentViews).where(eq(researchCurrentViews.owner,owner));const queuedRun=await wait(dispatched.taskId!);assert.equal(queuedRun.snapshot.executionConnectionId,connection.id);assert.equal(chatted.length,3);
    assert.ok(validated.length>=3);assert.doesNotMatch(JSON.stringify([queuedRun.snapshot,selected?.fingerprint,queued]),/NEVER_STORE_THIS_KEY|ENCRYPTED_FIXTURE/u);
  }finally{await client.end();await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`;await admin.end();}
});
