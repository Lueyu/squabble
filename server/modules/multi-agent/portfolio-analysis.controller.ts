import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform';
import type { AnalysisLanguage } from '@shared/api.interface';
import type { ModelRoute } from '../../../shared/model-route.interface';
import { PortfolioAnalysisService } from './portfolio-analysis.service';

@NeedLogin()
@Controller('api/multi-agent/portfolio-runs')
export class PortfolioAnalysisController {
  constructor(private readonly reports: PortfolioAnalysisService) {}

  @Post()
  create(@Req() req: Request, @Body() body?: { language?: AnalysisLanguage; route?: ModelRoute }) {
    return this.reports.create(req.userContext.userId, body?.language, body?.route);
  }

  @Get()
  list(@Req() req: Request, @Query('limit') limit?: string) {
    const count = limit === undefined ? 20 : Number(limit);
    return this.reports.list(req.userContext.userId, Number.isFinite(count) ? count : 20);
  }

  @Get(':id')
  get(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.get(req.userContext.userId, id);
  }

  @Post(':id/cancel')
  cancel(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.cancel(req.userContext.userId, id);
  }
}
