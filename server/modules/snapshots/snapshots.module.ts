/**
 * snapshots.module.ts — 组装每日快照（Snapshots）功能模块。
 *
 * 职责边界：
 *  - 只负责注册快照功能的控制器与提供者，不承载业务逻辑。
 *  - 不直接调用上游行情/汇率源，汇率能力经由 FxModule 的 FxService 获得。
 * 上下游：
 *  - 上游：AppModule 注册本模块后，SnapshotsController 的路由才生效；
 *    SnapshotsService 亦被 agent 模块（agent.controller/agent.service）注入复用。
 *  - 下游：以 forwardRef(() => FxModule) 引入汇率模块（打破潜在循环依赖）。
 * 关键约定：
 *  - FxModule 必须经 forwardRef 延迟解析，不可改为直接 import，否则会形成循环依赖。
 */
import { Module, forwardRef } from '@nestjs/common';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';
import { FxModule } from '../fx/fx.module';

/** 快照功能的 NestJS 模块定义。 */
@Module({
  imports: [forwardRef(() => FxModule)],
  controllers: [SnapshotsController],
  providers: [SnapshotsService],
  exports: [SnapshotsService],
})
export class SnapshotsModule {}
