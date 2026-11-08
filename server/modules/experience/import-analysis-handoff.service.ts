import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DATABASE,type PostgresJsDatabase } from '../../common/platform';
import { holdings,cashAccounts,fxRates,portfolioAnalysisRuns } from '../../database/schema';
import { experiencePreferences,researchCurrentViews } from '../../database/simple-experience.schema';
import { sql } from 'drizzle-orm';
import { researchAnalysisRequests } from '../../database/research-analysis-requests.schema';
import { researchDocumentSubmissions } from '../../database/research-documents.schema';
import type { ResearchDocumentsTransaction } from '../research-documents/research-documents.service';
import { capturePortfolioDailyFacts } from '../research-documents/portfolio-daily-facts';
import { buildPortfolioReportSnapshot } from '../multi-agent/portfolio-analysis.service';
import { businessDate } from './simple-experience.rules';
import { CurrentResearchService } from './current-research.service';
import { PortfolioResearchRouteService } from '../research-routing/portfolio-research-route.service';

@Injectable()
export class ImportAnalysisHandoffService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db:PostgresJsDatabase,private readonly research:CurrentResearchService,
    @Optional() private readonly routes?:PortfolioResearchRouteService){}
  async enqueueInTransaction(tx:ResearchDocumentsTransaction,owner:string,receiptId:string,options?:{coverage?:{totalImages:number;includedImages:number;unresolvedRows:number}}):Promise<{id:string;state:string}>{
    const [existing]=await tx.select().from(researchAnalysisRequests).where(and(eq(researchAnalysisRequests.owner,owner),eq(researchAnalysisRequests.receiptId,receiptId)));
    if(existing)return {id:existing.id,state:existing.state};
    const at=new Date(),[owned,cash,rates,facts,prefs]=await Promise.all([
      tx.select().from(holdings).where(eq(holdings.owner,owner)),tx.select().from(cashAccounts).where(eq(cashAccounts.owner,owner)),
      tx.select().from(fxRates),capturePortfolioDailyFacts(tx,owner,at,'zh-CN'),tx.select().from(experiencePreferences).where(eq(experiencePreferences.owner,owner))]);
    const snapshot=await buildPortfolioReportSnapshot(owned,cash,async currency=>{
      const rate=rates.filter(r=>r.base===currency&&r.quote==='USD').sort((a,b)=>b.rateDate.localeCompare(a.rateDate))[0];
      if(!rate)throw Error('FX_UNAVAILABLE');return Number(rate.rate);
    },'zh-CN');
    snapshot.capturedAt=at.toISOString();snapshot.dailyFacts=facts;
    const c=options?.coverage;
    snapshot.gaps=[...new Set([...snapshot.gaps,...facts.gaps,...(c&&(c.includedImages<c.totalImages||c.unresolvedRows)?[`部分导入：已纳入${c.includedImages}/${c.totalImages}张截图，${c.unresolvedRows}行尚待核对。`]:[])])];
    const [row]=await tx.insert(researchAnalysisRequests).values({owner,receiptId,snapshot,dateKey:businessDate(at,prefs[0]?.timezone??'Asia/Shanghai')})
      .onConflictDoNothing().returning();
    if(row){
      await tx.insert(researchCurrentViews).values({owner,topicKey:'portfolio',dateKey:row.dateKey,state:'generating',taskKind:'import_pending',generationKey:`import:${row.id}`,dispatchSnapshot:snapshot,generationSequence:1})
        .onConflictDoUpdate({target:[researchCurrentViews.owner,researchCurrentViews.topicKey,researchCurrentViews.dateKey],set:{state:'generating',taskKind:'import_pending',taskId:null,automaticTaskId:null,dispatchRoute:null,dispatchConnectionId:null,error:null,generationKey:`import:${row.id}`,dispatchSnapshot:snapshot,generationSequence:sql`${researchCurrentViews.generationSequence}+1`,updatedAt:new Date()}});
      return {id:row.id,state:row.state};
    }
    const [prior]=await tx.select().from(researchAnalysisRequests).where(and(eq(researchAnalysisRequests.owner,owner),eq(researchAnalysisRequests.receiptId,receiptId)));
    return {id:prior.id,state:prior.state};
  }
  async dispatch():Promise<void>{
    // A durable dispatch with no confirmed task is never blindly replayed after a crash.
    const uncertain=await this.db.select().from(researchAnalysisRequests).where(eq(researchAnalysisRequests.state,'dispatching')).limit(20);
    for(const row of uncertain){if(Date.now()-row.updatedAt.getTime()<300_000)continue;
      const [view]=await this.db.select().from(researchCurrentViews).where(and(eq(researchCurrentViews.owner,row.owner),eq(researchCurrentViews.topicKey,'portfolio'),eq(researchCurrentViews.dateKey,row.dateKey)));
      const [receipt]=await this.db.select().from(researchDocumentSubmissions).where(and(eq(researchDocumentSubmissions.owner,row.owner),eq(researchDocumentSubmissions.key,`simple-refresh:import:${row.id}`)));
      const sameGeneration=receipt&&Number(receipt.result.sequence)===view?.generationSequence;
      const confirmedTask=sameGeneration?view?.taskId:null;
      await this.db.update(researchAnalysisRequests).set({state:confirmedTask?'dispatched':'failed',taskId:confirmedTask??null,error:confirmedTask?null:'分析请求状态未确认，请在今日页面查看后重试。',updatedAt:new Date()}).where(and(eq(researchAnalysisRequests.id,row.id),eq(researchAnalysisRequests.state,'dispatching')));
      if(!confirmedTask)await this.db.update(researchCurrentViews).set({state:'failed',error:'分析尚未开始，请重试。'}).where(and(eq(researchCurrentViews.owner,row.owner),eq(researchCurrentViews.generationKey,`import:${row.id}`)));
    }
    const pending=await this.db.select().from(researchAnalysisRequests).where(eq(researchAnalysisRequests.state,'queued')).orderBy(asc(researchAnalysisRequests.createdAt)).limit(20);
    for(const row of pending){
      const [prefs]=await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner,row.owner));
      if(prefs?.enabled===false)continue;
      const [current]=await this.db.select().from(researchCurrentViews).where(and(eq(researchCurrentViews.owner,row.owner),eq(researchCurrentViews.topicKey,'portfolio'),eq(researchCurrentViews.dateKey,row.dateKey)));
      if(current?.generationKey!==`import:${row.id}`){await this.db.update(researchAnalysisRequests).set({state:'superseded',updatedAt:new Date()}).where(eq(researchAnalysisRequests.id,row.id));continue;}
      if(row.dateKey!==businessDate(new Date(),prefs?.timezone??'Asia/Shanghai')){await this.db.update(researchAnalysisRequests).set({state:'expired',error:'持仓已保存，请基于今日资料重新分析。'}).where(eq(researchAnalysisRequests.id,row.id));await this.db.update(researchCurrentViews).set({state:'failed',error:'请基于今日资料重新分析。'}).where(and(eq(researchCurrentViews.owner,row.owner),eq(researchCurrentViews.generationKey,`import:${row.id}`)));continue;}
      const route=this.routes?await this.routes.resolve(row.owner):undefined;if(this.routes&&(!route||route.busy))continue;
      const [active]=await this.db.select({id:portfolioAnalysisRuns.id}).from(portfolioAnalysisRuns).where(and(eq(portfolioAnalysisRuns.owner,row.owner),inArray(portfolioAnalysisRuns.status,['pending','running','cancelling']))).limit(1);if(active)continue;
      const [claimed]=await this.db.update(researchAnalysisRequests).set({state:'dispatching',updatedAt:new Date()}).where(and(eq(researchAnalysisRequests.id,row.id),eq(researchAnalysisRequests.state,'queued'))).returning();if(!claimed)continue;
      try{
        const result=await this.research.refresh(row.owner,{topicKey:'portfolio',date:row.dateKey,requestKey:`import:${row.id}`},{snapshot:row.snapshot},prefs?.timezone??'Asia/Shanghai',{snapshot:row.snapshot,expectedGenerationKey:`import:${row.id}`,...(route?{route:route.route,connectionId:route.connectionId}:{})});
        await this.db.update(researchAnalysisRequests).set({state:result.state==='failed'?'failed':'dispatched',taskId:result.taskId,error:result.error??null,updatedAt:new Date()}).where(eq(researchAnalysisRequests.id,row.id));
      }catch(error){const superseded=error instanceof Error&&error.message==='RESEARCH_REQUEST_SUPERSEDED';await this.db.update(researchAnalysisRequests).set({state:superseded?'superseded':'failed',error:superseded?null:'分析尚未开始，请在今日页面重试。',updatedAt:new Date()}).where(eq(researchAnalysisRequests.id,row.id));}
    }
  }
}
