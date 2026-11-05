import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {eq} from 'drizzle-orm';
import {ResearchFollowupService} from './research-followup.service';
import type {SimpleCouncilService} from '../council/simple-council.service';
import {researchFollowupJobs} from '../../database/simple-experience.schema';

test('new observations revisit original discussions once, use shared budget and never declare price to prove a claim',{skip:!process.env.RESEARCH_TEST_DATABASE_URL},async()=>{
  const url=process.env.RESEARCH_TEST_DATABASE_URL!,namespace='followup_'+randomUUID().replaceAll('-',''),admin=postgres(url,{max:1,onnotice:()=>{}}),client=postgres(url,{max:6,onnotice:()=>{},connection:{search_path:namespace}});
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for(const file of readdirSync('scripts/db').filter(f=>/^\d\d_.*\.sql$/.test(f)&&!f.startsWith('02_')).sort())await client.unsafe(readFileSync('scripts/db/'+file,'utf8'));
    const owner=randomUUID(),stranger=randomUUID(),sessionId=randomUUID(),memoryId=randomUUID(),thesisId=randomUUID(),reportId=randomUUID();
    await client`INSERT INTO research_memories(id,owner,ticker,market,topic,language,session_id,report_id,report_version,report_revision,report_created_at,summary,decision) VALUES(${memoryId},${owner},'ACME','US','Margins','en',${sessionId},${reportId},1,1,now(),'Original sourced claim','wait')`;
    await client`INSERT INTO research_theses(id,owner,memory_id,content,status) VALUES(${thesisId},${owner},${memoryId},${client.json({claim:'A source-backed margin recovery claim',assumptions:Array(12).fill('A detailed qualification that must remain in the original record. '.repeat(8))})},'accepted')`;
    for(let i=0;i<5;i++)await client`INSERT INTO research_monitor_events(owner,rule_id,rule_version,thesis_id,thesis_version,observation_key,observation,state) VALUES(${owner},${randomUUID()},1,${thesisId},1,${'fact-'+i},${client.json({state:'breached',reason:'new verified observation',value:12,observedAt:new Date().toISOString(),observationKey:'fact-'+i})},'breached')`;
    await client`INSERT INTO research_monitor_events(owner,rule_id,rule_version,thesis_id,thesis_version,observation_key,observation,state) VALUES(${owner},${randomUUID()},1,${thesisId},1,'unknown','{}'::jsonb,'unknown')`;
    const messages:Array<{owner:string;id:string;input:{message:string};options:{automaticTaskId:string}}>=[];
    const conversation={addMessage:async(o:string,id:string,input:{message:string},options:{automaticTaskId:string})=>{messages.push({owner:o,id,input,options});return {id};}} as unknown as SimpleCouncilService;
    const db=drizzle(client),service=new ResearchFollowupService(db,conversation);
    await service.enqueue();await service.enqueue();
    assert.equal((await db.select().from(researchFollowupJobs)).length,5,'same facts do not duplicate, missing facts do not trigger');
    await service.runDue(stranger,'Asia/Shanghai');assert.equal(messages.length,0);
    await service.runDue(owner,'Asia/Shanghai');await service.runDue(owner,'Asia/Shanghai');
    assert.equal(messages.length,3,'three daily followups share the automatic research cap');
    assert.ok(messages.every(m=>m.input.message.length<=2000),'long original claim records stay in context rather than exceeding the conversation input limit');
    assert.ok(messages.every(m=>m.id===sessionId&&m.owner===owner&&m.options.automaticTaskId&&m.input.message.includes('不要用短期股价或收益证明论点正确')));
    assert.equal((await db.select().from(researchFollowupJobs).where(eq(researchFollowupJobs.state,'queued'))).length,2);
    await client`UPDATE research_theses SET version=2 WHERE id=${thesisId}`;
    await service.enqueue();assert.equal((await db.select().from(researchFollowupJobs)).length,5,'obsolete claim versions never create fresh followups');
    await client.unsafe('UPDATE research_theses SET content=$1::jsonb WHERE id=$2',[JSON.stringify({horizon:{reviewAt:'2026-01-01T00:00:00Z'},supportingEvidence:[{evidenceId:'verified-filing'}]}),thesisId]);
    await service.enqueue();await service.enqueue();
    assert.equal((await db.select().from(researchFollowupJobs)).length,6,'a stated review date creates exactly one followup per claim version');
  }finally{await client.end();await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;await admin.end();}
});
