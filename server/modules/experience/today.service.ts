import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { PortfolioResearchRouteService } from './portfolio-research-route.service';
import { currencyBreakdown } from './research-presentation';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE,type PostgresJsDatabase } from '../../common/platform';
import { holdings,cashAccounts,fxRates,paperOrders,paperAccounts } from '../../database/schema';
import { councilReports,councilSessions } from '../../database/council.schema';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { buildPortfolioReportSnapshot } from '../multi-agent/portfolio-analysis.service';
import { capturePortfolioDailyFacts } from '../research-documents/portfolio-daily-facts';
import { LlmService } from '../multi-agent/llm.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { CurrentResearchService } from './current-research.service';
import { businessDate,preferencesSchema } from './simple-experience.rules';
import type { ExperiencePreferences, TodayView, TodayAttention } from '../../../shared/simple-experience.interface';

@Injectable()
export class TodayService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db:PostgresJsDatabase,private readonly current:CurrentResearchService,
    private readonly llm:LlmService,private readonly documents:ResearchDocumentsService,@Optional() private readonly routes?:PortfolioResearchRouteService) {}
  async preferences(owner:string):Promise<ExperiencePreferences> {
    const [p]=await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner,owner));
    return {enabled:process.env.SQUABBLE_SIMPLE_EXPERIENCE==='true'&&(p?.enabled??true),timezone:p?.timezone??'Asia/Shanghai',defaultMembers:p?.defaultMembers??[],defaultAccountId:p?.defaultAccountId??null,migrationState:(p?.migrationState??'new') as ExperiencePreferences['migrationState']};
  }
  async savePreferences(owner:string,input:unknown):Promise<ExperiencePreferences> {
    const parsed=preferencesSchema.safeParse(input);if(!parsed.success)throw new BadRequestException('INVALID_PREFERENCES');
    const {requestKey,...changes}=parsed.data;
    await this.documents.withSubmission(owner,`simple-preferences:${requestKey}`,changes,async tx=>{
      await tx.insert(experiencePreferences).values({owner,...changes}).onConflictDoUpdate({target:experiencePreferences.owner,set:{...changes,updatedAt:new Date()}});return {saved:true};
    });return this.preferences(owner);
  }
  async get(owner:string,dateInput?:string):Promise<TodayView> {
    const prefs=await this.preferences(owner),at=new Date(),date=dateInput??businessDate(at,prefs.timezone);
    const [owned,cash,rates,facts]=await this.db.transaction(async tx=>Promise.all([
      tx.select().from(holdings).where(eq(holdings.owner,owner)),tx.select().from(cashAccounts).where(eq(cashAccounts.owner,owner)),
      tx.select().from(fxRates).orderBy(desc(fxRates.rateDate)),capturePortfolioDailyFacts(tx,owner,at,'zh-CN')
    ]),{isolationLevel:'repeatable read'});
    const snapshot=owned.length?await buildPortfolioReportSnapshot(owned,cash,async currency=>{
      const rate=rates.find(r=>r.base===currency&&r.quote==='USD');if(!rate||!Number.isFinite(Number(rate.rate))||Number(rate.rate)<=0)throw new Error('FX unavailable');return Number(rate.rate);
    },'zh-CN'):{capturedAt:at.toISOString(),holdings:[],cashUsd:null,totalValueUsd:null,gaps:[]};
    const analysis=await this.current.get(owner,'portfolio',date),attention:TodayAttention[]=[];
    for(const row of snapshot.holdings.filter(r=>(r.weightPct??0)>=25))attention.push({id:`concentration:${row.ticker}`,kind:'concentration',ticker:row.ticker,title:row.ticker,detail:`${row.weightPct!.toFixed(1)}%`});
    const gaps=owned.length?[...new Set([...snapshot.gaps,...facts.gaps])]:[];
    if(gaps.length) attention.push({id:'data-gap',kind:'data_gap',title:'数据需要核对 / Check data',detail:gaps[0]});
    const aiAvailable=this.routes?Boolean(await this.routes.resolve(owner).catch(()=>null)):await this.llm.isConfigured(owner).catch(()=>false);
    const today=businessDate(at,prefs.timezone)===date;
    const reports=await this.db.select({id:councilReports.id,sessionId:councilReports.sessionId,title:councilSessions.title,summary:councilReports.summary,dissent:councilReports.dissent,createdAt:councilReports.createdAt}).from(councilReports)
      .innerJoin(councilSessions,and(eq(councilSessions.id,councilReports.sessionId),eq(councilSessions.owner,owner))).where(eq(councilReports.owner,owner)).orderBy(desc(councilReports.createdAt)).limit(10);
    const orders=await this.db.select({id:paperOrders.id,ticker:paperOrders.ticker,side:paperOrders.side,status:paperOrders.status,reason:paperOrders.reason,createdAt:paperOrders.createdAt}).from(paperOrders)
      .innerJoin(paperAccounts,and(eq(paperAccounts.id,paperOrders.accountId),eq(paperAccounts.owner,owner),eq(paperAccounts.isActive,true))).where(eq(paperOrders.owner,owner)).orderBy(desc(paperOrders.createdAt)).limit(10);
    return {
      date,timezone:prefs.timezone,asOf:at.toISOString(),
      overview:{totalValueUsd:today?snapshot.totalValueUsd:null,cashUsd:today?snapshot.cashUsd:null,
        dailyPnlUsd:today&&prefs.timezone==='Asia/Shanghai'?facts.returnBasis.pnlUsd:null,
        returnPct:today&&prefs.timezone==='Asia/Shanghai'?facts.returnBasis.returnPct:null,holdingCount:today?snapshot.holdings.length:0},
      holdings:today?snapshot.holdings:[],
      summary:analysis.summary??null,
      attention:today?attention.slice(0,3):[],analysis,
      gaps:today?gaps:['Historical report only; current holdings are not historical holdings.'],aiAvailable,
      marketTimes:[...new Set(owned.map(r=>r.market??'US'))].map(market=>({market,dataAsOf:null})),
      currencyTotals:today?currencyBreakdown(snapshot.holdings,cash):[],dailyBaselineMissing:!facts.returnBasis.startSnapshot,
      teamActivity:reports.filter(r=>businessDate(r.createdAt,prefs.timezone)===date).slice(0,3).map(r=>({...r,createdAt:r.createdAt.toISOString(),hasDisagreement:r.dissent.length>0})),
      recentActions:orders.filter(r=>businessDate(r.createdAt,prefs.timezone)===date).slice(0,3).map(r=>({...r,createdAt:r.createdAt.toISOString()})),
    };
  }
}
