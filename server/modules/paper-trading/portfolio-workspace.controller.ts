import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { PortfolioWorkspaceService } from './portfolio-workspace.service';

@Controller('api/ai-investment/accounts')
export class PortfolioWorkspaceController {
  constructor(private readonly workspace: PortfolioWorkspaceService) {}
  @NeedLogin() @Get()
  list(@Req() req: Request) { return this.workspace.list(req.userContext.userId); }
  @NeedLogin() @Post()
  create(@Req() req: Request, @Body() input: unknown) { return this.workspace.create(req.userContext.userId, input); }
  @NeedLogin() @Get(':accountId')
  detail(@Req() req: Request, @Param('accountId') id: string) { return this.workspace.detail(req.userContext.userId, id); }
  @NeedLogin() @Patch(':accountId')
  rename(@Req() req: Request, @Param('accountId') id: string, @Body() input: unknown) { return this.workspace.rename(req.userContext.userId, id, input); }
  @NeedLogin() @Patch(':accountId/companion')
  companion(@Req() req: Request, @Param('accountId') id: string, @Body() input: unknown) { return this.workspace.setCompanion(req.userContext.userId, id, input); }
  @NeedLogin() @Post(':accountId/pause')
  pause(@Req() req: Request, @Param('accountId') id: string, @Body() input: unknown) { return this.workspace.switchStatus(req.userContext.userId, id, input, false); }
  @NeedLogin() @Post(':accountId/resume')
  resume(@Req() req: Request, @Param('accountId') id: string, @Body() input: unknown) { return this.workspace.switchStatus(req.userContext.userId, id, input, true); }
  @NeedLogin() @Post(':accountId/archive')
  archive(@Req() req: Request, @Param('accountId') id: string, @Body() input: unknown) { return this.workspace.archive(req.userContext.userId, id, input); }
  @NeedLogin() @Get(':accountId/strategies')
  strategies(@Req() req: Request, @Param('accountId') id: string) { return this.workspace.combination(req.userContext.userId, id); }
  @NeedLogin() @Post(':accountId/strategies/draft')
  draft(@Req() req: Request, @Param('accountId') id: string, @Body() input: unknown) { return this.workspace.saveDraft(req.userContext.userId, id, input); }
  @NeedLogin() @Post(':accountId/strategies/preview')
  preview(@Req() req: Request, @Param('accountId') id: string, @Body() input: unknown) { return this.workspace.preview(req.userContext.userId, id, input); }
  @NeedLogin() @Post(':accountId/strategies/apply')
  apply(@Req() req: Request, @Param('accountId') id: string, @Body() input: unknown) { return this.workspace.apply(req.userContext.userId, id, input); }
}
