import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { PortfolioHistoryService } from './portfolio-history.service';

@Controller('api/portfolio-history')
export class PortfolioHistoryController {
  constructor(private readonly history: PortfolioHistoryService) {}

  @Get()
  @NeedLogin()
  read(@Req() request: Request, @Query('period') period?: string, @Query('accountIds') accountIds?: string) {
    return this.history.read(request.userContext.userId, period, accountIds);
  }
}
