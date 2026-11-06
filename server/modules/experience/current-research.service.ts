import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ModelRoute } from '../../../shared/model-route.interface';
import type { PortfolioReportSnapshot } from '../../../shared/portfolio-report.interface';
import { PortfolioResearchRouteService } from './portfolio-research-route.service';
import { researchPresentation } from './research-presentation';
import { researchAnalysisRequests } from '../../database/research-analysis-requests.schema';
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
import type { CurrentResearchView, DailyResearchReports } from '../../../shared/simple-experience.interface';
import { AutomaticResearchBudgetService } from '../paper-trading/automatic-research-budget.service';
import { DailyChannelResearchService } from './daily-channel-research.service';

@Injectable()
export class CurrentResearchService {
  private readonly logger=new Logger(CurrentResearchService.name);
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db:PostgresJsDatabase,
    private readonly documents:ResearchDocumentsService,private readonly portfolio:PortfolioAnalysisService,
    private readonly conversations:SimpleCouncilService,@Optional() private readonly routes?:PortfolioResearchRouteService,
    @Optional() private readonly daily?:DailyChannelResearchService) {}

  /** Independent reading projections over immutable versions; the current pointer never defines the initial report. */
  async getDailyReports(owner:string,dateKey:string):Promise<DailyResearchReports> {
    const [preferences]=await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner,owner));
    const timezone=preferences?.timezone??'Asia/Shanghai';
    const rows=await this.db.select({version:researchDocumentVersions,run:portfolioAnalysisRuns,report:councilReports,session:councilSessions})
      .from(researchDocumentVersions).innerJoin(researchDocuments,and(eq(researchDocuments.id,researchDocumentVersions.reportId),eq(researchDocuments.owner,owner)))
      .leftJoin(portfolioAnalysisRuns,and(eq(portfolioAnalysisRuns.owner,owner),sql`${researchDocumentVersions.source}->>'type'='portfolio' AND ${portfolioAnalysisRuns.id}::text=${researchDocumentVersions.source}->>'id'`))
      .leftJoin(councilReports,and(eq(councilReports.owner,owner),sql`${researchDocumentVersions.source}->>'type'='council' AND ${councilReports.id}::text=${researchDocumentVersions.source}->>'id'`))
      .leftJoin(councilSessions,and(eq(councilSessions.owner,owner),eq(councilSessions.id,councilReports.sessionId)))
      .where(and(eq(researchDocumentVersions.owner,owner),eq(researchDocuments.topicKey,'portfolio'),isNull(researchDocumentVersions.revokedAt),lte(researchDocumentVersions.createdAt,new Date()),or(isNull(researchDocumentVersions.availableAt),lte(researchDocumentVersions.availableAt,new Date())),
        sql`((${portfolioAnalysisRuns.id} IS NOT NULL AND ${portfolioAnalysisRuns.route}->>'mode'<>'basic') OR (${councilReports.id} IS NOT NULL AND (${councilReports.publicationOutcome} IS NULL OR ${councilReports.publicationOutcome}='succeeded') AND ${councilReports.engine}<>'basic' AND ${councilSessions.scene}='portfolio_daily'))`,
        sql`coalesce(${researchDocumentVersions.snapshot}->>'businessDate', CASE WHEN ${portfolioAnalysisRuns.id} IS NOT NULL THEN to_char(coalesce(${portfolioAnalysisRuns.completedAt},${portfolioAnalysisRuns.createdAt}) AT TIME ZONE ${timezone},'YYYY-MM-DD') ELSE coalesce(${councilSessions.checkpoint}->'simple'->>'contextDate',to_char(${councilReports.createdAt} AT TIME ZONE ${timezone},'YYYY-MM-DD')) END)=${dateKey}`))
      .orderBy(sql`coalesce(${portfolioAnalysisRuns.completedAt},${portfolioAnalysisRuns.createdAt},${councilReports.createdAt},${researchDocumentVersions.createdAt})`,researchDocumentVersions.id);
    const history:CurrentResearchView[]=rows.map(({version,session})=>{
      const presentation=researchPresentation(null,version.sections);
      return {reportRole:version.source?.type!=='council'||session?.checkpoint?.simple?.researchOnly?'initial':'discussion',topicKey:'portfolio',dateKey,documentId:version.id,title:version.title,updatedAt:typeof version.snapshot?.generatedAt==="string"?version.snapshot.generatedAt:version.createdAt.toISOString(),dataAsOf:version.dataAsOf?.toISOString()??null,changeSummary:version.changeReason,state:presentation.readingState==='ready'?'ready':'failed',taskId:null,error:presentation.readingState==='pending'?'研究已返回，内容整理待核对。 / Research returned; formatting needs review.':null,source:version.source,researchLevel:'ai',sessionId:session?.id??null,...presentation};
    });
    const dailyJobs=new Set(rows.filter(({session})=>session?.checkpoint?.simple?.researchOnly).map(({version})=>version.id));
    const standalone=history.filter(item=>(item.source?.type!=='council'||dailyJobs.has(item.documentId!))&&item.readingState==='ready');
    const completeDiscussions=new Set(rows.filter(({report})=>report&&report.coverage?.complete!==false).map(({version})=>version.id));
    const discussions=history.filter(item=>item.source?.type==='council'&&!dailyJobs.has(item.documentId!)&&item.readingState==='ready'&&item.documentId&&completeDiscussions.has(item.documentId));
    return {initial:standalone[0]??null,latestDiscussion:discussions.at(-1)??null,history};
  }

  async refreshDaily(owner:string,facts:unknown,timezone:string,accountId:string|null):Promise<CurrentResearchView> {
    const day=businessDate(new Date(),timezone),current=await this.get(owner,'portfolio',day);
    if(current.state!=='empty'||current.cancelled)return current;
    if(this.routes&&!await this.routes.resolve(owner))return current;
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
    if(topicKey==='portfolio'&&material?.source?.type==='council'){
      const [dailySource]=await this.db.select({checkpoint:councilSessions.checkpoint}).from(councilReports).innerJoin(councilSessions,and(eq(councilSessions.owner,owner),eq(councilSessions.id,councilReports.sessionId))).where(and(eq(councilReports.owner,owner),eq(councilReports.id,material.source.id)));
      if(!dailySource?.checkpoint?.simple?.researchOnly)material=undefined;
    }
    if(topicKey==='portfolio'&&!material&&dateKey!=='current'){
      const daily=await this.getDailyReports(owner,dateKey),latest=daily.history.filter(item=>item.reportRole==='initial'&&item.readingState==='ready').at(-1);
      if(latest?.documentId)[material]=await this.db.select().from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner,owner),eq(researchDocumentVersions.id,latest.documentId),available));
    }
    if(!material) {
      const rows=await this.db.select({version:researchDocumentVersions}).from(researchDocumentVersions).innerJoin(researchDocuments,and(eq(researchDocuments.id,researchDocumentVersions.reportId),eq(researchDocuments.owner,owner)))
        .where(and(eq(researchDocumentVersions.owner,owner),eq(researchDocuments.topicKey,topicKey),available,
          sql`${researchDocumentVersions.source}->>'type' IN ('daily','deep','portfolio','council')`,
          sql`NOT (${researchDocumentVersions.source}->>'type'='council' AND EXISTS(SELECT 1 FROM council_reports r JOIN simple_council_requests q ON q.session_id=r.session_id AND q.owner=r.owner WHERE r.owner=${owner} AND r.id::text=${researchDocumentVersions.source}->>'id' AND q.request_key LIKE 'refresh:%'))`,
          topicKey==='portfolio'?sql`${researchDocumentVersions.source}->>'type' <> 'council'`:undefined)).orderBy(desc(researchDocumentVersions.createdAt),desc(researchDocumentVersions.id)).limit(100);
      const [preferences]=await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner,owner));
      material=rows.find(r=>dateKey==='current'||(r.version.snapshot?.businessDate??businessDate(r.version.createdAt,preferences?.timezone??'Asia/Shanghai'))===dateKey)?.version;
    }
    let researchLevel:'facts_only'|'ai'='ai',executorLabel:string|null=null;
    let run:typeof portfolioAnalysisRuns.$inferSelect|undefined;
    if(material?.source?.type==='portfolio'){
      const [sourceRun]=await this.db.select().from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,owner),eq(portfolioAnalysisRuns.id,material.source.id)));
      researchLevel=(sourceRun?.route as ModelRoute|undefined)?.mode==='basic'?'facts_only':'ai';
    }
    if(['portfolio','cancelling_portfolio'].includes(view?.taskKind??'')&&view?.taskId)[run]=await this.db.select().from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,owner),eq(portfolioAnalysisRuns.id,view.taskId)));
    let dailySession:typeof councilSessions.$inferSelect|undefined,dailyProgress:CurrentResearchView['progress'];
    if(view?.taskKind==='daily_research'&&view.taskId){
      [dailySession]=await this.db.select().from(councilSessions).where(and(eq(councilSessions.owner,owner),eq(councilSessions.id,view.taskId)));
      if(dailySession){
        const checkpoint=dailySession.checkpoint,total=(dailySession.profileSnapshot.council?.members.length??0)+2;
        const [completed]=await this.db.execute<{count:string}>(sql`SELECT count(*)::text AS count FROM council_independent_submissions WHERE owner=${owner} AND session_id=${dailySession.id} AND cycle_id=${checkpoint?.cycleId??''}`);
        const completedSteps=Number(completed?.count??0)+(checkpoint&&(checkpoint.nextTurn>(dailySession.profileSnapshot.council?.members.length??0))?1:0)+(dailySession.status==='completed'?1:0);
        const phase=checkpoint?.simple?.stage==='independent'?'analyzing':'validating';
        dailyProgress={phase:dailySession.status==='paused'?'paused':phase,message:dailySession.status==='paused'?'研究已暂停，已完成交付已保留。 / Research paused; completed work is retained.':phase==='analyzing'?'正在独立核对资料，结论尚未公开。 / Independent source checks are in progress.':'正在核对反证并整理今日报告。 / Checking counterevidence and preparing today’s report.',percent:Math.min(100,Math.round(completedSteps/Math.max(1,total)*100))};
      }
    }
    const route=(run?.route??view?.dispatchRoute) as ModelRoute|undefined;
    if(route)executorLabel=route.mode==='local'?route.agentId.replace(/^(native|companion)-/u,''):route.mode==='api'?'AI':null;
    const presentation=researchPresentation(null,material?.sections??[]);
    const content=material?.source?presentation.content:material?.content??'';
    return {topicKey,dateKey,documentId:material?.id??null,title:material?.title??'',
      updatedAt:typeof material?.snapshot?.generatedAt==="string"?material.snapshot.generatedAt:material?.createdAt.toISOString()??null,dataAsOf:material?.dataAsOf?.toISOString()??null,
      changeSummary:view?.changeSummary??material?.changeReason??null,state:(view?.state==='generating'&&dailySession?.status==='paused'?'failed':view?.state==='generating'?'generating':view?.state==='failed'?'failed':material&&researchLevel==='ai'?presentation.readingState==='ready'?'ready':'failed':'empty'),taskId:view?.taskId??null,error:view?.error??(dailySession?.status==='paused'?dailySession.error??'研究已暂停，请检查连接后在原研究中继续。 / Research paused; check the connection and resume explicitly.':null)??(material&&presentation.readingState==='pending'?'研究已返回，内容整理待核对。 / Research returned; formatting needs review.':null),source:material?.source??null,
      researchLevel:material?researchLevel:'facts_only',...presentation,...(view?.taskKind==='formatting_portfolio'?{readingState:'pending' as const}:{}),content,progress:dailyProgress??(run?.progress as CurrentResearchView['progress'])??(view?.state==='generating'?{phase:'queued',message:'正在等待可用的 AI 股友…',percent:0}:null),executorLabel,...(dailySession?{sessionId:dailySession.id}:{}),
      startedAt:dailySession?.checkpoint?.simple?.startedAt??dailySession?.createdAt.toISOString()??run?.startedAt?.toISOString()??(view?.state==='generating'?view.updatedAt.toISOString():null),cancelling:view?.taskKind==='cancelling_portfolio',cancelled:view?.taskKind==='cancelled'};
  }

  async cancel(owner:string,input:unknown,timezone:string):Promise<CurrentResearchView>{
    const value=parseRefresh(input),dateKey=value.topicKey==='portfolio'?(value.date??businessDate(new Date(),timezone)):'current';
    if(value.topicKey!=='portfolio')throw new BadRequestException('PORTFOLIO_TASK_REQUIRED');
    const stopping=await this.get(owner,value.topicKey,dateKey);
    if(this.daily&&stopping.taskId&&stopping.state==='generating'){
      const [view]=await this.db.select().from(researchCurrentViews).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey)));
      if(view?.taskKind==='daily_research')await this.daily.stop(owner,stopping.taskId);
    }
    await this.documents.withSubmission(owner,`simple-cancel:${value.requestKey}`,value,async tx=>{
      const [view]=await tx.select().from(researchCurrentViews).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey)));
      if(!view||view.state!=='generating')return{cancelled:true};
      await tx.update(researchAnalysisRequests).set({state:'cancelled',updatedAt:new Date()}).where(and(eq(researchAnalysisRequests.owner,owner),eq(researchAnalysisRequests.dateKey,dateKey),inArray(researchAnalysisRequests.state,['queued','dispatching'])));
      let draining=false;
      if(view.taskKind==='portfolio'&&view.taskId){
        const [run]=await tx.select().from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,owner),eq(portfolioAnalysisRuns.id,view.taskId)));
        if(run&&['running','cancelling'].includes(run.status)){draining=true;await tx.update(portfolioAnalysisRuns).set({status:'cancelling',progress:{phase:'analyzing',message:'正在停止分析，等待股友确认…',percent:50},updatedAt:new Date()}).where(and(eq(portfolioAnalysisRuns.owner,owner),eq(portfolioAnalysisRuns.id,run.id),inArray(portfolioAnalysisRuns.status,['running','cancelling'])));}
        else if(run?.status==='pending')await tx.update(portfolioAnalysisRuns).set({status:'cancelled',completedAt:new Date(),updatedAt:new Date()}).where(and(eq(portfolioAnalysisRuns.owner,owner),eq(portfolioAnalysisRuns.id,run.id),eq(portfolioAnalysisRuns.status,'pending')));
      }
      await tx.update(researchCurrentViews).set({state:draining?'generating':view.currentDocumentId?'ready':'empty',taskKind:draining?'cancelling_portfolio':'cancelled',generationSequence:view.generationSequence+1,generationKey:null,error:null,changeSummary:'本次分析已停止。 / Analysis stopped.',updatedAt:new Date()}).where(eq(researchCurrentViews.id,view.id));
      return{cancelled:true};
    });return this.get(owner,value.topicKey,dateKey);
  }

  /** Reuse the retained completed result. This path has no executor or provider call. */
  async reformat(owner:string,input:unknown,timezone:string):Promise<CurrentResearchView>{
    const value=parseRefresh(input),dateKey=value.topicKey==='portfolio'?(value.date??businessDate(new Date(),timezone)):'current';
    await this.documents.withSubmission(owner,`simple-reformat:${value.requestKey}`,value,async tx=>{
      const [view]=await tx.select().from(researchCurrentViews).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey)));
      if(!view||view.state==='generating'||!view.taskId||!['portfolio','formatting_portfolio'].includes(view.taskKind??''))throw new BadRequestException('NO_COMPLETED_RESULT_TO_REPARSE');
      const [run]=await tx.select().from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,owner),eq(portfolioAnalysisRuns.id,view.taskId),eq(portfolioAnalysisRuns.status,'completed')));
      if(!run?.report)throw new BadRequestException('NO_COMPLETED_RESULT_TO_REPARSE');
      const material=await this.documents.importSourceInTransaction(tx,owner,{type:'portfolio',id:run.id}),presentation=researchPresentation(null,material.sections);
      await tx.update(researchCurrentViews).set(presentation.readingState==='ready'?{currentDocumentId:material.id,state:'ready',taskKind:'portfolio',error:null,updatedAt:new Date()}:{state:'failed',taskKind:'formatting_portfolio',error:'研究已返回，内容整理待核对。原始材料已保留。 / Research returned; formatting needs review. The original material is preserved.',updatedAt:new Date()}).where(eq(researchCurrentViews.id,view.id));
      return {documentId:material.id};
    });
    return this.get(owner,value.topicKey,dateKey);
  }

  async refresh(owner:string,input:unknown,facts:unknown,timezone:string,options?:{automaticTaskId?:string;route?:ModelRoute;connectionId?:string;snapshot?:PortfolioReportSnapshot;expectedGenerationKey?:string}):Promise<CurrentResearchView> {
    const value=parseRefresh(input), dateKey=value.topicKey==='portfolio'?(value.date??businessDate(new Date(),timezone)):'current';
    if(value.topicKey==='portfolio'&&dateKey!==businessDate(new Date(),timezone)) throw new BadRequestException('PAST_RESEARCH_IS_READ_ONLY');
    const selected=value.topicKey==='portfolio'&&this.routes?await this.routes.resolve(owner):undefined;
    const route=options?.route??selected?.route;
    const connectionId=route?.mode==='api'?(options?.connectionId??selected?.connectionId):undefined;
    if(value.topicKey==='portfolio'&&this.routes&&!route)throw new BadRequestException('请先连接一位可用的 AI 股友。 / Connect an available AI friend first.');
    const generationKey=generationIdentity(value.topicKey,dateKey,{facts,...(route?{route,executor:selected?.fingerprint,...(connectionId?{connectionId}:{})}:{} )});
    const receipt=await this.documents.withSubmission(owner,`simple-refresh:${value.requestKey}`,value,async tx=>{
      const [current]=await tx.select().from(researchCurrentViews).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey)));
      if(options?.expectedGenerationKey&&current?.generationKey!==options.expectedGenerationKey)throw new ConflictException('RESEARCH_REQUEST_SUPERSEDED');
      if(current?.generationKey===generationKey&&(current.state==='generating'||current.state==='ready'&&value.trigger!=='manual')) return {sequence:current.generationSequence,dispatch:false};
      const sequence=(current?.generationSequence??0)+1;
      const dispatch={dispatchSnapshot:options?.snapshot??null,dispatchRoute:route??null,dispatchConnectionId:connectionId??null};
      await tx.insert(researchCurrentViews).values({owner,topicKey:value.topicKey,dateKey,generationKey,generationSequence:sequence,state:'generating',automaticTaskId:options?.automaticTaskId??null,...dispatch})
        .onConflictDoUpdate({target:[researchCurrentViews.owner,researchCurrentViews.topicKey,researchCurrentViews.dateKey],set:{generationKey,generationSequence:sequence,state:'generating',taskId:null,taskKind:null,error:null,automaticTaskId:options?.automaticTaskId??null,...dispatch}});
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
        if(value.topicKey==='portfolio'&&this.daily){
          id=await this.daily.create(owner,dateKey,value.requestKey,options?.automaticTaskId);kind='daily_research';
        } else if(value.topicKey==='portfolio') {
          if(selected?.busy){await this.db.update(researchCurrentViews).set({taskKind:'waiting_executor',updatedAt:new Date()}).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey),eq(researchCurrentViews.generationSequence,Number(receipt.sequence))));return this.get(owner,value.topicKey,dateKey);}
          const [active]=await this.db.select({id:portfolioAnalysisRuns.id}).from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,owner),inArray(portfolioAnalysisRuns.status,['pending','running','cancelling']))).limit(1);
          if(active){await this.db.update(researchCurrentViews).set({taskKind:'waiting_portfolio',updatedAt:new Date()}).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey),eq(researchCurrentViews.generationSequence,Number(receipt.sequence))));return this.get(owner,value.topicKey,dateKey);}
          if(options?.automaticTaskId)await new AutomaticResearchBudgetService(this.db).reserveCall(owner,options.automaticTaskId);const run=await this.portfolio.create(owner, 'zh-CN',route,options?.snapshot,connectionId);id=run.id;kind='portfolio';}
        else {const result=await this.conversations.create(owner,{message:'请研究当前情况，给出支持理由、主要疑点、当前判断和下一步需要关注的证据。',context:{kind:'stock',ticker:value.topicKey.slice(7)},requestKey:`refresh:${value.requestKey}`},options);
          if(!('id' in result)) throw new BadRequestException('STOCK_IDENTITY_REQUIRED');id=result.id;kind='council';}
        await this.db.update(researchCurrentViews).set({taskId:id,taskKind:kind,updatedAt:new Date()}).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey),eq(researchCurrentViews.generationSequence,Number(receipt.sequence))));
      } catch(error) {
        const busy=error instanceof Error&&error.message==='PORTFOLIO_BUSY_RETRY';
        await this.db.update(researchCurrentViews).set(busy?{taskKind:'waiting_portfolio',updatedAt:new Date()}:{state:'failed',error:error instanceof Error?error.message.slice(0,300):'Research unavailable',updatedAt:new Date()}).where(and(eq(researchCurrentViews.owner,owner),eq(researchCurrentViews.topicKey,value.topicKey),eq(researchCurrentViews.dateKey,dateKey),eq(researchCurrentViews.generationSequence,Number(receipt.sequence)))); }
    }
    return this.get(owner,value.topicKey,dateKey);
  }

  async reconcile():Promise<void> {
    const rows=await this.db.select().from(researchCurrentViews).where(eq(researchCurrentViews.state,'generating')).limit(100);
    for(const row of rows) {
      if(row.taskKind==='import_pending')continue;
      if(row.taskKind==='cancelling_portfolio'){
        const [run]=await this.db.select().from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,row.owner),eq(portfolioAnalysisRuns.id,row.taskId!)));
        if(!run||['completed','failed','cancelled'].includes(run.status))await this.db.update(researchCurrentViews).set({state:row.currentDocumentId?'ready':'empty',taskKind:'cancelled',taskId:null,error:null,updatedAt:new Date()}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));
        continue;
      }
      if(row.taskKind==='waiting_portfolio'||row.taskKind==='waiting_executor') {
        if(row.taskKind==='waiting_executor'&&this.routes){const ready=await this.routes.resolve(row.owner);if(!ready||ready.busy)continue;}
        const [active]=await this.db.select({id:portfolioAnalysisRuns.id}).from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,row.owner),inArray(portfolioAnalysisRuns.status,['pending','running','cancelling']))).limit(1);
        if(!active){
          const [claimed]=await this.db.update(researchCurrentViews).set({taskKind:'dispatching',updatedAt:new Date()}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence),eq(researchCurrentViews.taskKind,row.taskKind))).returning();
          if(claimed)try{if(row.automaticTaskId)await new AutomaticResearchBudgetService(this.db).reserveCall(row.owner,row.automaticTaskId);const run=await this.portfolio.create(row.owner,'zh-CN',row.dispatchRoute??undefined,row.dispatchSnapshot??undefined,row.dispatchConnectionId??undefined);await this.db.update(researchCurrentViews).set({taskId:run.id,taskKind:'portfolio',updatedAt:new Date()}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));}catch(error){await this.db.update(researchCurrentViews).set({state:'failed',error:error instanceof Error?error.message:'Research unavailable'}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));}
        }continue;
      }
      if(!row.taskId) {if(Date.now()-row.updatedAt.getTime()>300_000) await this.db.update(researchCurrentViews).set({state:'failed',error:'Research delivery was interrupted; update again to retry.'}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));continue;}
      try {
        let status:string|undefined,sessionError:string|null=null,source:{type:'portfolio'|'council';id:string}|undefined;
        if(row.taskKind==='portfolio') {const [run]=await this.db.select().from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,row.owner),eq(portfolioAnalysisRuns.id,row.taskId)));status=run?.status;if(status==='completed') source={type:'portfolio',id:row.taskId};}
        else {const [session]=await this.db.select().from(councilSessions).where(and(eq(councilSessions.owner,row.owner),eq(councilSessions.id,row.taskId)));status=session?.status;sessionError=session?.error??null;const [report]=await this.db.select().from(councilReports).where(and(eq(councilReports.owner,row.owner),eq(councilReports.sessionId,row.taskId))).orderBy(desc(councilReports.createdAt)).limit(1);if(report&&(!report.publicationOutcome||report.publicationOutcome==='succeeded'))source={type:'council',id:report.id};}
        if(source) {
          const material=await this.documents.importSource(row.owner,source);
          if(researchPresentation(null,material.sections).readingState==='pending'){
            await this.db.update(researchCurrentViews).set({state:'failed',taskKind:'formatting_portfolio',error:'研究已返回，内容整理待核对。原始材料已保留。 / Research returned; formatting needs review. The original material is preserved.',updatedAt:new Date()}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));
            continue;
          }
          await this.db.transaction(async tx=>{await lockMemoryOwner(tx,row.owner);await tx.update(researchCurrentViews).set({currentDocumentId:material.id,state:'ready',error:null,changeSummary:row.currentDocumentId?'New complete research is available.':null,updatedAt:new Date()}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));});
          if(row.automaticTaskId)await new AutomaticResearchBudgetService(this.db).finish(row.owner,row.automaticTaskId,'completed');
        } else if(!status||['failed','cancelled','completed'].includes(status)||row.taskKind==='daily_research'&&status==='paused') await this.db.update(researchCurrentViews).set({state:'failed',error:sessionError??'Research did not produce a complete result.',updatedAt:new Date()}).where(and(eq(researchCurrentViews.id,row.id),eq(researchCurrentViews.generationSequence,row.generationSequence)));
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
      WHERE d.topic_key LIKE 'ticker:%'
      AND v.revoked_at IS NULL AND v.created_at<=now() AND (v.available_at IS NULL OR v.available_at<=now())
      AND (r.publication_outcome IS NULL OR r.publication_outcome='succeeded')
      AND NOT EXISTS(SELECT 1 FROM simple_council_requests q WHERE q.owner=s.owner AND q.session_id=s.id AND q.request_key LIKE 'refresh:%')
      ORDER BY d.owner,d.topic_key,CASE WHEN d.topic_key='portfolio' THEN s.checkpoint->'simple'->>'contextDate' ELSE 'current' END,v.created_at DESC
      ON CONFLICT(owner,topic_key,date_key) DO UPDATE SET current_document_id=excluded.current_document_id,state='ready',change_summary=excluded.change_summary,updated_at=now()
      WHERE research_current_views.state<>'generating' AND research_current_views.current_document_id IS DISTINCT FROM excluded.current_document_id
      AND NOT EXISTS(SELECT 1 FROM research_document_versions old WHERE old.id=research_current_views.current_document_id AND old.created_at>=(SELECT fresh.created_at FROM research_document_versions fresh WHERE fresh.id=excluded.current_document_id))`);
  }
}
