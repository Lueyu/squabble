/**
 * fx.module.ts — 组装汇率（FX）功能模块。
 *
 * 职责边界：
 *  - 只负责注册汇率功能的控制器与提供者，不承载业务逻辑。
 *  - 不管理行情/持仓，仅覆盖汇率查询与刷新。
 * 上下游：
 *  - 上游：AppModule 注册本模块后，FxController 的 /api/fx 路由才生效。
 *  - 下游：引入 @nestjs/axios 的 HttpModule 供 FxService 调上游汇率源；
 *    导出 FxService 供 dashboard、snapshots、paper-trading、multi-agent
 *    （portfolio-context.service）等模块做多币种换算。
 * 关键约定：
 *  - FxService 被导出复用，因此本模块不能随意改名或移除 exports。
 */
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { FxController } from './fx.controller';
import { FxService } from './fx.service';

/** 汇率功能的 NestJS 模块定义。 */
@Module({
  imports: [HttpModule],
  controllers: [FxController],
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}
