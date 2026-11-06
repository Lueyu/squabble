import { Inject,Injectable,Logger,OnApplicationBootstrap,OnApplicationShutdown } from '@nestjs/common';
import { DRIZZLE_DATABASE,type PostgresJsDatabase } from '../../common/platform';
import { users } from '../../database/schema';
import { TodayService } from './today.service';
import { CurrentResearchService } from './current-research.service';
import { ResearchFollowupService } from './research-followup.service';
import { businessDate } from './simple-experience.rules';
import { ImportAnalysisHandoffService } from './import-analysis-handoff.service';
import { DailyChannelResearchService } from './daily-channel-research.service';
import { ChannelService } from '../channel/channel.service';
import { ChannelBriefsService } from '../channel/channel-briefs.service';

@Injectable()
export class ExperienceScheduler implements OnApplicationBootstrap,OnApplicationShutdown {
  private timer?:ReturnType<typeof setInterval>;private busy=false;private lastScan=0;private readonly logger=new Logger(ExperienceScheduler.name);
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db:PostgresJsDatabase,private readonly today:TodayService,private readonly research:CurrentResearchService,private readonly followup:ResearchFollowupService,private readonly handoff:ImportAnalysisHandoffService,private readonly daily:DailyChannelResearchService,private readonly channel:ChannelService,private readonly briefs:ChannelBriefsService) {}
  onApplicationBootstrap(){this.timer=setInterval(()=>void this.tick(),15_000);this.timer.unref();}
  onApplicationShutdown(){if(this.timer)clearInterval(this.timer);}
  async tick(){
    if(this.busy||process.env.SQUABBLE_SIMPLE_EXPERIENCE!=='true')return;this.busy=true;
    try {
      await this.handoff.dispatch();await this.research.reconcile();await this.daily.syncPublished();await this.briefs.tick();if(Date.now()-this.lastScan<60_000)return;this.lastScan=Date.now();
      const owners=await this.db.select({id:users.id}).from(users);await this.followup.enqueue();
      for(const {id:owner}of owners){
        const preferences=await this.today.preferences(owner);if(!preferences.enabled)continue;
        await this.channel.monitorOwner(owner);
        const time=new Intl.DateTimeFormat('en-GB',{timeZone:preferences.timezone,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
        if(time>='07:30') {
          const view=await this.today.get(owner),date=businessDate(new Date(),preferences.timezone);
          if(view.holdings.length&&view.analysis.state==='empty'){
            await this.research.refreshDaily(owner,{holdings:view.holdings,date},preferences.timezone,preferences.defaultAccountId);
          }
        }
        await this.followup.runDue(owner,preferences.timezone);
      }
    }catch(error){this.logger.warn(error instanceof Error?error.message:'Experience scheduling failed');}finally{this.busy=false;}
  }
}
