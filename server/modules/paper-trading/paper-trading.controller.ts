/**
 * @file server/modules/paper-trading/paper-trading.controller.ts
 * @description Paper-trading API: overview, manual orders, bot control,
 * guardrail settings, account lifecycle.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import { PaperTradingService } from './paper-trading.service';
import type { CreatePaperOrderDto, PaperGuardrails } from '@shared/api.interface';

@Controller('api/paper')
export class PaperTradingController {
  constructor(private readonly paper: PaperTradingService) {}

  /** Full overview for the paper page (account, positions, curve, feeds). */
  @NeedLogin()
  @Get('overview')
  async overview(@Req() req: Request) {
    return this.paper.getOverview(req.userContext.userId);
  }

  /** Lazily create the caller's paper account. */
  @NeedLogin()
  @Post('account')
  async ensureAccount(@Req() req: Request) {
    return this.paper.ensureAccount(req.userContext.userId);
  }

  /** Reset the paper account (drops all paper data, fresh cash). */
  @NeedLogin()
  @Post('account/reset')
  async reset(@Req() req: Request, @Body() body: { initialCash?: number }) {
    return this.paper.resetAccount(req.userContext.userId, body.initialCash);
  }

  /** Mirror the caller's real portfolio into the paper account. */
  @NeedLogin()
  @Post('mirror-real')
  async mirrorReal(@Req() req: Request) {
    return this.paper.mirrorRealPortfolio(req.userContext.userId);
  }

  /** Place a manual order (market orders only in V1). */
  @NeedLogin()
  @Post('orders')
  async placeOrder(@Req() req: Request, @Body() dto: CreatePaperOrderDto) {
    return this.paper.placeOrder(req.userContext.userId, dto, 'manual');
  }

  /** Approve a pending agent order. */
  @NeedLogin()
  @Post('orders/:id/approve')
  async approveOrder(@Req() req: Request, @Param('id') id: string) {
    return this.paper.approveOrder(req.userContext.userId, id);
  }

  /** Reject a pending agent order. */
  @NeedLogin()
  @Post('orders/:id/reject')
  async rejectOrder(@Req() req: Request, @Param('id') id: string) {
    return this.paper.rejectOrder(req.userContext.userId, id);
  }

  /** Enable/disable the watchbot for the caller's account. */
  @NeedLogin()
  @Post('bot/toggle')
  async toggleBot(@Req() req: Request, @Body() body: { enabled?: boolean }) {
    return this.paper.toggleBot(req.userContext.userId, body.enabled ?? true);
  }

  /** Trigger one bot scan immediately (scheduler also runs periodically). */
  @NeedLogin()
  @Post('bot/run')
  async runBot(@Req() req: Request) {
    return this.paper.runBotScan(req.userContext.userId);
  }

  /** Update guardrail thresholds (loss limit / order caps). */
  @NeedLogin()
  @Put('guardrails')
  async updateGuardrails(@Req() req: Request, @Body() patch: Partial<PaperGuardrails>) {
    return this.paper.updateGuardrails(req.userContext.userId, patch);
  }
}
