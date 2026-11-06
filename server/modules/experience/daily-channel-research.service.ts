import { Inject, Injectable } from '@nestjs/common';
import { SimpleCouncilService } from '../council/simple-council.service';
import { DRIZZLE_DATABASE,type PostgresJsDatabase } from '../../common/platform';
import { and,desc,eq,sql } from 'drizzle-orm';
import { councilReports,councilSessions } from '../../database/council.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { ChannelService } from '../channel/channel.service';
import { channelHash } from '../channel/channel-hash';
import { UserInvestmentStrategyService } from '../paper-trading/user-investment-strategy.service';
import type { ChannelEvidenceCard } from '../../../shared/channel.interface';
import { experiencePreferences } from '../../database/simple-experience.schema';
import { businessDate } from './simple-experience.rules';
import { channelMemories } from '../../database/channel.schema';

/** The daily job reuses durable sealed submissions; its transcript is never a channel feed. */
@Injectable()
export class DailyChannelResearchService {
  constructor(private readonly research:SimpleCouncilService,@Inject(DRIZZLE_DATABASE)private readonly db:PostgresJsDatabase,
    private readonly channel:ChannelService,private readonly strategies:UserInvestmentStrategyService){}
  async create(owner:string,date:string,requestKey:string,automaticTaskId?:string):Promise<string>{
    const remembered=await this.db.select().from(channelMemories).where(and(eq(channelMemories.owner,owner),sql`${channelMemories.data}->>'kind'='user_stated_preference'`)).orderBy(desc(channelMemories.createdAt)).limit(20);
    const superseded=new Set(remembered.map(r=>r.data.supersedesId).filter(Boolean));
    const quoted:string[]=[];let budget=800;
    for(const item of remembered.filter(r=>r.data.kind==='user_stated_preference'&&!superseded.has(r.id))){
      const exact=item.data.exactUserQuote;if(!exact)continue;
      const line=JSON.stringify({id:item.id,at:item.data.recordedAt,quote:exact});
      if(line.length>budget)continue;quoted.push(line);budget-=line.length;
    }
    const result=await this.research.create(owner,{
      context:{kind:'portfolio',date},requestKey:`daily-report:${requestKey}`,
      message:'研究我的完整持仓与已记录现金。先按各自信息领域独立调查并封存判断，再单独反向核查关键前提，最后生成今日可阅读报告与当日策略草稿。明确原始来源、数据日期、组合影响、缺口和失效条件。未发现反证不等于正确；缺资料保持未确认。策略仅为草稿，不授权交易。'+(quoted.length?'\n用户曾明确保存的原话（带时间与来源；不是市场事实，不代表交易授权，不推断心理动机）：\n'+quoted.join('\n'):''),
    },{researchOnly:true,automaticTaskId});
    if(!('id' in result))throw new Error('DAILY_RESEARCH_CONTEXT_REQUIRED');
    return result.id;
  }
  async stop(owner:string,id:string){await this.research.stop(owner,id);}
  async syncPublished():Promise<void>{
    const rows=await this.db.select({report:councilReports,session:councilSessions,version:researchDocumentVersions}).from(councilReports)
      .innerJoin(councilSessions,and(eq(councilSessions.owner,councilReports.owner),eq(councilSessions.id,councilReports.sessionId)))
      .innerJoin(researchDocumentVersions,and(eq(researchDocumentVersions.owner,councilReports.owner),eq(researchDocumentVersions.id,councilReports.researchVersionId)))
      .where(and(eq(councilReports.publicationOutcome,'succeeded'),sql`${councilSessions.checkpoint}->'simple'->>'researchOnly'='true'`))
      .orderBy(desc(councilReports.createdAt)).limit(40);
    const publishedOwners=new Set<string>();
    for(const {report,session,version} of rows){
      const owner=report.owner;
      await this.channel.ingestReport(owner,{id:version.id,revision:version.version,title:version.title,content:report.summary,createdAt:report.createdAt.toISOString(),sections:version.sections,
        source:{type:'council',id:report.id,documentId:version.reportId,researchOnly:true}});
      const [prefs]=await this.db.select().from(experiencePreferences).where(eq(experiencePreferences.owner,owner));
      const timezone=prefs?.timezone??'Asia/Shanghai';
      // Historical archives never wake up as fresh alerts or fresh strategy proposals.
      if(publishedOwners.has(owner)||version.revokedAt||businessDate(report.createdAt,timezone)!==businessDate(new Date(),timezone)
        ||session.checkpoint?.simple?.contextDate&&session.checkpoint.simple.contextDate!==businessDate(new Date(),timezone))continue;
      publishedOwners.add(owner);
      // Importing the same daily source is idempotent even after the user confirms its draft.
      const selected=version.sections.find(s=>/策略|strategy/iu.test(s.title))??(report.summary.length>12000?version.sections.find(s=>s.content.length<=12000):undefined);
      await this.strategies.importSource(owner,{kind:'report',versionId:version.id,...(selected?{sectionId:selected.id}:{})},true);
      const check=report.coverage?.reverseCheck;if(!check||check.outcome==='no_counterevidence_found')continue;
      const missing=check.outcome==='unable_to_verify';
      if(missing&&!check.gaps.length)continue;
      const normalize=(s:string)=>s.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase();
      const scope=[...new Set(check.affectedPremises.map(normalize))].sort();
      const episodeId=`research:${owner}:${channelHash(scope)}`;
      const factId=channelHash([report.id,'reverse-check']),delta=channelHash([owner,scope,check.outcome,check.findings.map(normalize).sort(),check.gaps.map(normalize).sort()]);
      const card:ChannelEvidenceCard={id:`card:${factId}`,kind:missing?'gap':'evidence',summary:missing?'反向核查未能确认关键前提。':'正式研究记录了关键前提变化。',
        sources:report.evidence.filter(e=>check.evidenceIds.includes(e.id)).map(e=>({id:e.id,kind:'tool_result',title:e.title,uri:e.sourceUrl??`/?reportId=${version.id}`,publishedAt:null,observedAt:e.fetchedAt,verification:e.metadata?.sources.some(s=>s.verification==='server-verified')?'checked':'unverified'})),
        asOf:report.createdAt.toISOString(),gaps:check.gaps,supports:[{factId,scope:check.affectedPremises.join('；')}]};
      await this.channel.ingestFact(owner,{id:factId,revision:1,ownerId:owner,value:check.outcome,key:'research.reverseCheck',observedAt:report.createdAt.toISOString(),subject:'research_judgment',sourceId:`daily:${owner}:${channelHash(scope)}`,expiresAt:new Date(report.createdAt.getTime()+24*3600_000).toISOString()},card);
      await this.channel.ingestFinding(owner,{id:`finding:${report.id}`,ownerId:owner,episodeId,researchRunId:session.id,createdAt:report.createdAt.toISOString(),
        kind:missing?'material_gap':check.outcome==='critical_counterevidence'?'critical_counterevidence':'partially_weakened',anchor:{kind:'report_section',reportId:version.id,reportRevision:version.version,sectionId:version.sections[0]?.id??'summary'},affectedPremiseIds:check.affectedPremises,
        evidenceCardId:card.id,semanticDeltaId:delta,reverseCheckOutcome:check.outcome,template:{templateId:missing?'channel.finding.gap':check.outcome==='critical_counterevidence'?'channel.finding.refuted':'channel.finding.weakened',templateRevision:1},slots:{},weight:check.outcome==='critical_counterevidence'?'poke':'nudge'});
    }
  }
}
