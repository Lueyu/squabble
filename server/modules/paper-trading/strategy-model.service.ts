import { Injectable, Optional } from '@nestjs/common';
import { LlmService } from '../multi-agent/llm.service';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import type { CouncilMember } from '../../../shared/council.interface';
import { LlmBudgetService, type BudgetReservation } from '../llm-budget/llm-budget.service';
import { PortfolioResearchRouteService } from '../experience/portfolio-research-route.service';
import { extractResearchObject } from '../../../shared/research-reading';

/** One durable caller claim is required before entering this adapter. Never retry a paid request. */
@Injectable()
export class StrategyModelService {
  constructor(private readonly llm: LlmService, private readonly local: LocalAgentsService,
    @Optional() private readonly budgets?: LlmBudgetService,@Optional()private readonly routes?:PortfolioResearchRouteService) {}

  async json(owner: string, member: CouncilMember | undefined, taskId: string, purpose: string,
    prompt: string, shouldContinue: () => Promise<boolean>, fast: boolean, budgetTaskId = taskId): Promise<unknown> {
    if (!await shouldContinue()) throw new Error('Strategy profile is no longer active');
    if(!member&&this.routes){
      const selected=await this.routes.resolve(owner);
      if(!selected)throw new Error('No available strategy research member');
      member={id:'strategy-preparation',name:selected.label,role:'researcher',instructions:'',model:fast?'fast':'slow',
        ...(selected.route.mode==='local'?{executionMode:'local',agentId:selected.route.agentId,agentSettings:selected.route.agentSettings}
          :{executionMode:'model',connectionId:selected.connectionId})};
    }
    if (member?.executionMode === 'local') {
      if (!member.agentId) throw new Error('Native reviewer is unavailable');
      let reservation: BudgetReservation | undefined;
      try {
      const result = await this.local.execute(owner, { agentId: member.agentId, agentSettings: member.agentSettings,
        messageId: taskId, prompt: `Return only valid JSON. Do not submit any orders.\n${prompt}`,
        onDispatch: this.budgets ? async () => {
          if (!await shouldContinue()) throw new Error('Strategy profile changed');
          if (reservation) return;
          reservation = await this.budgets!.reserve(owner, { taskId: budgetTaskId, purpose,
            model: member.agentSettings?.model ?? member.agentId!, messages: [{ role: 'user', content: prompt }], maxOutputTokens: fast ? 1200 : 6000 });
        } : undefined,
        onTask: async () => undefined, onProgress: async () => undefined, shouldContinue });
      if (reservation) await this.budgets!.settle(owner, reservation.id);
      if (!await shouldContinue()) throw new Error('Strategy profile changed');
      const parsed=extractResearchObject(result.text);
      if(parsed.value===undefined)throw new Error('Local strategy result needs formatting');
      return parsed.value;
      } catch (error) { if (reservation) await this.budgets!.settle(owner, reservation.id, undefined, true).catch(() => undefined); throw error; }
    }
    const options = { connectionId: member?.connectionId, route: member ? { mode: 'api' as const } : undefined,
      taskId: budgetTaskId, purpose, retryPolicy: 'none' as const,
      maxOutputTokens: fast ? 1200 : 6000, shouldContinue };
    const messages = [{ role: 'system' as const, content: 'You assist with simulated PAPER trading. No real orders. Return strictly valid JSON; do not fabricate evidence or indicators.' },
      { role: 'user' as const, content: prompt }];
    const result = fast ? await this.llm.chatFastJSON(messages, owner, options)
      : await this.llm.chatSlowJSON(messages, owner, options);
    return result.data;
  }
}
