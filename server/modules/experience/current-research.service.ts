import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { researchCurrentViews,experiencePreferences } from '../../database/simple-experience.schema';
import { researchDocuments, researchDocumentVersions } from '../../database/research-documents.schema';
import { portfolioAnalysisRuns } from '../../database/schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { PortfolioAnalysisService } from '../multi-agent/portfolio-analysis.service';
import { SimpleCouncilService } from '../council/simple-council.service';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { businessDate, generationIdentity, parseRefresh } from './simple-experience.rules';
import type { CurrentResearchView } from '../../../shared/simple-experience.interface';
import { AutomaticResearchBudgetService } from '../paper-trading/automatic-research-budget.service';

@Injectable()
export class CurrentResearchService {
  private readonly logger=new Logger(CurrentResearchService.name);
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db:PostgresJsDatabase,
    private readonly documents:ResearchDocumentsService,private readonly portfolio:PortfolioAnalysisService,
    private readonly conversations:SimpleCouncilService) {}

  async refreshDaily(owner:string,facts:unknown,timezone:string,accountId:string|null):Promise<CurrentResearchView> {
    const day=businessDate(new Date(),timezone),current=await this.get(owner,'portfolio',day);
    if(current.state!=='empty')return current;
    const budget=new AutomaticResearchBudgetService(this.db),claim=await budget.claimAutomaticResearch(owner,accountId,`daily:${day}`,'portfolio');
    if(!claim.claimed||!claim.taskId){
      if(claim.reason==='ALREADY_CLAIMED')return current;
      await this.db.insert(researchCurrentViews).values({owner,topicKey:'portfolio',dateKey:day,state:'failed',error:'今日自动研究额度已用完。 / Automatic research budget is used up today.'})
        .onConflictDoUpdate({target:[researchCurrentViews.owner,researchCurrentViews.topicKey,researchCurrentViews.dateKey],set:{state:'failed',error:'今日自动研究额度已用完。 / Automatic research budget is used up today.'},setWhere:eq(researchCurrentViews.state,'empty')});
      return this.get(owner,'portfolio',day);
    }
    return this.refresh(owner,{topicKey:'portfolio',requestKey:`daily:${day}`},facts,timezone,{automaticTaskId:claim.taskId});
  }

  async get(owner:string,topicKey:string,dateKey:string):Promise<CurrentResearchView> {
    const [view]=await this.db.select().from(researchCurrentViews).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,topicKey),eq(researchCurrentViews.dateKey,dateKey)));
    let material:typeof researchDocumentVersions.$inferSelect|undefined;
    const available=and(isNull(researchDocumentVersions.revokedAt),lte(researchDocumentVersions.createdAt,new Date()),or(isNull(researchDocumentVersions.availableAt),lte(researchDocumentVersions.availableAt,new Date())));
    if(view?.currentDocumentId) [material]=await this.db.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner,owner),eq(researchDocumentVersions.id,view.currentDocumentId),available));
    if(!material) {
      const rows=await this.db.select({version:researchDocumentVersions}).from(researchDocumentVersions).innerJoin(researchDocuments,and(eq(researchDocuments.id,researchDocumentVersions.reportId),eq(researchDocuments.owner,owner)))
        .where(and(eq(researchDocumentVersions.owner,owner),eq(researchDocuments.topicKey,topicKey),available,
          sql`${researchDocumentVersions.source}->>'type' IN ('daily','deep','portfolio','council')`,
          sql`NOT (${researchDocumentVersions.source}->>'type'='council' AND EXISTS(SELECT 1 FROM council_reports r JOIN simple_council_requests q ON q.session_id=r.session_id AND q.owner=r.owner WHERE r.owner=${owner} AND r.id::text=${researchDocumentVersions.source}->>'id' AND q.request_key LIKE 'refresh:%'))`,
          topicKey==='portfolio'?sql`${researchDocumentVersions.source}->>'type' <> 'council'`:undefined)).orderBy(desc(researchDocumentVersions.createdAt)).limit(100);
      const [preferences]=await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner,owner));
      material=rows.find(r=>dateKey==='current'||businessDate(r.version.dataAsOf??r.version.createdAt,preferences?.timezone??'Asia/Shanghai')===dateKey)?.version;
    }
    return {topicKey,dateKey,documentId:material?.id??null,title:material?.title??'',content:material?.content??'',
      updatedAt:material?.createdAt.toISOString()??null,dataAsOf:material?.dataAsOf?.toISOString()??null,
      changeSummary:view?.changeSummary??material?.changeReason??null,state:(view?.state==='generating'?'generating':view?.state==='failed'?'failed':material?'ready':'empty'),taskId:view?.taskId??null,error:view?.error??null,source:material?.source??null};
  }

  async refresh(owner:string,input:unknown,facts:unknown,timezone:string,options?:{automaticTaskId:string}):Promise<CurrentResearchView> {
    const value=parseRefresh(input), dateKey=value.topicKey==='portfolio'?(value.date??businessDate(new Date(),timezone)):'current';
    if(value.topicKey==='portfolio'&&dateKey!==businessDate(new Date(),timezone)) throw new BadRequestException('PAST_RESEARCH_IS_READ_ONLY');
    const generationKey=generationIdentity(value.topicKey,dateKey,facts);
    const receipt=await this.documents.withSubmission(owner,`simple-refresh:${value.requestKey}`,value,async tx=>{
      const [current]=await tx.select().from(researchCurrentViews).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey)));
      if(current?.generationKey===generationKey&&['generating','ready'].includes(current.state)) return {sequence:current.generationSequence,dispatch:false};
      const sequence=(current?.generationSequence??0)+1;
      await tx.insert(researchCurrentViews).values({owner,topicKey:value.topicKey,dateKey,generationKey,generationSequence:sequence,state:'generating',automaticTaskId:options?.automaticTaskId??null})
        .onConflictDoUpdate({target:[researchCurrentViews.owner,researchCurrentViews.topicKey,researchCurrentViews.dateKey],set:{generationKey,generationSequence:sequence,state:'generating',taskId:null,taskKind:null,error:null,automaticTaskId:options?.automaticTaskId??null}});
      return {sequence,dispatch:true};
    });
    // Dispatch is claimed durably before calling an executor; ambiguous delivery is never replayed.
    const claimed=receipt.dispatch?await this.db.transaction(async tx=>{
      await lockMemoryOwner(tx,owner);
      const rows=await tx.update(researchCurrentViews).set({taskKind:'dispatching',updatedAt:new Date()}).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey),eq(researchCurrentViews.generationSequence,Number(receipt.sequence)),isNull(researchCurrentViews.taskKind))).returning();
      return rows.length>0;
    }):false;
    if(claimed) {
      try {
        let id:string,kind:string;
        if(value.topicKey==='portfolio') {
          const [active]=await this.db.select({id:portfolioAnalysisRuns.id}).from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,owner),inArray(portfolioAnalysisRuns.status,['pending','running','cancelling']))).limit(1);
          if(active){await this.db.update(researchCurrentViews).set({taskKind:'waiting_portfolio',updatedAt:new Date()}).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey),eq(researchCurrentViews.generationSequence,Number(receipt.sequence))));return this.get(owner,value.topicKey,dateKey);}
          if(options?.automaticTaskId)await new AutomaticResearchBudgetService(this.db).reserveCall(owner,options.automaticTaskId);const run=await this.portfolio.create(owner, 'zh-CN');id=run.id;kind='portfolio';}
        else {const result=await this.conversations.create(owner,{message:'请研究当前情况，给出支持理由、主要疑点、当前判断和下一步需要关注的证据。',context:{kind:'stock',ticker:value.topicKey.slice(7)},requestKey:`refresh:${value.requestKey}`},options);
          if(!('id' in result)) throw new BadRequestException('STOCK_IDENTITY_REQUIRED');id=result.id;kind='council';}
        await this.db.update(researchCurrentViews).set({taskId:id,taskKind:kind,updatedAt:new Date()}).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey),eq(researchCurrentViews.generationSequence,Number(receipt.sequence))));
      } catch(error) { await this.db.update(researchCurrentViews).set({state:'failed',error:error instanceof Error?error.message.slice(0,300):'Research unavailable',updatedAt:new Date()}).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey),eq(researchCurrentViews.generationSequence,Number(receipt.sequence)))); }
    }
    return this.get(owner,value.topicKey,dateKey);
  }

  async reconcile():Promise<void> {
    const rows=await this.db.select().from(researchCurrentViews).where(eq(researchCurrentViews.state,'generating')).limit(100);
    for(const row of rows) {
      if(row.taskKind==='waiting_portfolio') {
        const [active]=await this.db.select({id:portfolioAnalysisRuns.id}).from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,row.owner),inArray(portfolioAnalysisRuns.status,['pending','running','cancelling']))).limit(1);
        if(!active){
          const [claimed]=await this.db.update(researchCurrentViews).set({taskKind:'dispatching',updatedAt:new Date()}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence),eq(researchCurrentViews.taskKind,'waiting_portfolio'))).returning();
          if(claimed)try{if(row.automaticTaskId)await new AutomaticResearchBudgetService(this.db).reserveCall(row.owner,row.automaticTaskId);const run=await this.portfolio.create(row.owner,'zh-CN');await this.db.update(researchCurrentViews).set({taskId:run.id,taskKind:'portfolio',updatedAt:new Date()}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));}catch(error){await this.db.update(researchCurrentViews).set({state:'failed',error:error instanceof Error?error.message:'Research unavailable'}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));}
        }continue;
      }
      if(!row.taskId) {if(Date.now()-row.updatedAt.getTime()>300_000) await this.db.update(researchCurrentViews).set({state:'failed',error:'Research delivery was interrupted; update again to retry.'}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));continue;}
      try {
        let status:string|undefined,source:{type:'portfolio'|'council';id:string}|undefined;
        if(row.taskKind==='portfolio') {const [run]=await this.db.select().from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,row.owner),eq(portfolioAnalysisRuns.id,row.taskId)));status=run?.status;if(status==='completed') source={type:'portfolio',id:row.taskId};}
        else {const [session]=await this.db.select().from(councilSessions).where(and(eq(councilSessions.owner,row.owner),eq(councilSessions.id,row.taskId)));status=session?.status;const [report]=await this.db.select().from(councilReports).where(and(eq(councilReports.owner,row.owner),eq(councilReports.sessionId,row.taskId))).orderBy(desc(councilReports.createdAt)).limit(1);if(report&&(!report.publicationOutcome||report.publicationOutcome==='succeeded'))source={type:'council',id:report.id};}
        if(source) {
          const material=await this.documents.importSource(row.owner,source);
          await this.db.transaction(async tx=>{await lockMemoryOwner(tx,row.owner);await tx.update(researchCurrentViews).set({currentDocumentId:material.id,state:'ready',error:null,changeSummary:row.currentDocumentId?'New complete research is available.':null,updatedAt:new Date()}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));});
          if(row.automaticTaskId)await new AutomaticResearchBudgetService(this.db).finish(row.owner,row.automaticTaskId,'completed');
        } else if(!status||['failed','cancelled','completed'].includes(status)) await this.db.update(researchCurrentViews).set({state:'failed',error:'Research did not produce a complete result.',updatedAt:new Date()}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));
      }catch(error){this.logger.warn(error instanceof Error?error.message:'Research reconcile failed');}
    }
    // Only standalone published discussions can update this projection. Refresh dispatch receipts
    // remain durable, so a superseded generation can never re-enter through generic publication.
    await this.db.execute(sql`INSERT INTO research_current_views(owner,topic_key,date_key,current_document_id,state,change_summary)
      SELECT DISTINCT ON (d.owner,d.topic_key,CASE WHEN d.topic_key='portfolio' THEN s.checkpoint->'simple'->>'contextDate' ELSE 'current' END)
      d.owner,d.topic_key,CASE WHEN d.topic_key='portfolio' THEN s.checkpoint->'simple'->>'contextDate' ELSE 'current' END,v.id,'ready',v.change_reason
      FROM research_documents d JOIN research_document_versions v ON v.id=d.latest_version_id AND v.owner=d.owner
      JOIN council_reports r ON r.research_version_id=v.id AND r.owner=v.owner
      JOIN council_sessions s ON s.id=r.session_id AND s.owner=r.owner AND s.status='completed'
      WHERE (d.topic_key LIKE 'ticker:%' OR (d.topic_key='portfolio' AND s.checkpoint->'simple'->>'contextDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
      AND v.revoked_at IS NULL AND v.created_at<=now() AND (v.available_at IS NULL OR v.available_at<=now())
      AND (r.publication_outcome IS NULL OR r.publication_outcome='succeeded')
      AND NOT EXISTS(SELECT 1 FROM simple_council_requests q WHERE q.owner=s.owner AND q.session_id=s.id AND q.request_key LIKE 'refresh:%')
      ORDER BY d.owner,d.topic_key,CASE WHEN d.topic_key='portfolio' THEN s.checkpoint->'simple'->>'contextDate' ELSE 'current' END,v.created_at DESC
      ON CONFLICT(owner,topic_key,date_key) DO UPDATE SET current_document_id=excluded.current_document_id,state='ready',change_summary=excluded.change_summary,updated_at=now()
      WHERE research_current_views.state<>'generating' AND research_current_views.current_document_id IS DISTINCT FROM excluded.current_document_id
      AND NOT EXISTS(SELECT 1 FROM research_document_versions old WHERE old.id=research_current_views.current_document_id AND old.created_at>=(SELECT fresh.created_at FROM research_document_versions fresh WHERE fresh.id=excluded.current_document_id))`);
  }
}
