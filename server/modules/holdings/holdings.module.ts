/**
 * holdings.module.ts — 组装持仓（Holdings）功能模块。
 *
 * 职责边界：
 *  - 只负责注册持仓功能的控制器与提供者，不承载业务逻辑。
 *  - 不直接调用上游行情源，市场类型识别复用 QuoteModule 的能力。
 * 上下游：
 *  - 上游：AppModule 注册本模块后，HoldingsController 的路由才生效。
 *  - 下游：引入 QuoteModule（用于 ticker 市场类型识别）；导出 HoldingsService
 *    供 agent-gateway（controller + module）复用持仓逻辑。
 * 关键约定：
 *  - 对 QuoteModule 的 import 路径写法为 './../quote/quote.module'（保持原样，不改写）。
 */
import { Module } from '@nestjs/common';
import { HoldingsController } from './holdings.controller';
import { HoldingsService } from './holdings.service';
import { QuoteModule } from './../quote/quote.module';

/** 持仓功能的 NestJS 模块定义。 */
@Module({
  imports: [QuoteModule],
  controllers: [HoldingsController],
  providers: [HoldingsService],
  exports: [HoldingsService],
})
export class HoldingsModule {}
