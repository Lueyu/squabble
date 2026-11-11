import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { TeamStore } from './team-store';
import { TeamsService } from './teams.service';
import { TeamVersionService } from './team-version.service';
import { TeamRuntimeAdapter } from './team-runtime-adapter';
import { TeamCommissionService } from './team-commission.service';
import { TeamCommissionWorker } from './team-commission.worker';
import { teamCommissions, teamCommissionJobs } from '../../database/teams.schema';
import { paperAccounts } from '../../database/schema';
import { modelConnections } from '../../database/model-connections.schema';
import { llmBudgetSettings } from '../../database/llm-budget.schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { DEFAULT_INVESTMENT_CONFIG } from '../paper-trading/investment-policy.rules';
import type { CouncilService } from '../council/council.service';
import type { TeamDetail, TeamSemanticConfig } from '../../../shared/team-workspace.interface';
const code=(expected:string)=>(e:unknown)=>typeof e==='object'&&e!==null&&'getResponse' in e&&(e.getResponse as ()=>{code:string})().code===expected;
test('team CAS, immutable publication, resource-bound receipts, binding race, and unknown start survive PostgreSQL', {skip:!process.env.TEAM_TEST_DATABASE_URL}, async()=>{
  const url=process.env.TEAM_TEST_DATABASE_URL!,ns='team_'+randomUUID().replaceAll('-',''),admin=postgres(url,{max:1,onnotice:()=>undefined});
  const client=postgres(url,{max:6,onnotice:()=>undefined,connection:{search_path:ns}});
  await admin.unsafe('CREATE SCHEMA '+ns);
  const before={workspace:process.env.TEAM_WORKSPACE_ENABLED,research:process.env.TEAM_RESEARCH_ENABLED};
  process.env.TEAM_WORKSPACE_ENABLED='true';process.env.TEAM_RESEARCH_ENABLED='true';
  try{
    await client.unsafe(readFileSync('scripts/db/01_schema.sql','utf8'));
    await client.unsafe(readFileSync('scripts/db/61_teams.sql','utf8'));
    const db=drizzle(client),owner=randomUUID(),stranger=randomUUID();
    await client`INSERT INTO users(id,username,password_hash) VALUES(${owner},${'team-'+owner.slice(0,16)},'fixture'),(${stranger},${'other-'+stranger.slice(0,16)},'fixture')`;
    let starts=0;
    const runtime=new TeamRuntimeAdapter({prepareTeamSessionInTransaction:async()=>({sessionId:randomUUID(),cycleId:randomUUID(),rootBudgetTaskId:randomUUID()}),
      runTeamSessionOnce:async()=>{starts++;throw new Error('fixture lost transport response');}} as unknown as CouncilService);
    const [connection]=await db.insert(modelConnections).values({owner,name:'Fixture metadata',baseUrl:'http://fixture.invalid',fastModel:'fixture',slowModel:'fixture',apiKeyEnc:'fixture-only-unused'}).returning();
    await db.insert(llmBudgetSettings).values({owner,inputUsdPerMillion:'1',outputUsdPerMillion:'2'});
    const store=new TeamStore(db),teams=new TeamsService(store),versions=new TeamVersionService(store,runtime),commissions=new TeamCommissionService(store,runtime);
    const a=await teams.create(owner,{requestKey:'create-a',name:'Fixture team'}) as TeamDetail;
    const b=await teams.create(owner,{requestKey:'create-b',name:'Other team'}) as TeamDetail;
    await assert.rejects(teams.detail(stranger,a.id),code('TEAM_NOT_FOUND'));
    const role=randomUUID(),config:TeamSemanticConfig={schemaVersion:1,departments:[],roles:[{id:role,departmentId:null,participation:'enabled',responsibility:'Analyze fixture',expectedOutput:'Structured evidence',executor:{executionMode:'model',connectionId:connection.id,model:'fixture',settings:{}},allowedToolIds:[],sourceGrantIds:[]}],relations:[],defaults:{leadRoleId:role,parallelism:1}};
    const saved=await teams.save(owner,a.id,'draft',{requestKey:'draft-a',expectedSemanticRevision:1,config}) as TeamDetail;
    await assert.rejects(teams.save(owner,a.id,'draft',{requestKey:'stale',expectedSemanticRevision:1,config}),code('TEAM_REVISION_CONFLICT'));
    await assert.rejects(teams.save(owner,b.id,'draft',{requestKey:'draft-a',expectedSemanticRevision:1,config}),code('TEAM_REQUEST_KEY_CONFLICT'));
    const preview=await versions.publishPreview(owner,a.id,{requestKey:'preview-a',expectedSemanticRevision:saved.semanticRevision});
    const moved=await teams.save(owner,a.id,'layout',{requestKey:'layout-a',expectedLayoutRevision:1,layout:{schemaVersion:1,positions:{[role]:{x:10,y:20}},collapsedDepartmentIds:[],viewport:{x:0,y:0,zoom:1}}}) as TeamDetail;
    assert.equal(moved.semanticRevision,saved.semanticRevision);
    const published=await versions.publish(owner,a.id,{requestKey:'publish-a',previewId:preview.previewId,previewHash:preview.previewHash});
    assert.equal(published.version.version,1);
    assert.deepEqual(await versions.publish(owner,a.id,{requestKey:'publish-a',previewId:preview.previewId,previewHash:preview.previewHash}),published);
    const [account]=await db.insert(paperAccounts).values({owner,name:'Fixture account',isActive:true}).returning();
    await db.insert(investmentPolicies).values({owner,accountId:account.id,baseConfig:DEFAULT_INVESTMENT_CONFIG,effectiveConfig:DEFAULT_INVESTMENT_CONFIG});
    const bp=await versions.bindingPreview(owner,a.id,{requestKey:'binding-preview',action:'assign',accountId:account.id,teamVersionId:published.version.id,expectedBindingRevision:0,expectedAccountBindingId:null,executionChoice:'keep_confirmed_rules',acknowledgePendingReapproval:true});
    const bound=await versions.binding(owner,a.id,{requestKey:'binding',previewId:bp.previewId,previewHash:bp.previewHash});
    assert.equal(bound.binding?.accountId,account.id);
    const cp=await commissions.preview(owner,a.id,{requestKey:'commission-preview',teamVersionId:published.version.id,bindingId:bound.binding!.id,expectedBindingRevision:1,
      leadRoleId:role,participantRoleIds:[role],supervisorRoleIds:[],objective:'Fixture research',expectedOutput:'Report',dataCutoffAt:null,deadlineAt:new Date(Date.now()+3600000).toISOString(),parallelism:1,inputRefs:[],conflictResolutions:[],
      budget:{budgetMode:'cost_and_calls',ceiling:{amount:'1',currency:'USD'},callLimit:2,paidRevisionLimit:0},
      work:[{workKey:'summary',roleId:role,taskKind:'summary',objective:'Summarize',expectedOutput:'Evidence',dependencyWorkKeys:[],reviewerRoleId:role,reviewMode:'self_check',inputRefs:[],requestedByRoleIds:[]}]});
    const started=await commissions.create(owner,a.id,{requestKey:'commission',previewId:cp.previewId,previewHash:cp.previewHash});
    assert.equal((await db.select().from(teamCommissionJobs)).length,1);
    const worker=new TeamCommissionWorker(store,runtime,commissions);
    await worker.runOnce();await worker.runOnce();await worker.runOnce();
    const [result]=await db.select().from(teamCommissions).where(eq(teamCommissions.id,started.commissionId));
    assert.equal(result.state,'uncertain');assert.equal(starts,1);
    await worker.runOnce();assert.equal(starts,1);
  } finally{
    if(before.workspace===undefined)delete process.env.TEAM_WORKSPACE_ENABLED;else process.env.TEAM_WORKSPACE_ENABLED=before.workspace;
    if(before.research===undefined)delete process.env.TEAM_RESEARCH_ENABLED;else process.env.TEAM_RESEARCH_ENABLED=before.research;
    await client.end();await admin.unsafe('DROP SCHEMA '+ns+' CASCADE');await admin.end();
  }
});
