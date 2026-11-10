import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { DailyWorkspaceResearchService } from './daily-workspace-research.service';

@NeedLogin()
@Controller('api/daily-workspace/research')
export class DailyWorkspaceResearchController {
  constructor(private readonly research: DailyWorkspaceResearchService) {}
  @Get() read(@Req() request: Request, @Query('date') date?: string) {
    return this.research.read(request.userContext.userId, date);
  }
  @Post() start(@Req() request: Request, @Body() body: unknown) {
    return this.research.start(request.userContext.userId, body);
  }
}
