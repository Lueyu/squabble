/**
 * closed.module.ts — 已平仓（实现盈亏）功能模块。
 *
 * 职责边界：
 *  - 装配已平仓功能的控制器与服务，不承载业务逻辑。
 * 上下游：
 *  - 上游（谁加载本模块）：由 server 根模块按需引入。
 *  - 下游（本模块暴露给谁）：ClosedService 被 transactions 模块的对账逻辑复用。
 * 关键约定：
 *  - 通过 exports 导出 ClosedService，供其他模块（如 transactions）注入使用。
 */
import { Module } from '@nestjs/common';
import { ClosedController } from './closed.controller';
import { ClosedService } from './closed.service';

/** 已平仓功能的 NestJS 模块定义。 */
@Module({
  controllers: [ClosedController],
  providers: [ClosedService],
  exports: [ClosedService],
})
export class ClosedModule {}
