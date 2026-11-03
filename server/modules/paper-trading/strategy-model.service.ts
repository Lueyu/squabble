import { Injectable } from '@nestjs/common';
import { LlmService } from '../multi-agent/llm.service';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import type { CouncilMember } from '../../../shared/council.interface';

/** One durable caller claim is required before entering this adapter. Never retry a paid request. */
@Injectable()
export class StrategyModelService {
  constructor(private readonly llm: LlmService, private readonly local: LocalAgentsService) {}

  async json(owner: string, member: CouncilMember | undefined, taskId: string, purpose: string,
    prompt: string, shouldContinue: () => Promise<boolean>, fast: boolean): Promise<unknown> {
    if (!await shouldContinue()) throw new Error('Strategy profile is no longer active');
    if (member?.executionMode === 'local') {
      if (!member.agentId) throw new Error('Native reviewer is unavailable');
      const result = await this.local.execute(owner, { agentId: member.agentId, agentSettings: member.agentSettings,
        messageId: taskId, prompt: `Return only valid JSON. Do not submit any orders.\n${prompt}`,
        onTask: async () => undefined, onProgress: async () => undefined, shouldContinue });
      if (!await shouldContinue()) throw new Error('Strategy profile changed');
      const text = result.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
      return JSON.parse(text) as unknown;
    }
    const options = { connectionId: member?.connectionId, taskId, purpose, retryPolicy: 'none' as const,
      maxOutputTokens: fast ? 1200 : 6000, shouldContinue };
    const messages = [{ role: 'system' as const, content: 'You assist with simulated PAPER trading. No real orders. Return strictly valid JSON; do not fabricate evidence or indicators.' },
      { role: 'user' as const, content: prompt }];
    const result = fast ? await this.llm.chatFastJSON(messages, owner, options)
      : await this.llm.chatSlowJSON(messages, owner, options);
    return result.data;
  }
}
