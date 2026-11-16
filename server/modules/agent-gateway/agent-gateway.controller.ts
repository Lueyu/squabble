/**
 * agent-gateway.controller.ts — 服务间网关控制器（Python 分析智能体专用）。
 *
 * 职责边界：
 *  - 暴露 /openapi/agent-gateway 下的服务间 API；每个路由经 AgentGatewayGuard（共享 x-agent-token）保护，
 *    而不是浏览器 @NeedLogin() 会话守卫。/openapi 前缀豁免浏览器 CSRF 双令牌中间件。
 *  - 明确的窄接口：智能体只能触达这里显式暴露的业务能力；复用既有属主隔离的 service，
 *    NestJS 应用保持鉴权/台账/风控规则/数据库结构的唯一权威。
 * 上下游：
 *  - 上游：Python 分析智能体（服务间调用）。
 *  - 下游：HoldingsService 等既有业务 service。
 * 关键约定：
 *  - 第 3 天只暴露一个只读能力（list holdings）；后续按需新增端点。
 */
import { Controller, Get, Req, UseGuards } from '@nestjs/common';

import { AgentGatewayGuard, AgentGatewayRequest } from '../../common/guards/agent-gateway.guard';
import { HoldingsService } from '../holdings/holdings.service';
import type { Holding, ListResponse } from '@shared/api.interface';

/**
 * 向已认证智能体暴露经挑选的业务数据子集。
 */
@Controller('openapi/agent-gateway')
@UseGuards(AgentGatewayGuard)
export class AgentGatewayController {
  constructor(private readonly holdingsService: HoldingsService) {}

  /**
   * GET /openapi/agent-gateway/holdings — 列出智能体所代理属主的持仓（网关令牌鉴权，只读）。
   *
   * @param req 经网关认证、携带 req.agentContext.userId 的请求。
   */
  @Get('holdings')
  async listHoldings(@Req() req: AgentGatewayRequest): Promise<ListResponse<Holding>> {
    const { userId } = req.agentContext!;
    return this.holdingsService.findAll(userId);
  }
}
