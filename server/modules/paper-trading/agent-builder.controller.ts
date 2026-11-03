import { BadRequestException, Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import type { BuilderConfig, RecordBuilderFillDto } from '@shared/api.interface';
import { AgentBuilderService } from './agent-builder.service';
import { PaperTradingService } from './paper-trading.service';
import { StrategyService } from './strategy.service';

/** Beginner-facing agent configuration and human execution ledger. */
@Controller('api/agent-builder')
export class AgentBuilderController {
  constructor(
    private readonly builder: AgentBuilderService,
    private readonly paper: PaperTradingService,
    private readonly strategy: StrategyService,
  ) {}

  @NeedLogin()
  @Get('profiles')
  async profiles(@Req() req: Request) {
    return { items: await this.builder.listProfiles(req.userContext.userId) };
  }

  @NeedLogin()
  @Post('preview')
  preview(@Body() body: { config: BuilderConfig }) {
    return this.builder.preview(body?.config);
  }

  @NeedLogin()
  @Post('profiles')
  create(@Req() req: Request, @Body() body: { config: BuilderConfig }) {
    return this.builder.createProfile(req.userContext.userId, body?.config);
  }

  @NeedLogin()
  @Put('profiles/:id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: { config: BuilderConfig }) {
    return this.builder.updateProfile(req.userContext.userId, id, body?.config);
  }

  @NeedLogin()
  @Post('profiles/:id/activate')
  async activate(@Req() req: Request, @Param('id') id: string) {
    const userId = req.userContext.userId;
    const profile = await this.builder.getProfile(userId, id);
    await this.builder.assertCanActivate(userId, profile.config);
    await this.paper.ensureAccount(userId);
    await this.paper.updateGuardrails(userId, {
      maxOrderPct: profile.config.maxOrderPct,
      dailyLossLimitPct: profile.config.dailyLossLimitPct,
      maxOrdersPerDay: profile.config.maxOrdersPerDay,
    });
    const active = await this.builder.activateProfile(userId, id);
    await this.paper.toggleBot(userId, true);
    return active;
  }

  @NeedLogin()
  @Post('profiles/:id/pause')
  async pause(@Req() req: Request, @Param('id') id: string) {
    const userId = req.userContext.userId;
    const current = await this.builder.getProfile(userId, id);
    const paused = await this.builder.pauseProfile(userId, id);
    if (current.status === 'active') await this.paper.toggleBot(userId, false);
    return paused;
  }

  @NeedLogin()
  @Post('profiles/:id/run')
  async run(@Req() req: Request, @Param('id') id: string) {
    const userId = req.userContext.userId;
    const active = await this.builder.getActiveProfile(userId);
    if (!active || active.id !== id) {
      throw new BadRequestException('Activate this agent before running a scan');
    }
    if (active.config.automation?.enabled) return { automation: true, runtime: await this.strategy.tick(userId),
      scanned: 0, signals: [], placed: 0, rejected: 0 };
    return this.paper.runBotScan(userId);
  }

  @NeedLogin()
  @Get('profiles/:id/automation')
  automation(@Req() req: Request, @Param('id') id: string) {
    return this.strategy.status(req.userContext.userId, id);
  }

  @NeedLogin()
  @Get('proposals')
  async proposals(@Req() req: Request) {
    return { items: await this.builder.listProposals(req.userContext.userId) };
  }

  @NeedLogin()
  @Post('proposals/:id/skip')
  skip(@Req() req: Request, @Param('id') id: string) {
    return this.builder.skipProposal(req.userContext.userId, id);
  }

  @NeedLogin()
  @Post('proposals/:id/fill')
  fill(@Req() req: Request, @Param('id') id: string, @Body() body: RecordBuilderFillDto) {
    return this.builder.recordFill(req.userContext.userId, id, body);
  }
}
