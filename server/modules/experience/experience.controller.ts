import { BadRequestException,Body,Controller,ForbiddenException,Get,Post,Query,Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { TodayService } from './today.service';
import { CurrentResearchService } from './current-research.service';
import { businessDate,currentQuerySchema,parseRefresh } from './simple-experience.rules';

@NeedLogin()
@Controller('api')
export class ExperienceController {
  constructor(private readonly today:TodayService,private readonly research:CurrentResearchService) {}
  @Get('experience/preferences') preferences(@Req() req:Request){return this.today.preferences(req.userContext.userId);}
  @Post('experience/preferences') savePreferences(@Req() req:Request,@Body() body:unknown){return this.today.savePreferences(req.userContext.userId,body);}
  @Get('today') getToday(@Req() req:Request,@Query('date') date?:string){if(date&&!currentQuerySchema.safeParse({topicKey:'portfolio',date}).success)throw new BadRequestException('INVALID_DATE');return this.today.get(req.userContext.userId,date);}
  @Get('research/current') async current(@Req() req:Request,@Query() query:unknown){const p=currentQuerySchema.safeParse(query);if(!p.success)throw new BadRequestException('INVALID_RESEARCH_QUERY');const prefs=await this.today.preferences(req.userContext.userId);return this.research.get(req.userContext.userId,p.data.topicKey,p.data.topicKey==='portfolio'?(p.data.date??businessDate(new Date(),prefs.timezone)):'current');}
  @Post('research/current/refresh') async refresh(@Req() req:Request,@Body() body:unknown){
    const p=parseRefresh(body),owner=req.userContext.userId,prefs=await this.today.preferences(owner);
    if(!prefs.enabled)throw new ForbiddenException('SIMPLE_EXPERIENCE_DISABLED');
    const view=await this.today.get(owner),facts={holdings:view.holdings,date:view.date};
    if(p.trigger==='first_open'){
      if(p.topicKey!=='portfolio'||p.date&&p.date!==view.date)throw new BadRequestException('INVALID_AUTOMATIC_RESEARCH_TRIGGER');
      return this.research.refreshDaily(owner,facts,prefs.timezone,prefs.defaultAccountId);
    }
    return this.research.refresh(owner,p,facts,prefs.timezone);
  }
  @Post('research/current/cancel') async cancel(@Req() req:Request,@Body() body:unknown){const prefs=await this.today.preferences(req.userContext.userId);if(!prefs.enabled)throw new ForbiddenException('SIMPLE_EXPERIENCE_DISABLED');return this.research.cancel(req.userContext.userId,body,prefs.timezone);}
  @Post('research/current/reformat') async reformat(@Req() req:Request,@Body() body:unknown){const prefs=await this.today.preferences(req.userContext.userId);return this.research.reformat(req.userContext.userId,body,prefs.timezone);}
}
