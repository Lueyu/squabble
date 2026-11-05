import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE,type PostgresJsDatabase } from '../../common/platform';
import { researchFollowupJobs } from '../../database/simple-experience.schema';
import { researchMonitorEvents } from '../../database/research-monitor.schema';
import { researchMemories,researchTheses } from '../../database/research-memory.schema';
import { SimpleCouncilService } from '../council/simple-council.service';
import { AutomaticResearchBudgetService } from '../paper-trading/automatic-research-budget.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { randomUUID } from 'node:crypto';
import { businessDate } from './simple-experience.rules';

/** Revisit an existing sourced claim; an observation requests research and never declares truth from P&L. */
@Injectable()
export class ResearchFollowupService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db:PostgresJsDatabase,private readonly conversations:SimpleCouncilService) {}
  async enqueue():Promise<void> {
    await this.db.execute(sql`UPDATE research_followup_jobs SET state='uncertain',updated_at=now() WHERE state='claimed' AND lease_until<now()`);
    const observations=await this.db.select({event:researchMonitorEvents,memory:researchMemories,thesis:researchTheses}).from(researchMonitorEvents)
      .innerJoin(researchTheses,and(eq(researchTheses.id,researchMonitorEvents.thesisId),eq(researchTheses.owner,researchMonitorEvents.owner),eq(researchTheses.version,researchMonitorEvents.thesisVersion)))
      .innerJoin(researchMemories,and(eq(researchMemories.id,researchTheses.memoryId),eq(researchMemories.owner,researchTheses.owner)))
      .where(and(ne(researchMonitorEvents.state,'unknown'),isNull(researchTheses.deletedAt),isNull(researchMemories.deletedAt),eq(researchMemories.excluded,false),eq(researchTheses.excluded,false)))
      .orderBy(desc(researchMonitorEvents.createdAt)).limit(200);
    for(const {event,memory,thesis}of observations) {
      if(!['accepted','confirmed'].includes(thesis.status))continue;
      await this.db.insert(researchFollowupJobs).values({owner:event.owner,thesisId:thesis.id,observationKey:event.observationKey,dueAt:new Date(),sessionId:memory.sessionId,
        result:{observation:event.observation,thesisVersion:thesis.version,ticker:memory.ticker}}).onConflictDoNothing();
    }
    const dated=await this.db.select({thesis:researchTheses,memory:researchMemories}).from(researchTheses)
      .innerJoin(researchMemories,and(eq(researchMemories.id,researchTheses.memoryId),eq(researchMemories.owner,researchTheses.owner)))
      .where(and(isNull(researchTheses.deletedAt),isNull(researchMemories.deletedAt),eq(researchTheses.excluded,false),eq(researchMemories.excluded,false),sql`${researchTheses.content}->'horizon'->>'reviewAt' IS NOT NULL`)).limit(200);
    for(const {thesis,memory}of dated){
      const due=thesis.content.horizon?.reviewAt,instant=due?Date.parse(due):NaN;
      if(!['accepted','confirmed'].includes(thesis.status)||!thesis.content.supportingEvidence?.length||!Number.isFinite(instant)||instant>Date.now())continue;
      await this.db.insert(researchFollowupJobs).values({owner:thesis.owner,thesisId:thesis.id,observationKey:`review:${thesis.version}:${due}`,dueAt:new Date(instant),sessionId:memory.sessionId,
        result:{observation:{kind:'scheduled_review',dueAt:due,reason:'Collect new evidence before assessing the original claim.'},thesisVersion:thesis.version,ticker:memory.ticker}}).onConflictDoNothing();
    }
  }
  async runDue(owner:string,timezone:string):Promise<void> {
    const jobs=await this.db.select().from(researchFollowupJobs).where(and(eq(researchFollowupJobs.owner,owner),eq(researchFollowupJobs.state,'queued'))).orderBy(researchFollowupJobs.dueAt).limit(3);
    for(const job of jobs) {
      const token=randomUUID(),claimed=await this.db.transaction(async tx=>{
        await lockMemoryOwner(tx,owner);
        const [count]=await tx.select({n:sql<number>`count(*)`.mapWith(Number)}).from(researchFollowupJobs).where(and(eq(researchFollowupJobs.owner,owner),ne(researchFollowupJobs.state,'queued'),sql`(${researchFollowupJobs.updatedAt} AT TIME ZONE ${timezone})::date = ${businessDate(new Date(),timezone)}::date`));
        if(count.n>=3)return false;
        const rows=await tx.update(researchFollowupJobs).set({state:'claimed',leaseToken:token,leaseUntil:new Date(Date.now()+300_000),updatedAt:new Date()})
          .where(and(eq(researchFollowupJobs.id,job.id),eq(researchFollowupJobs.state,'queued'))).returning();return rows.length>0;
      });if(!claimed)continue;
      const budget=new AutomaticResearchBudgetService(this.db),claim=await budget.claimAutomaticResearch(owner,null,`followup:${job.id}`,'followup');
      if(!claim.claimed||!claim.taskId) {await this.db.update(researchFollowupJobs).set({state:claim.reason==='ALREADY_CLAIMED'?'uncertain':'queued',updatedAt:new Date()}).where(eq(researchFollowupJobs.id,job.id));continue;}
      try {
        const [thesis]=await this.db.select().from(researchTheses).where(and(eq(researchTheses.owner,owner),eq(researchTheses.id,job.thesisId),isNull(researchTheses.deletedAt),eq(researchTheses.excluded,false)));
        if(!thesis||thesis.version!==job.result?.thesisVersion||!job.sessionId)throw new Error('Original claim changed or is unavailable');
        const observation=job.result?.observation;
        const original=thesis.content.claim;
        const claimText=typeof original==='string'&&original.length<=1200?original:'请核对本讨论保存的完整原判断。 / Review the complete original claim in this discussion.';
        const serialized=JSON.stringify(observation);
        const observationText=serialized&&serialized.length<=500?serialized:'观察资料较长，请核对完整来源后再判断；此处不截断事实。 / Verify the complete observation before judging.';
        await this.conversations.addMessage(owner,job.sessionId,{message:`回访原判断 / Revisit the original claim:\n${claimText}\nNew observation (requires verification): ${observationText}\n请保留原讨论中的假设与限制，核对原始来源，说明支持、推翻或仍未知的部分，并回应原成员。不要用短期股价或收益证明论点正确。`,requestKey:`followup:${job.id}`},{automaticTaskId:claim.taskId});
        await this.db.update(researchFollowupJobs).set({state:'submitted',leaseUntil:null,updatedAt:new Date(),result:{...job.result,automaticTaskId:claim.taskId}}).where(and(eq(researchFollowupJobs.id,job.id),eq(researchFollowupJobs.leaseToken,token)));
      } catch(error) {
        await budget.finish(owner,claim.taskId,'uncertain');
        await this.db.update(researchFollowupJobs).set({state:'failed',leaseUntil:null,updatedAt:new Date(),result:{...job.result,error:error instanceof Error?error.message:'Followup failed'}}).where(and(eq(researchFollowupJobs.id,job.id),eq(researchFollowupJobs.leaseToken,token)));
      }
    }
  }
}
