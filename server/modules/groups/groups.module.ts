/**
 * groups.module.ts — 组装持仓分组（Groups）功能模块。
 *
 * 职责边界：
 *  - 只负责注册分组功能的控制器与提供者，不承载业务逻辑。
 *  - 不引入行情/汇率模块，分组数据本身不依赖实时行情。
 * 上下游：
 *  - 上游：AppModule 注册本模块后，GroupsController 的路由才生效。
 *  - 下游：仅注册 GroupsController 与 GroupsService；GroupsService 未被
 *    其他模块导出复用（全仓 grep 无外部消费者）。
 */
import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

/** 分组功能的 NestJS 模块定义。 */
@Module({
  controllers: [GroupsController],
  providers: [GroupsService],
})
export class GroupsModule {}
