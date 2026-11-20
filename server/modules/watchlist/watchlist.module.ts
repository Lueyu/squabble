/**
 * watchlist.module.ts — 组装自选列表（Watchlist）功能模块。
 *
 * 职责边界：
 *  - 只负责注册自选功能的控制器与提供者，不承载业务逻辑。
 *  - 不直接调用上游行情源，ticker 市场识别复用 QuoteModule 能力。
 * 上下游：
 *  - 上游：AppModule 注册本模块后，WatchlistController 的路由才生效。
 *  - 下游：引入 QuoteModule（用于 ticker 市场类型识别）；WatchlistService
 *    未被其他模块导出复用（全仓 grep 无外部消费者），仅本模块内部使用。
 * 关键约定：
 *  - 对 QuoteModule 的 import 路径写法为 './../quote/quote.module'（保持原样，不改写）。
 */
import { Module } from '@nestjs/common';
import { WatchlistController } from './watchlist.controller';
import { WatchlistService } from './watchlist.service';
import { QuoteModule } from './../quote/quote.module';

/** 自选功能的 NestJS 模块定义。 */
@Module({
  imports: [QuoteModule],
  controllers: [WatchlistController],
  providers: [WatchlistService],
})
export class WatchlistModule {}
