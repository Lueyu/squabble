import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { makeTeamFixture, teamErrorIs } from './team-test.fixture';
import { teamAccountBindings, teamPreviews, teamVersions, teamSourceGrants, teams } from '../../database/teams.schema';
import { dataLibrarySources,dataLibraryVersions } from '../../database/data-library.schema';
import { paperAccounts } from '../../database/schema';
const options={skip:!process.env.TEAM_TEST_DATABASE_URL};
test('competing binding previews commit one owner-scoped active responsibility and keep immutable history',options,async()=>{
  const f=await makeTeamFixture();
  try{
    const a=await f.team('A'),b=await f.team('B'),account=await f.account();
    const input=(t:typeof a)=>({requestKey:randomUUID(),action:'assign',accountId:account.id,teamVersionId:t.version.id,expectedBindingRevision:0,expectedAccountBindingId:null,executionChoice:'keep_confirmed_rules',acknowledgePendingReapproval:true});
    const pa=await f.versions.bindingPreview(f.owner,a.team.id,input(a)),pb=await f.versions.bindingPreview(f.owner,b.team.id,input(b));
    const results=await Promise.allSettled([f.versions.binding(f.owner,a.team.id,{requestKey:randomUUID(),previewId:pa.previewId,previewHash:pa.previewHash}),f.versions.binding(f.owner,b.team.id,{requestKey:randomUUID(),previewId:pb.previewId,previewHash:pb.previewHash})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const bindings=await f.db.select().from(teamAccountBindings).where(eq(teamAccountBindings.state,'active'));assert.equal(bindings.length,1);
    const current=bindings[0],currentTeam=await f.service.detail(f.owner,current.teamId);
    const release=await f.versions.bindingPreview(f.owner,current.teamId,{requestKey:randomUUID(),action:'release',accountId:account.id,teamVersionId:current.teamVersionId,expectedBindingRevision:currentTeam.bindingRevision,expectedAccountBindingId:current.id,executionChoice:'pause_all',acknowledgePendingReapproval:true});
    await f.versions.binding(f.owner,current.teamId,{requestKey:randomUUID(),previewId:release.previewId,previewHash:release.previewHash});
    assert.equal((await f.service.detail(f.owner,current.teamId)).accountId,null);
    assert.equal((await f.db.select().from(paperAccounts).where(eq(paperAccounts.id,account.id)))[0].isActive,true);
    assert.equal((await f.db.select().from(teamAccountBindings).where(eq(teamAccountBindings.id,current.id)))[0].state,'released');
    await assert.rejects(f.client`UPDATE team_versions SET semantic_hash='mutated' WHERE id=${current.teamVersionId}`,/TEAM_IMMUTABLE_HISTORY/);
  }finally{await f.dispose();}
});
test('source grants and confirmations bind exact owned versions, revoke atomically and do not revive old grants',options,async()=>{
  const f=await makeTeamFixture();
  try{
    const t=await f.team();
    const [source]=await f.db.insert(dataLibrarySources).values({owner:f.owner,kind:'text',title:'Fixture private',format:'text'}).returning();
    const [version]=await f.db.insert(dataLibraryVersions).values({owner:f.owner,sourceId:source.id,version:1,contentHash:'fixture-hash',rawContent:'fictional evidence',extractedText:'fictional evidence',sections:[],byteLength:18,extractionState:'ready'}).returning();
    const sourceRef={kind:'document_version',id:version.id,revision:'1',availability:'available'};
    await assert.rejects(f.sources.grant(f.stranger,t.team.id,{requestKey:'foreign',expectedScopeRevision:0,sourceRef}),teamErrorIs('TEAM_NOT_FOUND'));
    await assert.rejects(f.sources.grant(f.owner,t.team.id,{requestKey:'wrong-version',expectedScopeRevision:0,sourceRef:{...sourceRef,revision:'2'}}),teamErrorIs('TEAM_SOURCE_UNAVAILABLE'));
    const granted=await f.sources.grant(f.owner,t.team.id,{requestKey:'grant',expectedScopeRevision:0,sourceRef});assert.equal(granted.scopeRevision,1);
    const preview=await f.versions.publishPreview(f.owner,t.team.id,{requestKey:'preview-before-revoke',expectedSemanticRevision:t.team.semanticRevision});
    const revoked=await f.sources.revoke(f.owner,t.team.id,granted.grant.id,{requestKey:'revoke',expectedScopeRevision:1,reason:'Fixture revocation'});assert.equal(revoked.scopeRevision,2);
    await assert.rejects(f.versions.publish(f.owner,t.team.id,{requestKey:'stale-preview',previewId:preview.previewId,previewHash:preview.previewHash}),teamErrorIs('TEAM_PREVIEW_STALE'));
    const regranted=await f.sources.grant(f.owner,t.team.id,{requestKey:'regrant',expectedScopeRevision:2,sourceRef});
    assert.notEqual(regranted.grant.id,granted.grant.id);
    assert.equal((await f.db.select().from(teamSourceGrants).where(eq(teamSourceGrants.id,granted.grant.id)))[0].state,'revoked');
  }finally{await f.dispose();}
});
test('incomplete and cyclic drafts persist, publication rejects them, expired and consumed previews cannot be reused',options,async()=>{
  const f=await makeTeamFixture();
  try{
    const t=await f.team(),role=t.role,config=structuredClone(t.version.config);
    config.roles[0].executor=null;config.relations=[{id:randomUUID(),fromRoleId:role,toRoleId:role,kind:'reports_to',responsibilityScope:'invalid fixture'}];
    const saved=await f.service.save(f.owner,t.team.id,'draft',{requestKey:'invalid-draft',expectedSemanticRevision:t.team.semanticRevision,config});
    assert.equal(saved.draft.config.roles[0].executor,null);
    await assert.rejects(f.versions.publishPreview(f.owner,t.team.id,{requestKey:'invalid-publish',expectedSemanticRevision:saved.semanticRevision}),teamErrorIs('TEAM_GRAPH_INVALID'));
    const reverted=await f.service.save(f.owner,t.team.id,'draft',{requestKey:'valid-draft',expectedSemanticRevision:saved.semanticRevision,config:t.version.config});
    const p=await f.versions.publishPreview(f.owner,t.team.id,{requestKey:'expires',expectedSemanticRevision:reverted.semanticRevision});
    await f.db.update(teamPreviews).set({expiresAt:new Date(Date.now()-1000)}).where(eq(teamPreviews.id,p.previewId));
    await assert.rejects(f.versions.publish(f.owner,t.team.id,{requestKey:'expired-confirm',previewId:p.previewId,previewHash:p.previewHash}),teamErrorIs('TEAM_PREVIEW_STALE'));
    process.env.TEAM_WORKSPACE_ENABLED='false';
    assert.equal((await f.service.list(f.owner,{})).items.length,1,'rollout switch preserves audit history');
    await assert.rejects(f.service.create(f.owner,{requestKey:'disabled-create',name:'disabled'}));
  }finally{await f.dispose();}
});
