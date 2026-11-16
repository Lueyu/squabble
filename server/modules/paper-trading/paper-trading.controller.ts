/**
 * paper-trading.controller.ts — 模拟交易控制器。
 *
 * 职责边界：
 *  - 只做 HTTP 路由分发与委托，不直接访问数据库；模拟交易规则都在 PaperTradingService。
 * 上下游：
 *  - 上游（谁路由到这里）：前端 `/api/paper/*` 请求（需要登录）。
 *  - 下游（本文件调用谁）：PaperTradingService（账户、下单、bot 开关、护栏设置）。
 * 关键约定：
 *  - 每个路由单独挂 @NeedLogin()（类级未统一声明）。
 *  - 订单为市价单（V1 仅支持 manual 来源下单，agent 来源需经审批）。
 */
import { Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { PaperTradingService } from './paper-trading.service';
import type { CreatePaperOrderDto, PaperGuardrails } from '@shared/api.interface';

@Controller('api/paper')
export class PaperTradingController {
  constructor(private readonly paper: PaperTradingService) {}

  /**
   * GET /api/paper/overview — 模拟交易页全量总览（账户、持仓、收益曲线、事件流）。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   * @returns 总览数据（账户 + 持仓 + 曲线 + feeds）。
   */
  @NeedLogin()
  @Get('overview')
  async overview(@Req() req: Request) {
    return this.paper.getOverview(req.userContext.userId);
  }

  /**
   * POST /api/paper/account — 惰性创建当前用户的模拟交易账户（已存在则直接返回）。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   */
  @NeedLogin()
  @Post('account')
  async ensureAccount(@Req() req: Request) {
    return this.paper.ensureAccount(req.userContext.userId);
  }

  /**
   * POST /api/paper/account/reset — 重置模拟账户（清空全部模拟数据，重新注入初始现金）。
   *
   * 鉴权：需要登录。
   *
   * @param req  已通过鉴权的请求。
   * @param body `{ initialCash? }` 可选初始现金。
   */
  @NeedLogin()
  @Post('account/reset')
  async reset(@Req() req: Request, @Body() body: { initialCash?: number }) {
    return this.paper.resetAccount(req.userContext.userId, body.initialCash);
  }

  /**
   * POST /api/paper/orders — 手动下一笔订单（V1 仅支持市价单）。
   *
   * 鉴权：需要登录。
   *
   * @param req  已通过鉴权的请求。
   * @param dto  下单载荷（CreatePaperOrderDto）。
   */
  @NeedLogin()
  @Post('orders')
  async placeOrder(@Req() req: Request, @Body() dto: CreatePaperOrderDto) {
    return this.paper.placeOrder(req.userContext.userId, dto, 'manual');
  }

  /**
   * POST /api/paper/orders/:id/approve — 批准一笔待审批的 agent 订单。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   * @param id  订单主键。
   */
  @NeedLogin()
  @Post('orders/:id/approve')
  async approveOrder(@Req() req: Request, @Param('id') id: string) {
    return this.paper.approveOrder(req.userContext.userId, id);
  }

  /**
   * POST /api/paper/orders/:id/reject — 拒绝一笔待审批的 agent 订单。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   * @param id  订单主键。
   */
  @NeedLogin()
  @Post('orders/:id/reject')
  async rejectOrder(@Req() req: Request, @Param('id') id: string) {
    return this.paper.rejectOrder(req.userContext.userId, id);
  }

  /**
   * POST /api/paper/bot/toggle — 开/关当前用户账户的 watchbot。
   *
   * 鉴权：需要登录。
   *
   * @param req  已通过鉴权的请求。
   * @param body `{ enabled? }` 缺省视为开启。
   */
  @NeedLogin()
  @Post('bot/toggle')
  async toggleBot(@Req() req: Request, @Body() body: { enabled?: boolean }) {
    return this.paper.toggleBot(req.userContext.userId, body.enabled ?? true);
  }

  /**
   * POST /api/paper/bot/run — 立即触发一次 bot 扫描（调度器也会周期性执行）。
   *
   * 鉴权：需要登录。
   *
   * @param req 已通过鉴权的请求。
   */
  @NeedLogin()
  @Post('bot/run')
  async runBot(@Req() req: Request) {
    return this.paper.runBotScan(req.userContext.userId);
  }

  /**
   * PUT /api/paper/guardrails — 更新护栏阈值（亏损上限 / 单笔与累计下单上限）。
   *
   * 鉴权：需要登录。
   *
   * @param req   已通过鉴权的请求。
   * @param patch 部分护栏字段（Partial<PaperGuardrails>）。
   */
  @NeedLogin()
  @Put('guardrails')
  async updateGuardrails(@Req() req: Request, @Body() patch: Partial<PaperGuardrails>) {
    return this.paper.updateGuardrails(req.userContext.userId, patch);
  }
}
