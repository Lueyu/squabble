import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { CreateSimulationExperiment } from '../../../shared/simulation-experiment.interface';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { SimulationExperimentsService } from './simulation-experiments.service';

@Controller('api/paper/experiments')
export class SimulationExperimentsController {
  constructor(private readonly experiments: SimulationExperimentsService) {}
  @NeedLogin() @Get() list(@Req() req: Request) { return this.experiments.list(req.userContext.userId); }
  @NeedLogin() @Post('preview') preview(@Req() req: Request) { return this.experiments.preview(req.userContext.userId); }
  @NeedLogin() @Post() create(@Req() req: Request, @Body() body: CreateSimulationExperiment) { return this.experiments.create(req.userContext.userId, body); }
  @NeedLogin() @Post(':id/select') select(@Req() req: Request, @Param('id') id: string) { return this.experiments.select(req.userContext.userId, id); }
  @NeedLogin() @Post(':id/exchange') exchange(@Req() req: Request, @Param('id') id: string, @Body() body: { from: string; to: string; amount: number }) {
    return this.experiments.exchange(req.userContext.userId, id, body);
  }
  @NeedLogin() @Get(':id/review') review(@Req() req: Request, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.experiments.review(req.userContext.userId, id, from, to);
  }
  @NeedLogin() @Post(':id/review/archive') archiveReview(@Req() req: Request, @Param('id') id: string, @Body() body: { from: string; to: string }) {
    return this.experiments.archiveReview(req.userContext.userId, id, body.from, body.to);
  }
}
