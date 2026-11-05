import { BadRequestException } from '@nestjs/common';
import type { ModelRoute } from '../../../shared/model-route.interface';
import { parseNativeAgentConfiguration } from '../local-agents/local-agents.requests';

export function parseModelRoute(input: unknown): ModelRoute {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('INVALID_MODEL_ROUTE');
  const row = input as Record<string, unknown>;
  if (row.mode === 'basic' || row.mode === 'api') {
    if (Object.keys(row).length !== 1) throw new BadRequestException('INVALID_MODEL_ROUTE');
    return { mode: row.mode };
  }
  if (row.mode !== 'local' || typeof row.agentId !== 'string' || !/^(native|companion)-[a-z0-9-]{1,80}$/u.test(row.agentId)
    || Object.keys(row).some(key => !['mode', 'agentId', 'agentSettings'].includes(key))) {
    throw new BadRequestException('INVALID_MODEL_ROUTE');
  }
  let agentSettings;
  try { agentSettings = parseNativeAgentConfiguration(row.agentSettings); }
  catch { throw new BadRequestException('LOCAL_INVALID_CONFIGURATION'); }
  return { mode: 'local', agentId: row.agentId, ...(agentSettings ? { agentSettings } : {}) };
}
