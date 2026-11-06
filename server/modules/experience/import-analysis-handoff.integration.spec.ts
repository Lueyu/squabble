import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { holdings } from '../../database/schema';
import { researchAnalysisRequests } from '../../database/research-analysis-requests.schema';
import { ImportAnalysisHandoffService } from './import-analysis-handoff.service';
import type { CurrentResearchService } from './current-research.service';
import { eq } from 'drizzle-orm';

const url=process.env.EXPERIENCE_TEST_DATABASE_URL??process.env.RESEARCH_TEST_DATABASE_URL;
test('confirmed import and frozen analysis request commit together and dispatch once',{skip:!url},async()=>{
  const namespace='handoff_'+randomUUID().replaceAll('-',''),admin=postgres(url!,{max:1,onnotice:()=>{}}),sql=postgres(url!,{max:4,onnotice:()=>{},connection:{search_path:namespace}});
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try{
    for(const file of readdirSync('scripts/db').filter(f=>/^\d\d_.*\.sql$/u.test(f)&&!f.startsWith('02_')).sort())await sql.unsafe(readFileSync('scripts/db/'+file,'utf8'));
    const db=drizzle(sql),owner=randomUUID();let calls=0,captured:unknown;
    const research={refresh:async(_owner:unknown,_input:unknown,_facts:unknown,_timezone:unknown,options:unknown)=>{calls++;captured=options;return {state:'generating',taskId:randomUUID()};}} as unknown as CurrentResearchService;
    const handoff=new ImportAnalysisHandoffService(db,research);
    await assert.rejects(db.transaction(async tx=>{await tx.insert(holdings).values({owner,ticker:'ACME',shares:'7',buyPrice:'10'});await handoff.enqueueInTransaction(tx,owner,'rollback');throw Error('rollback');}));
    assert.equal((await db.select().from(researchAnalysisRequests)).length,0);
    await db.transaction(async tx=>{await tx.insert(holdings).values({owner,ticker:'ACME',shares:'7',buyPrice:'10'});await handoff.enqueueInTransaction(tx,owner,'saved');await handoff.enqueueInTransaction(tx,owner,'saved');});
    await db.update(holdings).set({shares:'20'}).where(eq(holdings.owner,owner));
    assert.equal((await db.select().from(researchAnalysisRequests)).length,1);
    await Promise.all([handoff.dispatch(),handoff.dispatch()]);
    assert.equal(calls,1);
    assert.equal((captured as {snapshot:{holdings:Array<{shares:number}>}}).snapshot.holdings[0].shares,7);
    await handoff.dispatch();assert.equal(calls,1);
  }finally{await sql.end();await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;await admin.end();}
});
