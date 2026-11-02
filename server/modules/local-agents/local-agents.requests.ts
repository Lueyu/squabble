import { z } from 'zod';
import type { CompanionPoll, LocalAgentProvider, NativeAgentStatus } from '../../../shared/local-agents.interface';

export const providerCatalog: Record<LocalAgentProvider, Omit<NativeAgentStatus, 'state'>> = {
  codex: { provider: 'codex', name: 'Codex', loginCommand: 'codex login', installUrl: 'https://developers.openai.com/codex/cli/' },
  claude: { provider: 'claude', name: 'Claude Code', loginCommand: 'claude auth login', installUrl: 'https://code.claude.com/docs/en/setup' },
};
const provider = z.enum(['codex', 'claude']);
export const pairRequest = z.object({ code: z.string().regex(/^[a-f0-9]{48}$/u), name: z.string().trim().min(1).max(80) }).strict();
const pollRequest = z.object({
  agents: z.array(z.object({ provider, state: z.enum(['not_installed', 'login_required', 'ready', 'error']), version: z.string().max(120).optional() })).max(2),
  updates: z.array(z.object({ id: z.string().uuid(), state: z.enum(['running', 'completed', 'failed', 'cancelled']),
    progress: z.string().max(500).optional(), text: z.string().max(512_000).refine((value) => Buffer.byteLength(value) <= 512_000).optional(),
    usageTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional() }).strict()).max(16),
}).strict();
export function parseCompanionPoll(input: unknown): CompanionPoll {
  const value = pollRequest.parse(input);
  if (new Set(value.agents.map((agent) => agent.provider)).size !== value.agents.length) throw new Error('Duplicate provider');
  return { ...value, agents: value.agents.map((agent) => ({ ...providerCatalog[agent.provider], ...agent })) };
}
export function providerFromId(id: string, mode: 'native' | 'companion'): LocalAgentProvider {
  const match = /^(native|companion)-(codex|claude)$/u.exec(id);
  if (!match || match[1] !== mode) throw new Error('LOCAL_AGENT_NOT_FOUND');
  return match[2] as LocalAgentProvider;
}
