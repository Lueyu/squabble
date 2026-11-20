/**
 * dashboard.controller.ts — 投资组合总览（Dashboard）REST 控制器，挂载于 /api/portfolio/dashboard。
 *
 * 职责边界：
 *  - 只暴露总览聚合与手动刷新端点：组合概览（按基准币种折算的总市值/成本/现金/
 *    盈亏/分组汇总）、每日盈亏时间序列、市场概览（指数观察值）、汇率刷新。
 *  - 聚合计算全部委托给 DashboardService / MarketOverviewService，不直接访问数据。
 * 上下游：
 *  - 上游：客户端 Dashboard 页调用；所有路由均要求登录。
 *  - 下游：调用 DashboardService（聚合/盈亏序列/汇率刷新）与
 *    MarketOverviewService（市场概览）。
 * 关键约定：
 *  - 基准币种 baseCurrency 省略时默认 'USD'；daily-pl 的 days 省略时默认 30。
 *  - market-overview 为公开指数观察值：只回传指数数据，不含任何持仓与账户信息。
 */
import { Controller, Get, Post, Query, Req } from '@nestjs/common';
import { NeedLogin } from '../../common/platform';
import type { Request } from 'express';
import { DashboardService } from './dashboard.service';
import { MarketOverviewService } from './market-overview.service';
import type { DashboardOverview, MarketOverviewResponse } from '@shared/api.interface';

/**
 * 总览页 REST 控制器，聚合计算委托给 DashboardService。
 */
@NeedLogin()
@Controller('api/portfolio/dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly marketOverviewService: MarketOverviewService,
  ) {}

  /**
   * 获取市场概览（公开指数观察值）。
   *
   * 方法+路径：GET /api/portfolio/dashboard/market-overview（需登录）。
   *
   * @returns 指数行情响应；不包含任何持仓或账户数据
   */
  @Get('market-overview')
  async getMarketOverview(): Promise<MarketOverviewResponse> {
    return this.marketOverviewService.getOverview();
  }

  /**
   * 返回投资组合总览：市值、成本、现金、盈亏、分组汇总，
   * 全部折算为请求指定的基准币种。
   *
   * 方法+路径：GET /api/portfolio/dashboard/overview?baseCurrency=（需登录）。
   *
   * @param req          已认证请求，携带 `req.userContext.userId`
   * @param baseCurrency 可选目标币种（省略时默认 USD）
   */
  @Get('overview')
  async getOverview(
    @Req() req: Request,
    @Query('baseCurrency') baseCurrency?: string,
  ): Promise<DashboardOverview> {
    const { userId } = req.userContext;
    return this.dashboardService.getOverview(userId, baseCurrency ?? 'USD');
  }

  /**
   * 返回最近 N 天的每日盈亏时间序列。
   *
   * 方法+路径：GET /api/portfolio/dashboard/daily-pl?days=&baseCurrency=（需登录）。
   *
   * @param req          已认证请求
   * @param days         可选天数（省略时默认 30）
   * @param baseCurrency 可选目标币种（省略时默认 USD）
   */
  @Get('daily-pl')
  async getDailyPl(
    @Req() req: Request,
    @Query('days') days?: string,
    @Query('baseCurrency') baseCurrency?: string,
  ): Promise<{ date: string; accountValue: string; dailyPl: string; dailyPct: string }[]> {
    const { userId } = req.userContext;
    const daysNum = days ? parseInt(days, 10) : 30;
    return this.dashboardService.getDailyPlSeries(userId, daysNum, baseCurrency ?? 'USD');
  }

  /**
   * 手动从上游汇率源刷新汇率。
   *
   * 方法+路径：POST /api/portfolio/dashboard/refresh-rates（需登录）。
   */
  @Post('refresh-rates')
  async refreshRates(): Promise<{ ok: true }> {
    await this.dashboardService.refreshRates();
    return { ok: true };
  }
}
