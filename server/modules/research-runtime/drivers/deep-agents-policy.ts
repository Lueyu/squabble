import type { AgentToolScope } from '../../../../shared/agent-tooling.interface';

export const DEEP_AGENTS_POLICY = Object.freeze({ version: '1', deepAgentsVersion: '1.16.4',
  langChainCoreVersion: '1.3.7', mode: 'read_only' as const, loopOwner: 'deep_agents' as const,
  modelRetries: 0, hostFilesystem: false, subagents: false, automaticSummarization: false,
  globalMemory: false, externalTracing: false, maxSteps: 6, maxToolsPerStep: 4, maxInvocations: 24 });

export function assertDeepAgentsEnvironment(): void {
  if ([process.env.LANGCHAIN_TRACING, process.env.LANGCHAIN_TRACING_V2, process.env.LANGSMITH_TRACING]
    .some(value => ['true', '1'].includes(value?.toLowerCase()))) throw new Error('DEEP_AGENT_EXTERNAL_TRACING_UNSUPPORTED');
}

/** Future delegation must reduce both permissions and budget; this driver does not enable it. */
export function assertChildAllocation(parent: AgentToolScope, child: AgentToolScope, parentSteps: number, childSteps: number): void {
  if (child.owner !== parent.owner || child.sessionId !== parent.sessionId || child.revision !== parent.revision
    || childSteps < 1 || childSteps >= parentSteps
    || child.allowedAccountIds.some(id => !parent.allowedAccountIds.includes(id))
    || child.allowedInstrumentIds.some(id => !parent.allowedInstrumentIds.includes(id))
    || child.allowedDataClasses.some(value => !parent.allowedDataClasses.includes(value))
    || child.sourceVersions.some(ref => !parent.sourceVersions.some(allowed => allowed.sourceVersionId === ref.sourceVersionId
      && allowed.sourceId === ref.sourceId && allowed.contentHash === ref.contentHash))) throw new Error('DEEP_AGENT_CHILD_SCOPE_ESCALATION');
}
