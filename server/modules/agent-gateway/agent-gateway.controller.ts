/**
 * Agent gateway controller.
 *
 * Service-to-service API consumed by the Python analysis agent under
 * `/openapi/agent-gateway`. Every route is protected by `AgentGatewayGuard`
 * (shared `x-agent-token`), not the browser `@NeedLogin()` session guard. The
 * `/openapi` prefix is exempt from the browser CSRF double-token middleware.
 *
 * This is an explicit, narrow surface: the agent can only reach the business
 * capabilities that are deliberately exposed here. Day 3 exposes a single
 * read-only capability (list holdings); more endpoints are added on demand and
 * reuse the existing owner-scoped services, so the NestJS app remains the single
 * authority for auth, ledger, risk rules and schema.
 */
import { Controller, Get, Req, UseGuards } from '@nestjs/common';

import { AgentGatewayGuard, AgentGatewayRequest } from '../../common/guards/agent-gateway.guard';
import { HoldingsService } from '../holdings/holdings.service';
import type { Holding, ListResponse } from '@shared/api.interface';

/**
 * Exposes a curated subset of business data to the authenticated agent.
 */
@Controller('openapi/agent-gateway')
@UseGuards(AgentGatewayGuard)
export class AgentGatewayController {
  constructor(private readonly holdingsService: HoldingsService) {}

  /**
   * Lists the holdings of the owner the agent is acting on behalf of.
   *
   * @param req Gateway-authenticated request carrying `agentContext.userId`.
   */
  @Get('holdings')
  async listHoldings(@Req() req: AgentGatewayRequest): Promise<ListResponse<Holding>> {
    const { userId } = req.agentContext!;
    return this.holdingsService.findAll(userId);
  }
}
