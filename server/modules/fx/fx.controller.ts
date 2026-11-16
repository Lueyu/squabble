/**
 * fx.controller.ts — 汇率（FX）REST 控制器，挂载于 /api/fx。
 *
 * 职责边界：
 *  - 只暴露汇率查询与手动刷新三个端点，参数校验与上游调用全部委托给 FxService。
 *  - 不直接访问数据库或上游 HTTP 服务。
 * 上下游：
 *  - 上游：客户端（多币种展示）调用；受 NeedLogin 保护。
 *  - 下游：调用 FxService（getLatestRate / getRatesForDate / refreshRates）。
 * 关键约定：
 *  - 全控制器级 @NeedLogin()：所有路由都要求已登录，防止匿名滥用上游汇率源。
 */
import { Controller, Get, Post, Query, NotFoundException } from '@nestjs/common';

import { FxService } from './fx.service';
import { NeedLogin } from '../../common/platform/need-login.decorator';
import type { FxRate } from '@shared/api.interface';

/** 通用列表响应包装。 */
interface ListResponse<T> {
  items: T[];
}

/**
 * 汇率 REST 控制器，业务逻辑委托给 FxService。
 */
@Controller('api/fx')
@NeedLogin()
export class FxController {
  constructor(private readonly fxService: FxService) {}

  /**
   * 查询指定基础/报价货币对的最新可用汇率。
   *
   * 方法+路径：GET /api/fx/latest?base=&quote=（需登录）。
   *
   * @param base  基础货币代码
   * @param quote 报价货币代码
   * @returns 最新汇率（字符串形式承载，避免浮点精度问题）
   * @throws NotFoundException 当无法解析出汇率时返回 404
   */
  @Get('latest')
  async getLatest(
    @Query('base') base: string,
    @Query('quote') quote: string,
  ): Promise<{ rate: string }> {
    const rate = await this.fxService.getLatestRate(base, quote);
    if (rate === null) {
      throw new NotFoundException(`Exchange rate not found for ${base}/${quote}`);
    }
    return { rate };
  }

  /**
   * 列出某个日期记录的全部汇率。
   *
   * 方法+路径：GET /api/fx/list?date=YYYY-MM-DD（需登录）。
   *
   * @param date 汇率日期（YYYY-MM-DD 格式）
   * @returns 该日期全部汇率记录的列表响应
   */
  @Get('list')
  async getList(@Query('date') date: string): Promise<ListResponse<FxRate>> {
    const items = await this.fxService.getRatesForDate(date);
    return { items };
  }

  /**
   * 手动从上游汇率源刷新今天的汇率。
   *
   * 方法+路径：POST /api/fx/refresh（需登录）。
   *
   * @returns 本次刷新 upsert 的汇率条数
   */
  @Post('refresh')
  async refresh(): Promise<{ updated: number }> {
    const updated = await this.fxService.refreshRates();
    return { updated };
  }
}
