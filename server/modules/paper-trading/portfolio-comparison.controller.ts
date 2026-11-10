import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { PortfolioComparisonService } from './portfolio-comparison.service';

@Controller('api/ai-investment/comparison')
export class PortfolioComparisonController {
  constructor(private readonly comparison: PortfolioComparisonService) {}

  @NeedLogin()
  @Get()
  read(@Req() request: Request, @Query('period') period?: string, @Query('accountIds') accountIds?: string) {
    return this.comparison.read(request.userContext.userId, period, accountIds);
  }
}
