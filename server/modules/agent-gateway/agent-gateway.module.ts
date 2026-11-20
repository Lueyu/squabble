/**
 * agent-gateway.module.ts — 服务间智能体网关模块装配。
 *
 * 职责边界：
 *  - 导入 HoldingsModule 复用既有属主隔离的 HoldingsService，注册 AgentGatewayController
 *    （挂载在 /openapi/agent-gateway），并提供校验共享 x-agent-token 的 AgentGatewayGuard。
 * 上下游：
 *  - 上游：应用根模块装配。
 *  - 下游：HoldingsModule；AgentGatewayGuard 来自 common/guards。
 */
import { Module } from '@nestjs/common';

import { AgentGatewayController } from './agent-gateway.controller';
import { AgentGatewayGuard } from '../../common/guards/agent-gateway.guard';
import { HoldingsModule } from '../holdings/holdings.module';

/** 服务间智能体网关的 NestJS 模块。 */
@Module({
  imports: [HoldingsModule],
  controllers: [AgentGatewayController],
  providers: [AgentGatewayGuard],
})
export class AgentGatewayModule {}
