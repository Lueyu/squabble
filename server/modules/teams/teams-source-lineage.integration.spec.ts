import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { makeTeamFixture,teamErrorIs } from './team-test.fixture';
import { TeamCommissionWorker } from './team-commission.worker';
import { teamCommissions,teamSourceGrants } from '../../database/teams.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { dataLibrarySources,dataLibraryVersions } from '../../database/data-library.schema';
import { researchDocuments,researchDocumentVersions } from '../../database/research-documents.schema';
import { readTeamSourceContents } from '../../database/team-source-context';
import { teamStrategyAuthority } from '../paper-trading/team-strategy-transaction';
const options={skip:!process.env.TEAM_TEST_DATABASE_URL};
test('omitting client sourceRefs cannot adopt or apply accepted work after its frozen grant was revoked',options,async()=>{
  const f=await makeTeamFixture();
  try{
    const [source]=await f.db.insert(dataLibrarySources).values({owner:f.owner,kind:'text',title:'Private fixture',format:'text'}).returning();
    const [version]=await f.db.insert(dataLibraryVersions).values({owner:f.owner,sourceId:source.id,version:1,contentHash:'fixture',rawContent:'fictional private facts',extractedText:'fictional private facts',sections:[],byteLength:23,extractionState:'ready',observedAt:new Date(Date.now()-10000)}).returning();
    const ref={kind:'document_version' as const,id:version.id,revision:'1',availability:'available' as const},c=await f.commission([ref]),worker=new TeamCommissionWorker(f.store,f.runtime,f.commissions);
    await worker.runOnce();
    const row=(await f.db.select().from(teamCommissions).where(eq(teamCommissions.id,c.created.commissionId)))[0],attemptId=randomUUID();
    assert.ok(row.sessionId);
    await f.db.insert(councilResearchTasks).values({owner:f.owner,sessionId:row.sessionId!,cycleId:row.cycleId!,revision:1,key:'summary',position:0,memberId:row.members[0].memberId,dependencies:[],state:'accepted',skills:[],workKey:row.plan.work[0].workKey,acceptedAttemptId:attemptId,attempts:[{id:attemptId,revision:1,kind:'work',startedAt:new Date().toISOString(),state:'succeeded',messageId:randomUUID(),dispatched:true,libraryReferences:[{sourceId:source.id,versionId:version.id}]}]});
    const basis={teamVersionId:row.teamVersionId,bindingId:row.bindingId,bindingRevision:row.bindingRevision,commissionId:row.id,sessionId:row.sessionId!,cycleId:row.cycleId!,workKey:row.plan.work[0].workKey,acceptedAttemptId:attemptId,reportVersionId:null,thesisVersions:[],sourceRefs:[]};
    const adopted=await f.decisions.create(f.owner,c.team.id,{requestKey:'adopt-before-revoke',expectedProposalRevision:0,commissionId:row.id,event:'adopt',basis,reason:'Fixture explicit adoption'});
    assert.deepEqual(adopted.basis.sourceRefs,[ref],'server supplies omitted input lineage');
    const [grant]=await f.db.select().from(teamSourceGrants);
    await f.sources.revoke(f.owner,c.team.id,grant.id,{requestKey:'revoke-input',expectedScopeRevision:1,reason:'Fixture revoked consent'});
    await assert.rejects(f.decisions.create(f.owner,c.team.id,{requestKey:'omit-sources-after-revoke',expectedProposalRevision:0,commissionId:row.id,event:'adopt',basis,reason:'Must be blocked'}),/TEAM_SCOPE_REVOKED/);
    await assert.rejects(f.db.transaction(tx=>teamStrategyAuthority(tx,f.owner,c.account.id,[],[{proposalId:adopted.proposalId,proposalRevision:adopted.proposalRevision,decisionId:adopted.id}])),/TEAM_SCOPE_REVOKED/);
    await assert.rejects(readTeamSourceContents(f.db,f.owner,c.team.id,[ref],row.plan.dataCutoffAt),teamErrorIs('TEAM_SCOPE_REVOKED'));
  }finally{await f.dispose();}
});
test('granting a derived report cannot launder a revoked ancestor or bypass its availability cutoff',options,async()=>{
  const f=await makeTeamFixture();
  try{
    const t=await f.team(),past=new Date(Date.now()-60000);
    const [document]=await f.db.insert(researchDocuments).values({owner:f.owner,title:'Fixture report',kind:'council'}).returning();
    const [v1]=await f.db.insert(researchDocumentVersions).values({owner:f.owner,reportId:document.id,version:1,idempotencyKey:'fixture-v1',contentHash:'a'.repeat(64),title:'Fixture v1',kind:'council',content:'fictional v1',sections:[],availableAt:past,dataAsOf:past}).returning();
    const [v2]=await f.db.insert(researchDocumentVersions).values({owner:f.owner,reportId:document.id,version:2,idempotencyKey:'fixture-v2',contentHash:'b'.repeat(64),title:'Fixture v2',kind:'council',content:'fictional v2',sections:[],availableAt:past,dataAsOf:past,snapshot:{reportReferences:[{versionId:v1.id}]}}).returning();
    const ref={kind:'report_version' as const,id:v2.id,revision:'2',availability:'available' as const};
    const granted=await f.sources.grant(f.owner,t.team.id,{requestKey:'grant-derived',expectedScopeRevision:0,sourceRef:ref});
    assert.equal((await readTeamSourceContents(f.db,f.owner,t.team.id,[ref],new Date().toISOString()))[0].content,'fictional v2');
    await f.db.update(researchDocumentVersions).set({revokedAt:new Date()}).where(eq(researchDocumentVersions.id,v1.id));
    await assert.rejects(readTeamSourceContents(f.db,f.owner,t.team.id,[ref],new Date().toISOString()),teamErrorIs('TEAM_SOURCE_UNAVAILABLE'));
    await assert.rejects(f.sources.grant(f.owner,t.team.id,{requestKey:'grant-revoked-chain',expectedScopeRevision:granted.scopeRevision,sourceRef:ref}),teamErrorIs('TEAM_SOURCE_UNAVAILABLE'));
  }finally{await f.dispose();}
});
