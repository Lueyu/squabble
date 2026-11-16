/**
 * agent-builder.controller.ts — 新手向 agent 配置与人工执行台账控制器。
 *
 * 职责边界：
 *  - 提供 agent 配置（BuilderConfig）的 CRUD/激活/暂停/手动扫描，以及
 *    候选提案（proposals）的人工跳过与成交登记；不做信号计算或自动下单。
 * 上下游：
 *  - 上游（谁路由到这里）：前端 `/api/agent-builder/*` 请求（需要登录）。
 *  - 下游（本文件调用谁）：AgentBuilderService（配置与提案台账）、
 *    PaperTradingService（账户保障、护栏写入、bot 开关与扫描）。
 * 关键约定：
 *  - 激活配置时会把配置内的护栏阈值同步写入模拟账户（updateGuardrails）并自动开启 bot。
 *  - 手动扫描只允许对"当前激活中"的配置执行。
 *  - 报错文案保持既有英文（用户可见），不可改写。
 */
import { BadRequestException, Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import type { BuilderConfig, RecordBuilderFillDto } from '@shared/api.interface';
import { AgentBuilderService } from './agent-builder.service';
import { PaperTradingService } from './paper-trading.service';

/** 新手向 agent 配置与人工执行台账的 REST 控制器。 */
@Controller('api/agent-builder')
export class AgentBuilderController {
  constructor(
    private readonly builder: AgentBuilderService,
    private readonly paper: PaperTradingService,
  ) {}

  /**
   * GET /api/agent-builder/profiles — 列出当前用户的全部 agent 配置档案。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   * @returns `{ items: BuilderProfile[] }`。
   */
  @NeedLogin()
  @Get('profiles')
  async profiles(@Req() req: Request) {
    return { items: await this.builder.listProfiles(req.userContext.userId) };
  }

  /**
   * POST /api/agent-builder/preview — 预览一份配置（不落库，返回校验/展示结果）。
   *
   * 鉴权：需要登录。
   *
   * @param body `{ config: BuilderConfig }`。
   */
  @NeedLogin()
  @Post('preview')
  preview(@Body() body: { config: BuilderConfig }) {
    return this.builder.preview(body?.config);
  }

  /**
   * POST /api/agent-builder/profiles — 新建一份 agent 配置档案。
   *
   * 鉴权：需要登录。
   *
   * @param req  已通过鉴权的请求。
   * @param body `{ config: BuilderConfig }`。
   */
  @NeedLogin()
  @Post('profiles')
  create(@Req() req: Request, @Body() body: { config: BuilderConfig }) {
    return this.builder.createProfile(req.userContext.userId, body?.config);
  }

  /**
   * PUT /api/agent-builder/profiles/:id — 更新指定 agent 配置档案。
   *
   * 鉴权：需要登录。
   *
   * @param req   已通过鉴权的请求。
   * @param id    配置档案主键。
   * @param body  `{ config: BuilderConfig }`。
   */
  @NeedLogin()
  @Put('profiles/:id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: { config: BuilderConfig }) {
    return this.builder.updateProfile(req.userContext.userId, id, body?.config);
  }

  /**
   * POST /api/agent-builder/profiles/:id/activate — 激活指定配置并同步护栏、开启 bot。
   *
   * 鉴权：需要登录。
   *
   * 步骤：读取配置 → 校验可激活（assertCanActivate）→ 保障模拟账户存在 →
   * 把配置内的三项护栏阈值写入模拟账户 → 激活配置 → 打开 bot。
   *
   * @param req 已通过鉴权的请求。
   * @param id  配置档案主键。
   * @returns 激活后的配置档案。
   */
  @NeedLogin()
  @Post('profiles/:id/activate')
  async activate(@Req() req: Request, @Param('id') id: string) {
    const userId = req.userContext.userId;
    const profile = await this.builder.getProfile(userId, id);
    await this.builder.assertCanActivate(userId, profile.config);
    await this.paper.ensureAccount(userId);
    // 配置内的护栏阈值在激活时同步到模拟账户，保证两边一致。
    await this.paper.updateGuardrails(userId, {
      maxOrderPct: profile.config.maxOrderPct,
      dailyLossLimitPct: profile.config.dailyLossLimitPct,
      maxOrdersPerDay: profile.config.maxOrdersPerDay,
    });
    const active = await this.builder.activateProfile(userId, id);
    await this.paper.toggleBot(userId, true);
    return active;
  }

  /**
   * POST /api/agent-builder/profiles/:id/pause — 暂停指定配置；若此前处于激活态则顺带关闭 bot。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   * @param id  配置档案主键。
   * @returns 暂停后的配置档案。
   */
  @NeedLogin()
  @Post('profiles/:id/pause')
  async pause(@Req() req: Request, @Param('id') id: string) {
    const userId = req.userContext.userId;
    const current = await this.builder.getProfile(userId, id);
    const paused = await this.builder.pauseProfile(userId, id);
    // 只有"原本激活"的配置才需要关 bot，避免误关其他来源开启的 bot。
    if (current.status === 'active') await this.paper.toggleBot(userId, false);
    return paused;
  }

  /**
   * POST /api/agent-builder/profiles/:id/run — 对激活中的配置手动触发一次 bot 扫描。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   * @param id  配置档案主键（必须与当前激活配置一致）。
   * @throws BadRequestException 当目标配置不是当前激活配置时。
   */
  @NeedLogin()
  @Post('profiles/:id/run')
  async run(@Req() req: Request, @Param('id') id: string) {
    const userId = req.userContext.userId;
    // 仅允许对当前激活的配置手动扫描。
    const active = await this.builder.getActiveProfile(userId);
    if (!active || active.id !== id) {
      throw new BadRequestException('Activate this agent before running a scan');
    }
    return this.paper.runBotScan(userId);
  }

  /**
   * GET /api/agent-builder/proposals — 列出当前用户的候选提案（建议买入的标的清单）。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   * @returns `{ items: BuilderProposal[] }`。
   */
  @NeedLogin()
  @Get('proposals')
  async proposals(@Req() req: Request) {
    return { items: await this.builder.listProposals(req.userContext.userId) };
  }

  /**
   * POST /api/agent-builder/proposals/:id/skip — 跳过（放弃）一条候选提案。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   * @param id  提案主键。
   */
  @NeedLogin()
  @Post('proposals/:id/skip')
  skip(@Req() req: Request, @Param('id') id: string) {
    return this.builder.skipProposal(req.userContext.userId, id);
  }

  /**
   * POST /api/agent-builder/proposals/:id/fill — 为一条提案登记人工成交（执行台账）。
   *
   * 鉴权：需要登录。
   *
   * @param req  已通过鉴权的请求。
   * @param id   提案主键。
   * @param body 成交登记载荷（RecordBuilderFillDto）。
   */
  @NeedLogin()
  @Post('proposals/:id/fill')
  fill(@Req() req: Request, @Param('id') id: string, @Body() body: RecordBuilderFillDto) {
    return this.builder.recordFill(req.userContext.userId, id, body);
  }
}
