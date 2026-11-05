import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { StrategyMandateService } from './strategy-mandate.service';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';
@Controller('api/strategy-mandates')
export class StrategyMandateController {
  constructor(private readonly service: StrategyMandateService) {}
  @NeedLogin() @Get()
  list(@Req() req: Request, @Query('accountId') accountId: string) { return this.service.workspace(req.userContext.userId, accountId); }
  @NeedLogin() @Get(':id')
  view(@Req() req: Request, @Param('id') id: string) { return this.service.viewVersion(req.userContext.userId, id); }
  @NeedLogin() @Post()
  create(@Req() req: Request, @Body() body: { config: StrategyMandateInput; parentId?: string }) { return this.service.create(req.userContext.userId, body.config, body.parentId); }
  @NeedLogin() @Put(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: { config: StrategyMandateInput; expectedRevision: number }) {
    return this.service.update(req.userContext.userId, id, body.expectedRevision, body.config);
  }
  @NeedLogin() @Post(':id/extract')
  extract(@Req() req: Request, @Param('id') id: string, @Body() body: { expectedRevision: number }) { return this.service.extract(req.userContext.userId, id, body.expectedRevision); }
  @NeedLogin() @Post(':id/rebind-profile')
  rebindProfile(@Req() req: Request, @Param('id') id: string, @Body() body: { expectedRevision: number; expectedProfileVersion: number }) {
    return this.service.rebindProfile(req.userContext.userId, id, body.expectedRevision, body.expectedProfileVersion);
  }
  @NeedLogin() @Post(':id/cancel-extraction')
  cancelExtraction(@Req() req: Request, @Param('id') id: string, @Body() body: { expectedRevision: number }) {
    return this.service.cancelExtraction(req.userContext.userId, id, body.expectedRevision);
  }
  @NeedLogin() @Post(':id/publish')
  publish(@Req() req: Request, @Param('id') id: string, @Body() body: { expectedRevision: number; expectedPublishedId: string | null; activateExecution?: boolean }) {
    return this.service.publish(req.userContext.userId, id, body.expectedRevision, body.expectedPublishedId, body.activateExecution === true);
  }
  @NeedLogin() @Post(':id/pause')
  pause(@Req() req: Request, @Param('id') id: string) { return this.service.pause(req.userContext.userId, id); }
}
