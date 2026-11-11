import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { makeTeamFixture,teamErrorIs } from './team-test.fixture';
import { TeamCommissionWorker } from './team-commission.worker';
import { commissionContext } from './team-commission.service';
import { assertTeamExecutionInTransaction, assertConfirmedTeamPolicyAuthority } from '../../database/team-context';
import { teamCommissions,teamDecisions,teamCommissionJobs } from '../../database/teams.schema';
import { llmBudgetUsage } from '../../database/llm-budget.schema';
import { councilResearchTasks } from '../../database/research-workflow.schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { recordTeamStrategyApplied } from '../paper-trading/team-strategy-transaction';
const options={skip:!process.env.TEAM_TEST_DATABASE_URL};
test('tightening preserves reservations and blocks new dispatch, while unapproved paid retry is rejected',options,async()=>{
  const f=await makeTeamFixture();
  try{
    const c=await f.commission(),worker=new TeamCommissionWorker(f.store,f.runtime,f.commissions);await worker.runOnce();
    const row=(await f.db.select().from(teamCommissions).where(eq(teamCommissions.id,c.created.commissionId)))[0];
    await f.db.transaction(tx=>assertTeamExecutionInTransaction(tx,f.owner,commissionContext(row),{dispatch:true}));
    await f.db.insert(llmBudgetUsage).values({owner:f.owner,taskId:row.rootBudgetTaskId,purpose:'Fixture reserved',model:'fixture',inputTokens:1000,outputTokens:0,maxOutputTokens:1000,reservedTokens:2000,chargedTokens:2000,status:'failed_unknown'});
    const tightened=await f.commissions.control(f.owner,c.team.id,row.id,'budget-limit',{requestKey:'tighten',expectedCommissionRevision:1,ceiling:{amount:'0.002',currency:'USD'},callLimit:1});
    assert.ok('budgetLimit' in tightened);
    assert.equal(tightened.budgetLimit.ceiling.amount,'0.002');
    await assert.rejects(f.db.transaction(tx=>assertTeamExecutionInTransaction(tx,f.owner,commissionContext(row),{dispatch:true})),/TEAM_BUDGET_BLOCKED/);
    assert.equal((await f.db.select().from(llmBudgetUsage))[0].status,'failed_unknown');
    await assert.rejects(f.commissions.control(f.owner,c.team.id,row.id,'budget-limit',{requestKey:'relax',expectedCommissionRevision:2,callLimit:3}),teamErrorIs('TEAM_BUDGET_BLOCKED'));
    const failedAttemptId=randomUUID();
    await f.db.insert(councilResearchTasks).values({owner:f.owner,sessionId:row.sessionId!,cycleId:row.cycleId!,revision:1,key:'summary',position:0,memberId:row.members[0].memberId,dependencies:[],state:'failed',skills:[],workKey:row.plan.work[0].workKey,attempts:[{id:failedAttemptId,revision:1,kind:'work',startedAt:new Date().toISOString(),state:'failed',messageId:randomUUID(),dispatched:true}]});
    await assert.rejects(f.commissions.control(f.owner,c.team.id,row.id,'recover',{requestKey:'unapproved-paid',expectedCommissionRevision:2,action:'retry_work',workKey:row.plan.work[0].workKey,attemptId:failedAttemptId,acknowledgePaidRetry:true,reason:'Fixture retry'}),teamErrorIs('TEAM_BUDGET_BLOCKED'));
    const check=await f.commissions.control(f.owner,c.team.id,row.id,'recover',{requestKey:'check-existing',expectedCommissionRevision:2,action:'check_existing'});
    assert.equal(check.commissionRevision,3);
    process.env.TEAM_RESEARCH_ENABLED='false';
    await assert.rejects(f.db.transaction(tx=>assertTeamExecutionInTransaction(tx,f.owner,commissionContext(row),{dispatch:true})),/TEAM_CAPABILITY_UNAVAILABLE/);
    assert.equal((await f.commissions.detail(f.owner,c.team.id,row.id)).id,row.id);
  }finally{await f.dispose();}
});
test('accepted attempt adoption never applies trades and confirmed policy continues only through an explicit handover receipt',options,async()=>{
  const f=await makeTeamFixture();
  try{
    const c=await f.commission(),worker=new TeamCommissionWorker(f.store,f.runtime,f.commissions);await worker.runOnce();
    const row=(await f.db.select().from(teamCommissions).where(eq(teamCommissions.id,c.created.commissionId)))[0],attemptId=randomUUID();
    assert.ok(row.sessionId,JSON.stringify(await f.db.select().from(teamCommissionJobs)));
    await f.db.insert(councilResearchTasks).values({owner:f.owner,sessionId:row.sessionId!,cycleId:row.cycleId!,revision:1,key:'summary',position:0,memberId:row.members[0].memberId,dependencies:[],state:'accepted',skills:[],workKey:row.plan.work[0].workKey,acceptedAttemptId:attemptId,attempts:[{id:attemptId,revision:1,kind:'work',startedAt:new Date().toISOString(),state:'succeeded',messageId:randomUUID(),dispatched:true}]});
    const basis={teamVersionId:row.teamVersionId,bindingId:row.bindingId,bindingRevision:row.bindingRevision,commissionId:row.id,sessionId:row.sessionId!,cycleId:row.cycleId!,workKey:row.plan.work[0].workKey,acceptedAttemptId:attemptId,reportVersionId:null,thesisVersions:[],sourceRefs:[]};
    const proposal=await f.decisions.create(f.owner,c.team.id,{requestKey:'propose',expectedProposalRevision:0,commissionId:row.id,event:'propose',basis,reason:'Fixture observation'});
    await assert.rejects(f.decisions.create(f.owner,c.team.id,{requestKey:'bad-attempt',expectedProposalRevision:0,commissionId:row.id,event:'adopt',basis:{...basis,acceptedAttemptId:randomUUID()},reason:'Wrong attempt'}),teamErrorIs('TEAM_REFERENCE_NOT_FOUND'));
    const adopted=await f.decisions.create(f.owner,c.team.id,{requestKey:'adopt',proposalId:proposal.proposalId,expectedProposalRevision:1,commissionId:row.id,event:'adopt',basis,reason:'User explicitly adopts fixture'});
    assert.equal((await f.db.select().from(investmentPolicies).where(eq(investmentPolicies.accountId,c.account.id)))[0].revision,1,'adoption is not strategy application');
    const refs=[{proposalId:adopted.proposalId,proposalRevision:adopted.proposalRevision,decisionId:adopted.id}],config={teamDecisionRefs:refs,teamExecutionContexts:[commissionContext(row)]};
    await assert.rejects(f.db.transaction(tx=>assertConfirmedTeamPolicyAuthority(tx,f.owner,c.account.id,config)),/TEAM_REAPPROVAL_REQUIRED/);
    await f.db.transaction(tx=>recordTeamStrategyApplied(tx,f.owner,c.account.id,2,[],refs,'fixture-policy-confirm'));
    const [policy]=await f.db.select().from(investmentPolicies).where(eq(investmentPolicies.accountId,c.account.id));
    await f.db.update(investmentPolicies).set({revision:2,baseConfig:{...policy.baseConfig,...config}}).where(eq(investmentPolicies.id,policy.id));
    await f.db.update(teamCommissions).set({state:'completed'}).where(eq(teamCommissions.id,row.id));
    await f.db.transaction(tx=>assertConfirmedTeamPolicyAuthority(tx,f.owner,c.account.id,{...config,teamExecutionContexts:[{...config.teamExecutionContexts[0],deadlineAt:'2000-01-01T00:00:00.000Z'}]}));
    const bp=await f.versions.bindingPreview(f.owner,c.team.id,{requestKey:'release-preview',action:'release',accountId:c.account.id,teamVersionId:c.version.id,expectedBindingRevision:1,expectedAccountBindingId:c.binding.id,executionChoice:'keep_confirmed_rules',acknowledgePendingReapproval:true});
    await f.versions.binding(f.owner,c.team.id,{requestKey:'release-confirm',previewId:bp.previewId,previewHash:bp.previewHash});
    await f.db.transaction(tx=>assertConfirmedTeamPolicyAuthority(tx,f.owner,c.account.id,config));
    assert.ok((await f.db.select().from(teamDecisions)).some(d=>d.event==='continue_policy'));
    await assert.rejects(f.client`UPDATE team_decisions SET reason='changed' WHERE id=${adopted.id}`,/TEAM_IMMUTABLE_HISTORY/);
  }finally{await f.dispose();}
});
test('binding and archive previews disclose in-flight studies and reject confirmation if another study appeared',options,async()=>{
  const f=await makeTeamFixture();
  try{
    const c=await f.commission(),worker=new TeamCommissionWorker(f.store,f.runtime,f.commissions);await worker.runOnce();await worker.runOnce();
    const row=(await f.db.select().from(teamCommissions).where(eq(teamCommissions.id,c.created.commissionId)))[0];
    const release=await f.versions.bindingPreview(f.owner,c.team.id,{requestKey:'inflight-release-preview',action:'release',accountId:c.account.id,teamVersionId:c.version.id,expectedBindingRevision:1,expectedAccountBindingId:c.binding.id,executionChoice:'keep_confirmed_rules',acknowledgePendingReapproval:true});
    const displayed=release.result.inflightCommissions as {id:string;handoverEffect:string}[];
    assert.equal(displayed[0].id,row.id);assert.equal(displayed[0].handoverEffect,'stop_new_work_settle_dispatched');
    const {schemaVersion:_schema,...plan}=row.plan;
    const cp=await f.commissions.preview(f.owner,c.team.id,{...plan,requestKey:'another-study-preview',teamVersionId:c.version.id,bindingId:c.binding.id,expectedBindingRevision:1,dataCutoffAt:null,inputRefs:[],objective:'Another explicitly confirmed fixture study'});
    await f.commissions.create(f.owner,c.team.id,{requestKey:'another-study',previewId:cp.previewId,previewHash:cp.previewHash});
    await assert.rejects(f.versions.binding(f.owner,c.team.id,{requestKey:'inflight-stale-confirm',previewId:release.previewId,previewHash:release.previewHash}),teamErrorIs('TEAM_PREVIEW_STALE'));
    const archive=await f.versions.archivePreview(f.owner,c.team.id,{requestKey:'inflight-archive',expectedBindingRevision:1,expectedCurrentVersionId:c.version.id,executionChoice:'pause_all'});
    assert.equal((archive.result.inflightCommissions as unknown[]).length,2);
  }finally{await f.dispose();}
});
