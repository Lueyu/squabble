import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import { DailyWorkspaceService } from './daily-workspace.service';

@NeedLogin()
@Controller('api/daily-workspace')
export class DailyWorkspaceController {
  constructor(private readonly daily: DailyWorkspaceService) {}
  @Get() read(@Req() request: Request, @Query('date') date?: string) {
    return this.daily.read(request.userContext.userId, date);
  }
}
