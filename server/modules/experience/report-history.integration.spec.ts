import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {eq} from 'drizzle-orm';
import {CurrentResearchService} from './current-research.service';
import {ResearchDocumentsService} from '../research-documents/research-documents.service';
import {portfolioAnalysisRuns} from '../../database/schema';
import {councilSessions,councilReports,councilMessages} from '../../database/council.schema';
import {CouncilService} from '../council/council.service';
import {newCheckpoint} from '../council/council.dialogue';
import {researchCurrentViews} from '../../database/simple-experience.schema';
import {waitForFixturePublications} from '../council/council-test.fixture';

test('first AI report and latest same-day portfolio discussion are independent immutable selections',{skip:!process.env.EXPERIENCE_TEST_DATABASE_URL},async()=>{
  const url=process.env.EXPERIENCE_TEST_DATABASE_URL!,namespace='report_history_'+randomUUID().replaceAll('-','');
  const admin=postgres(url,{max:1,onnotice:()=>{}}),client=postgres(url,{max:4,onnotice:()=>{},connection:{search_path:namespace}});
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try{
    for(const name of readdirSync('scripts/db').filter(n=>/^\d\d_.*\.sql$/u.test(n)&&!n.startsWith('02_')&&(Number(n.slice(0,2))<=34 || n.startsWith('49_'))).sort())await client.unsafe(readFileSync('scripts/db/'+name,'utf8'));
    const owner=randomUUID(),db=drizzle(client),documents=new ResearchDocumentsService(db);
    waitForFixturePublications(documents);
    const service=new CurrentResearchService(db,documents,{} as never,{} as never);
    const created=new Date('2026-11-06T01:00:00Z');
    async function portfolio(summary:string,mode='api',minute=0){const [run]=await db.insert(portfolioAnalysisRuns).values({owner,status:'completed',route:{mode},snapshot:{},progress:{},report:{summary},createdAt:new Date(+created+minute*60000)}).returning();return documents.importSource(owner,{type:'portfolio',id:run.id});}
    await portfolio('Facts only','basic');const update=await portfolio('Manual update','api',2);const initial=await portfolio('Initial AI finding','api',1);
    const [session]=await db.insert(councilSessions).values({owner,ticker:'PORTFOLIO',scene:'portfolio_daily',title:'Portfolio discussion',status:'completed',profileVersion:1,profileSnapshot:{} as never,checkpoint:{simple:{contextDate:'2026-11-06'}} as never}).returning();
    async function discussion(summary:string,version:number){const [report]=await db.insert(councilReports).values({owner,sessionId:session.id,version,revision:version,decision:'wait',summary,dissent:[],nextReviewCondition:'Check filing',evidence:[],engine:'local',publicationOutcome:'succeeded'}).returning();const doc=await documents.importSource(owner,{type:'council',id:report.id});await db.update(councilReports).set({researchVersionId:doc.id}).where(eq(councilReports.id,report.id));return doc;}
    const first=await discussion('First round',1),second=await discussion('Second round',2);
    await db.update(councilSessions).set({status:'running',revision:3}).where(eq(councilSessions.id,session.id));
    await db.insert(researchCurrentViews).values({owner,topicKey:'portfolio',dateKey:'2026-11-06',currentDocumentId:second.id,state:'ready'});
    const selected=await service.getDailyReports(owner,'2026-11-06');
    assert.equal(selected.initial?.documentId,initial.id);assert.equal(selected.latestDiscussion?.documentId,second.id);
    assert.deepEqual(new Set(selected.history.map(item=>item.documentId)),new Set([initial.id,update.id,first.id,second.id]));
    assert.equal((await service.get(owner,'portfolio','2026-11-06')).documentId,update.id,'a discussion cannot overwrite current standalone analysis');
    assert.equal((await service.getDailyReports(randomUUID(),'2026-11-06')).history.length,0);
    assert.equal((await service.getDailyReports(owner,'2026-11-05')).initial,null);
    await db.update(councilSessions).set({status:'failed'}).where(eq(councilSessions.id,session.id));
    assert.equal((await service.getDailyReports(owner,'2026-11-06')).latestDiscussion?.documentId,second.id,'failed followup leaves the prior report readable');
    const index=await documents.list(owner,{history:true,date:'2026-11-06',source:'council'});
    assert.equal(index.items.length,2);assert.ok(index.items.every(item=>item.source?.type==='council'));
    const [partialReport]=await db.insert(councilReports).values({owner,sessionId:session.id,version:3,revision:3,decision:'wait',summary:'Partial research with a missing member.',
      dissent:['Member unavailable'],nextReviewCondition:'Finish the missing review',evidence:[],engine:'local',publicationOutcome:'succeeded',
      coverage:{goal:'review',cycleId:randomUUID(),revision:3,complete:false,tasks:[]} as never}).returning();
    const partial=await documents.importSource(owner,{type:'council',id:partialReport.id});
    const afterPartial=await service.getDailyReports(owner,'2026-11-06');
    assert.equal(afterPartial.latestDiscussion?.documentId,second.id,'partial coverage must not replace the latest complete discussion conclusion');
    assert.ok(afterPartial.history.some(item=>item.documentId===partial.id),'partial saved research remains available in history');
    const checkpoint=newCheckpoint([],{independent:true});
    const [publishing]=await db.insert(councilSessions).values({owner,ticker:'PORTFOLIO',scene:'portfolio_daily',status:'running',profileVersion:1,profileSnapshot:{} as never,checkpoint,evidenceSnapshot:[{id:'filing',title:'Fictional filing',content:'Cash of 10',sourceName:'Filing',sourceUrl:'https://example.org/filing',fetchedAt:created.toISOString(),role:'news',evidenceType:'other',relevanceScore:1}]}).returning();
    await db.insert(councilMessages).values({owner,sessionId:publishing.id,role:'researcher',memberName:'Fixture',content:'Checked published cash figure',revision:1,metadata:{cycleId:checkpoint.cycleId,memberId:'fixture',evidenceCheckStatus:'verified',claims:[{id:'cash',statement:'The filing reports cash of 10.',evidenceIds:['filing']}],evidenceIds:['filing']}});
    const council=new CouncilService(db,{} as never,{} as never,{} as never,{} as never,undefined,undefined,undefined,undefined,documents);
    const publisher=council as unknown as {publish:(owner:string,row:typeof publishing,opinion:{decision:'wait';summary:string;dissent:string[];nextReviewCondition:string;evidenceIds:string[]},engine:'basic',error:null)=>Promise<boolean>};
    const opinion={decision:'wait' as const,summary:'The actual saved round report.',dissent:[],nextReviewCondition:'Read the next filing.',evidenceIds:[]};
    assert.equal(await publisher.publish(owner,publishing,opinion,'basic',null),true);
    assert.equal(await publisher.publish(owner,publishing,opinion,'basic',null),false,'a repeated completion notification cannot create a duplicate report card');
    const saved=await council.getSession(owner,publishing.id);assert.equal(saved.reports.length,1);assert.ok(saved.reports[0].researchVersionId);
    const [savedRow]=await db.select().from(councilSessions).where(eq(councilSessions.id,publishing.id));
    assert.equal(savedRow.checkpoint?.simple?.outcome?.summary,opinion.summary);
    assert.deepEqual(savedRow.checkpoint?.simple?.outcome?.confirmed,['The filing reports cash of 10.']);
    const historicalAt=new Date('2026-11-05T01:23:45Z');
    const historicalSummary='Result follows:\n```json\n{"response":{"thesis":"Original historical finding.","evidencePoints":[],"risks":[],"nextChecks":[]}}\n```';
    const legacyCheckpoint=newCheckpoint([],{independent:true});legacyCheckpoint.simple!.contextDate='2026-11-05';
    const [legacySession]=await db.insert(councilSessions).values({owner,ticker:'PORTFOLIO',scene:'portfolio_daily',title:'Original historical discussion',
      status:'completed',profileVersion:1,profileSnapshot:{} as never,checkpoint:legacyCheckpoint}).returning();
    const [legacyReport]=await db.insert(councilReports).values({owner,sessionId:legacySession.id,version:1,revision:1,decision:'wait',summary:historicalSummary,
      dissent:[],nextReviewCondition:'Check the historical filing.',evidence:[],engine:'local',publicationOutcome:'succeeded',createdAt:historicalAt}).returning();
    const legacyIndex=await documents.list(owner,{history:true,date:'2026-11-05',source:'council'});
    const legacyArchive=legacyIndex.items.find(item=>item.source?.id===legacyReport.id)!;
    assert.ok(legacyArchive);
    let [linked]=await db.select().from(councilReports).where(eq(councilReports.id,legacyReport.id));
    assert.equal(linked.researchVersionId,legacyArchive.id,'history backfill must restore the exact report-card archive link');
    assert.equal(linked.summary,historicalSummary);assert.equal(linked.createdAt.toISOString(),historicalAt.toISOString());
    const archivedBefore=await documents.getVersion(owner,legacyArchive.id);
    assert.equal(archivedBefore.snapshot?.generatedAt,historicalAt.toISOString());
    const [otherRound]=await db.insert(councilReports).values({owner,sessionId:legacySession.id,version:2,revision:2,decision:'wait',summary:'A different historical round.',
      dissent:[],nextReviewCondition:'Another check.',evidence:[],engine:'local',publicationOutcome:'succeeded',createdAt:new Date(+historicalAt+60000)}).returning();
    const otherArchive=await documents.importSource(owner,{type:'council',id:otherRound.id});

    // An installation may already have the immutable archive but no per-card link.
    // A later session rename must not force reimport or replace the old archived title/text.
    await db.update(councilReports).set({researchVersionId:null}).where(eq(councilReports.id,legacyReport.id));
    await db.update(councilReports).set({researchVersionId:null}).where(eq(councilReports.id,otherRound.id));
    await db.update(councilSessions).set({title:'Renamed much later'}).where(eq(councilSessions.id,legacySession.id));
    await documents.list(owner,{history:true,date:'2026-11-05',source:'council'});
    [linked]=await db.select().from(councilReports).where(eq(councilReports.id,legacyReport.id));
    assert.equal(linked.researchVersionId,legacyArchive.id);
    assert.equal((await db.select().from(councilReports).where(eq(councilReports.id,otherRound.id)))[0].researchVersionId,otherArchive.id,'round links must not be replaced by the same session’s newest report');
    assert.deepEqual(await documents.getVersion(owner,legacyArchive.id),archivedBefore,'link repair preserves the complete immutable archive and its timestamps');
    assert.equal((await council.getSession(owner,legacySession.id)).reports[0].researchVersionId,legacyArchive.id);

    const alternate=await documents.submit(owner,{idempotencyKey:'historical-user-copy',title:'Explicit historical revision',kind:'council',content:'User-reviewed historical text',
      sections:[{id:'summary',title:'Summary',content:'User-reviewed historical text'}],source:{type:'council',id:legacyReport.id},reportId:archivedBefore.reportId,
      parentVersionId:legacyArchive.id,changeReason:'Explicit user revision'});
    await db.update(councilReports).set({researchVersionId:alternate.id}).where(eq(councilReports.id,legacyReport.id));
    await documents.list(owner,{history:true,source:'council'});
    assert.equal((await council.getSession(owner,legacySession.id)).reports[0].researchVersionId,alternate.id,'an existing valid owned reference must not be overwritten');
    await council.archiveReport(owner,legacySession.id,legacyReport.id);
    assert.equal((await council.getSession(owner,legacySession.id)).reports[0].researchVersionId,alternate.id,'explicit archive retries also preserve an existing valid reference after a session rename');
    const stranger=randomUUID();
    const [foreignSession]=await db.insert(councilSessions).values({owner:stranger,ticker:'PORTFOLIO',scene:'portfolio_daily',status:'completed',profileVersion:1,profileSnapshot:{} as never}).returning();
    const [foreignReport]=await db.insert(councilReports).values({owner:stranger,sessionId:foreignSession.id,version:1,revision:1,decision:'wait',summary:'Other owner report',
      dissent:[],nextReviewCondition:'Wait',evidence:[],engine:'local',publicationOutcome:'succeeded'}).returning();
    await documents.list(owner,{history:true,source:'council'});
    await assert.rejects(documents.importSource(owner,{type:'council',id:foreignReport.id}),/SOURCE_NOT_FOUND/u);
    assert.equal((await db.select().from(councilReports).where(eq(councilReports.id,foreignReport.id)))[0].researchVersionId,null,'backfill never links another owner’s report');
    const raw='Result follows:\n```json\n{"response":{"thesis":"Reformatted paid result.","evidencePoints":[],"risks":[],"nextChecks":[]}}\n```';
    const [returned]=await db.insert(portfolioAnalysisRuns).values({owner,status:'completed',route:{mode:'api'},snapshot:{},progress:{},report:{summary:raw}}).returning();
    await db.update(researchCurrentViews).set({state:'failed',taskId:returned.id,taskKind:'formatting_portfolio',currentDocumentId:initial.id}).where(eq(researchCurrentViews.owner,owner));
    const repaired=await service.reformat(owner,{topicKey:'portfolio',date:'2026-11-06',requestKey:'reformat-paid'},'Asia/Shanghai');
    assert.match(repaired.content,/Reformatted paid result/u);assert.equal(repaired.state,'ready');
    assert.equal((await service.reformat(owner,{topicKey:'portfolio',date:'2026-11-06',requestKey:'reformat-paid'},'Asia/Shanghai')).documentId,repaired.documentId);
    assert.equal((await db.select().from(portfolioAnalysisRuns).where(eq(portfolioAnalysisRuns.id,returned.id)))[0].report&&JSON.stringify((await db.select().from(portfolioAnalysisRuns).where(eq(portfolioAnalysisRuns.id,returned.id)))[0].report),JSON.stringify({summary:raw}),'reformat never rewrites the original paid output');
  }finally{await client.end();await admin`DROP SCHEMA ${admin(namespace)} CASCADE`;await admin.end();}
});
