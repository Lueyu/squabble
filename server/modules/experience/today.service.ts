import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { PortfolioResearchRouteService } from '../research-routing/portfolio-research-route.service';
import { currencyBreakdown } from './research-presentation';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE,type PostgresJsDatabase,simpleExperienceEnabled } from '../../common/platform';
import { holdings,cashAccounts,fxRates,paperOrders,paperAccounts,transactions } from '../../database/schema';
import { councilReports,councilSessions } from '../../database/council.schema';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { buildPortfolioReportSnapshot } from '../multi-agent/portfolio-analysis.service';
import { capturePortfolioDailyFacts } from '../research-documents/portfolio-daily-facts';
import { LlmService } from '../research-core/llm.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { CurrentResearchService } from './current-research.service';
import { businessDate,preferencesSchema } from './simple-experience.rules';
import type { ExperiencePreferences, TodayView, TodayAttention } from '../../../shared/simple-experience.interface';
import { PortfolioMetricsService } from './portfolio-metrics.service';
import { resolvePortfolioFx } from './portfolio-metrics';
import { positionBaselines } from '../../database/asset-ledger.schema';

@Injectable()
export class TodayService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db:PostgresJsDatabase,private readonly current:CurrentResearchService,
    private readonly llm:LlmService,private readonly documents:ResearchDocumentsService,@Optional() private readonly routes?:PortfolioResearchRouteService,
    @Optional()private readonly metrics?:PortfolioMetricsService) {}
  async preferences(owner:string):Promise<ExperiencePreferences> {
    const [p]=await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner,owner));
    return {enabled:simpleExperienceEnabled(p?.enabled),timezone:p?.timezone??'Asia/Shanghai',defaultMembers:p?.defaultMembers??[],defaultAccountId:p?.defaultAccountId??null,migrationState:(p?.migrationState??'new') as ExperiencePreferences['migrationState']};
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
    const [owned,cash,rates,facts,ledger,baselines]=await this.db.transaction(async tx=>Promise.all([
      tx.select().from(holdings).where(eq(holdings.owner,owner)),tx.select().from(cashAccounts).where(eq(cashAccounts.owner,owner)),
      tx.select().from(fxRates).orderBy(desc(fxRates.rateDate)),capturePortfolioDailyFacts(tx,owner,at,'zh-CN'),
      tx.select().from(transactions).where(eq(transactions.owner,owner)),
      tx.select().from(positionBaselines).where(eq(positionBaselines.owner,owner)),
    ]),{isolationLevel:'repeatable read'});
    const snapshot=owned.length?await buildPortfolioReportSnapshot(owned,cash,async currency=>{
      const rate=resolvePortfolioFx(rates,currency,date);if(!rate)throw new Error('FX unavailable');return rate.rate;
    },'zh-CN'):{capturedAt:at.toISOString(),holdings:[],cashUsd:null,totalValueUsd:null,gaps:[]};
    const today=businessDate(at,prefs.timezone)===date;
    const reading=today&&this.metrics?await this.metrics.read(owner,prefs.timezone,at,{positions:owned,cash,rates,ledger,baselines}):null;
    const analysis=await this.current.get(owner,'portfolio',date),attention:TodayAttention[]=[];
    const dailyReports=typeof this.current.getDailyReports==='function'?await this.current.getDailyReports(owner,date):null;
    for(const row of snapshot.holdings.filter(r=>(r.weightPct??0)>=25))attention.push({id:`concentration:${row.ticker}`,kind:'concentration',ticker:row.ticker,title:row.ticker,detail:`${row.weightPct!.toFixed(1)}%`});
    const gaps=owned.length?[...new Set([...snapshot.gaps,...reading?reading.metrics.gaps.map(metricGap):facts.gaps])]:[];
    if(gaps.length) attention.push({id:'data-gap',kind:'data_gap',title:'数据需要核对 / Check data',detail:gaps[0]});
    const aiAvailable=this.routes?Boolean(await this.routes.resolve(owner).catch(()=>null)):await this.llm.isConfigured(owner).catch(()=>false);
    const reports=await this.db.select({id:councilReports.id,sessionId:councilReports.sessionId,title:councilSessions.title,summary:councilReports.summary,dissent:councilReports.dissent,createdAt:councilReports.createdAt}).from(councilReports)
      .innerJoin(councilSessions,and(eq(councilSessions.id,councilReports.sessionId),eq(councilSessions.owner,owner))).where(eq(councilReports.owner,owner)).orderBy(desc(councilReports.createdAt)).limit(10);
    const orders=await this.db.select({id:paperOrders.id,ticker:paperOrders.ticker,side:paperOrders.side,status:paperOrders.status,reason:paperOrders.reason,createdAt:paperOrders.createdAt}).from(paperOrders)
      .innerJoin(paperAccounts,and(eq(paperAccounts.id,paperOrders.accountId),eq(paperAccounts.owner,owner),eq(paperAccounts.isActive,true))).where(eq(paperOrders.owner,owner)).orderBy(desc(paperOrders.createdAt)).limit(10);
    return {
      date,timezone:prefs.timezone,asOf:at.toISOString(),
      overview:{totalValueUsd:today?(reading?reading.metrics.totalValueUsd:snapshot.totalValueUsd):null,cashUsd:today?(reading?reading.metrics.cashUsd:snapshot.cashUsd):null,
        dailyPnlUsd:today?(reading?reading.metrics.dailyPnlUsd:facts.returnBasis.pnlUsd):null,
        returnPct:today?(reading?reading.metrics.returnPct:facts.returnBasis.returnPct):null,holdingCount:today?snapshot.holdings.length:0},
      holdings:today?snapshot.holdings:[],
      summary:analysis.summary??null,
      attention:today?attention.slice(0,3):[],analysis,
      initialAnalysis:dailyReports?.initial??null,discussionAnalysis:dailyReports?.latestDiscussion??null,reportHistory:dailyReports?.history??[],
      gaps:today?gaps:['Historical report only; current holdings are not historical holdings.'],aiAvailable,
      marketTimes:reading?.metrics.marketTimes??[...new Set(owned.map(r=>r.market??'US'))].map(market=>({market,dataAsOf:null})),
      currencyTotals:today?currencyBreakdown(snapshot.holdings,cash):[],dailyBaselineMissing:reading?!reading.trend.since:!facts.returnBasis.startSnapshot,
      assetMetrics:reading?{...reading.metrics,refreshing:reading.refreshing,provenance:reading.provenance}:undefined,assetTrend:reading?.trend,
      teamActivity:reports.filter(r=>businessDate(r.createdAt,prefs.timezone)===date).slice(0,3).map(r=>({...r,createdAt:r.createdAt.toISOString(),hasDisagreement:r.dissent.length>0})),
      recentActions:orders.filter(r=>businessDate(r.createdAt,prefs.timezone)===date).slice(0,3).map(r=>({...r,createdAt:r.createdAt.toISOString()})),
    };
  }
}

function metricGap(code:string):string {
  const [kind,ticker]=code.split(':');
  return ({CASH_UNCONFIRMED:'账户现金待核对，当前先显示已知资产。',CASH_DUPLICATE_REVIEW:'现金记录需要核对，未将重复余额相加。',
    FX_MISSING:`${ticker??''} 汇率缺失或过期。`,PRICE_MISSING:`${ticker??''} 缺少持仓估值价格。`,
    QUOTE_TIME_UNVERIFIED:`${ticker??''} 正在核对行情实际时间，当前估值仅供参考。`,DAILY_BASIS_MISSING:`${ticker??''} 缺少有效昨收或最新交易日行情。`,
    TRANSACTION_INCOMPLETE:'成交记录有缺项，暂不能完整计算当日盈亏。',TRANSACTION_RECONCILIATION:`${ticker??''} 的成交与期初持仓需要核对。`,
    CASH_OPENING_REQUIRES_RECONCILIATION:'当日现金与成交记录需要核对。'} as Record<string,string>)[kind]??'部分资产资料待核对。';
}
