import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import type { StrategyDraftInput, StrategySourceInput } from '../../../shared/user-investment-strategy.interface';

@Controller('api/investment-strategies')
export class UserInvestmentStrategyController {
  constructor(private readonly service: UserInvestmentStrategyService) {}
  @NeedLogin() @Get()
  workspace(@Req() req: Request) { return this.service.workspace(req.userContext.userId); }
  @NeedLogin() @Get('history')
  history(@Req() req: Request, @Query('cursor') cursor?: string) { return this.service.history(req.userContext.userId, cursor); }
  @NeedLogin() @Get('drafts')
  drafts(@Req() req: Request, @Query('cursor') cursor?: string) { return this.service.drafts(req.userContext.userId, cursor); }
  @NeedLogin() @Post()
  create(@Req() req: Request, @Body() body: { content: StrategyDraftInput; parentId?: string }) { return this.service.create(req.userContext.userId, body.content, body.parentId); }
  @NeedLogin() @Post('source-preview')
  sourcePreview(@Req() req: Request, @Body() body: { source: StrategySourceInput; draftId?: string }) { return this.service.sourcePreview(req.userContext.userId, body.source, body.draftId); }
  @NeedLogin() @Post('import-source')
  importSource(@Req() req: Request, @Body() body: { source: StrategySourceInput }) { return this.service.importSource(req.userContext.userId, body.source); }
  @NeedLogin() @Get(':id')
  get(@Req() req: Request, @Param('id') id: string) { return this.service.get(req.userContext.userId, id); }
  @NeedLogin() @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) { return this.service.remove(req.userContext.userId, id); }
  @NeedLogin() @Get(':id/revisions')
  revisions(@Req() req: Request, @Param('id') id: string, @Query('before') before?: string) { return this.service.revisions(req.userContext.userId, id, before === undefined ? undefined : Number(before)); }
  @NeedLogin() @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: { expectedRevision: number; content: StrategyDraftInput }) {
    return this.service.update(req.userContext.userId, id, body.expectedRevision, body.content);
  }
  @NeedLogin() @Post(':id/add-source')
  addSource(@Req() req: Request, @Param('id') id: string, @Body() body: { expectedRevision: number; source: StrategySourceInput }) {
    return this.service.addSource(req.userContext.userId, id, body.expectedRevision, body.source);
  }
  @NeedLogin() @Post(':id/preview')
  preview(@Req() req: Request, @Param('id') id: string, @Body() body: { expectedRevision: number }) {
    return this.service.preview(req.userContext.userId, id, body.expectedRevision);
  }
  @NeedLogin() @Post(':id/prepare')
  prepare(@Req() req: Request, @Param('id') id: string, @Body() body: { expectedRevision: number; requestKey: string }) {
    return this.service.prepare(req.userContext.userId, id, body.expectedRevision, body.requestKey);
  }
  @NeedLogin() @Get(':id/preparation')
  preparation(@Req() req: Request, @Param('id') id: string, @Query('expectedRevision') expectedRevision?: string) {
    return this.service.preparation(req.userContext.userId, id, Number(expectedRevision));
  }
}
