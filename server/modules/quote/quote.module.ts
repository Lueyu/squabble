/**
 * quote.module.ts — 组装行情（Quote）功能模块，是全仓行情能力的唯一出口。
 *
 * 职责边界：
 *  - 只负责注册行情功能的控制器与提供者，不承载业务逻辑。
 *  - 不管理汇率换算（见 fx 模块）与持久化快照（见 snapshots 模块）。
 * 上下游：
 *  - 上游：AppModule 注册本模块后，QuoteController 的路由才生效。
 *  - 下游：导入 QuoteService 的消费方共 10 个模块——dashboard、holdings、import、
 *    mcp、multi-agent、paper-trading、research-tools、settings、transactions、
 *    watchlist——全部经由本模块的 exports 获得注入。
 * 关键约定：
 *  - QuoteService 被大量模块复用（市场类型识别等），exports 不可移除。
 */
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { QuoteController } from './quote.controller';
import { QuoteService } from './quote.service';

/** 行情功能的 NestJS 模块定义。 */
@Module({
  imports: [HttpModule],
  controllers: [QuoteController],
  providers: [QuoteService],
  exports: [QuoteService],
})
export class QuoteModule {}
