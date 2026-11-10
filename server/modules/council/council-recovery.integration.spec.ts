import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { councilSessions } from '../../database/council.schema';
import { councilMemberAttempts } from '../../database/simple-council.schema';
import { CouncilService } from './council.service';
import { newCheckpoint } from './council.dialogue';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
test('local reparse costs zero calls and retry is member-specific, durable and idempotent',async()=>{
  assert.ok(process.env.COUNCIL_TEST_DATABASE_URL,'Temporary database required');
  const namespace=`recovery_fixture_${randomUUID().replaceAll('-','')}`;
  const admin=postgres(process.env.COUNCIL_TEST_DATABASE_URL!,{max:1,onnotice:()=>{}});
  const client=postgres(process.env.COUNCIL_TEST_DATABASE_URL!,{max:6,onnotice:()=>{},connection:{search_path:namespace}});
  try{
    await admin`CREATE SCHEMA ${admin(namespace)}`;
    for(const name of readdirSync('scripts/db').filter(n=>/^\d+.*\.sql$/u.test(n)&&!n.startsWith('02_')&&(Number(n.slice(0,2))<=34 || n.startsWith('49_'))).sort())await client.unsafe(readFileSync(`scripts/db/${name}`,'utf8'));
    const owner=randomUUID();await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},'recovery-fixture','test')`;
    const members=[{id:'codex',name:'Codex',role:'researcher' as const,model:'fast' as const,instructions:'',executionMode:'local' as const,agentId:'native-codex'},
      {id:'opencode',name:'OpenCode',role:'manager' as const,model:'fast' as const,instructions:'',executionMode:'local' as const,agentId:'native-opencode'}];
    const config=normalizeBuilderConfig({name:'Fixture',template:'guard',tickers:['AAPL'],minimumRating:'Buy',customPrompt:'',maxOrderPct:5,dailyLossLimitPct:3,maxOrdersPerDay:1,notifyOnProposal:false,priceRules:[],council:{enabled:true,members}});
    const checkpoint=newCheckpoint(members,{independent:true});checkpoint.simple!.commonMessageIds=[];checkpoint.simple!.commonEvidence=[];
    const db=drizzle(client);const [session]=await db.insert(councilSessions).values({owner,profileVersion:1,profileSnapshot:config,ticker:'AAPL',status:'paused',checkpoint}).returning();
    const raw=JSON.stringify({response:{thesis:'Fixture conclusion',evidencePoints:[],risks:[],nextChecks:[],details:{one:'First section',two:'Second section',three:'Third section',four:'Fourth section',five:'Fifth section'}},evidenceIds:[]});
    const base={owner,sessionId:session.id,cycleId:checkpoint.cycleId,attempt:1,revision:session.revision,resourceKey:'local:fixture',inputHash:'frozen',inputSnapshot:{commonEvidence:[],commonMessageIds:[]}};
    await db.insert(councilMemberAttempts).values([{...base,memberId:'codex',turn:0,status:'completed',resultAcceptance:'rejected',rawText:raw,failure:{code:'LOCAL_INVALID_RESULT',stage:'parse',recoveries:['reparse_existing']}},
      {...base,memberId:'opencode',turn:1,status:'failed',failure:{code:'LOCAL_TASK_FAILED',stage:'runtime',recoveries:['retry_member']}}]);
    let calls=0;const agents={validate:async()=>{},execute:async()=>{calls++;return{text:raw,usageTokens:null};}};
    const service=new CouncilService(db,{} as never,{} as never,{} as never,{} as never,agents as never);
    const reparse={memberId:'codex',action:'reparse_existing' as const,requestKey:'reparse-once',expectedRevision:session.revision};
    await service.recoverMember(owner,session.id,reparse);assert.equal(calls,0);
    await service.recoverMember(owner,session.id,reparse);assert.equal(calls,0);
    await assert.rejects(service.recoverMember(randomUUID(),session.id,reparse));
    const accepted=await service.getSession(owner,session.id);assert.ok(accepted.messages.some(m=>m.content.includes('Fifth section')));
    const retry={memberId:'opencode',action:'retry_member' as const,requestKey:'retry-once',expectedRevision:accepted.revision};
    await service.recoverMember(owner,session.id,retry);await service.recoverMember(owner,session.id,retry);
    for(let i=0;i<100;i++){if(calls)break;await new Promise(r=>setTimeout(r,10));}assert.equal(calls,1);
    const rows=await client`SELECT member_id,attempt FROM council_member_attempts WHERE session_id=${session.id}`;
    assert.equal(rows.filter(r=>r.member_id==='codex').length,1);assert.equal(rows.filter(r=>r.member_id==='opencode').length,2);
    await new Promise(r=>setTimeout(r,100));
  }finally{await client.end();await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`;await admin.end();}
});
