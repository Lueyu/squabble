import { HttpException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../common/platform';
import { agentRosterProfiles, agentRosterVersions } from './agent-roster.schema';
import { modelConnections } from './model-connections.schema';
import { readA2aConnectionFingerprint } from './a2a-agent-context';
import { sourceFingerprint } from './team-source-context';
import type { AgentResolveOptions, AgentVersionConfig } from '../../shared/agent-roster.interface';
import type { ResearchSourceRef } from '../../shared/team-workspace.interface';

export type AgentRosterDatabase = Pick<PostgresJsDatabase, 'select' | 'insert' | 'update' | 'execute'>;
export interface AgentRosterIdentity { rosterAgentId?: string; rosterAgentVersionId?: string }
/** Internal runtime option only. Callers must first verify an existing durable dispatch receipt. */
export interface AgentRosterExecutionOptions extends AgentResolveOptions { allowArchivedSettlement?: boolean }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(code: string, message = code): never {
  throw new HttpException({ code, message }, code === 'AGENT_NOT_FOUND' ? 404 : code === 'AGENT_INVALID_INPUT' ? 400 : 422);
}
function sourceKey(ref: ResearchSourceRef): string { return `${ref.kind}:${ref.id}:${ref.revision}`; }
function assertBounds(config: AgentVersionConfig, options: AgentResolveOptions): void {
  const sources = new Set(config.allowedSources.filter(ref => ref.availability === 'available').map(sourceKey));
  const canonicalToolId = (id: string) => id.startsWith('builtin:') ? id.slice('builtin:'.length) : id;
  const tools = new Set(config.allowedToolIds.map(canonicalToolId));
  if ((options.sourceRefs ?? []).some(ref => ref.availability !== 'available' || !sources.has(sourceKey(ref)))
    || (options.allowedToolIds ?? []).some(id => !tools.has(canonicalToolId(id))))
    fail('AGENT_SCOPE_DENIED', 'The task exceeds the pinned or current friend capability ceiling');
}

/** Shared by profile mutations and final runtime writes; acquire inside the write transaction. */
export async function lockAgentRosterOwner(tx: AgentRosterDatabase, owner: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${owner}, 734962))`);
}

/** Read a pinned identity under the caller's transaction lock; a new version never rewrites old capability. */
export async function readAgentRosterVersion(tx: AgentRosterDatabase, owner: string, agentId: string, versionId: string, options: AgentRosterExecutionOptions = {}) {
  if (!uuid.test(agentId) || !uuid.test(versionId)) fail('AGENT_INVALID_INPUT', 'Invalid persistent friend identity');
  const [profile] = await tx.select().from(agentRosterProfiles).where(and(eq(agentRosterProfiles.ownerId, owner), eq(agentRosterProfiles.id, agentId)));
  if (!profile) fail('AGENT_NOT_FOUND');
  if (profile.status !== 'active' && !(profile.status === 'archived' && options.allowArchivedSettlement))
    fail('AGENT_ARCHIVED', 'Choose an active friend before starting new work');
  const [version] = await tx.select().from(agentRosterVersions).where(and(eq(agentRosterVersions.ownerId, owner), eq(agentRosterVersions.agentId, agentId), eq(agentRosterVersions.id, versionId)));
  const [currentVersion] = await tx.select().from(agentRosterVersions).where(and(eq(agentRosterVersions.ownerId, owner), eq(agentRosterVersions.agentId, agentId), eq(agentRosterVersions.id, profile.currentVersionId)));
  if (!version || !currentVersion) fail('AGENT_NOT_FOUND', 'The exact capability version could not be found');
  assertBounds(version.config, options); assertBounds(currentVersion.config, options);
  if (options.dataCutoffAt && !Number.isFinite(Date.parse(options.dataCutoffAt))) fail('AGENT_INVALID_INPUT', 'Invalid source availability cutoff');
  try { for (const ref of options.sourceRefs ?? []) await sourceFingerprint(tx, owner, ref, options.dataCutoffAt); }
  catch { fail('AGENT_SOURCE_UNAVAILABLE', 'A task source is no longer authorized'); }
  if (version.config.executor.executionMode === 'a2a') {
    try { await readA2aConnectionFingerprint(tx, owner, version.config.executor.connectionId); }
    catch { fail('AGENT_EXECUTOR_UNAVAILABLE', 'The pinned external assistant connection is unavailable'); }
  }
  if (version.config.executor.executionMode === 'model' && version.config.executor.connectionId) {
    const [connection] = await tx.select({ id: modelConnections.id }).from(modelConnections).where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, version.config.executor.connectionId)));
    if (!connection) fail('AGENT_EXECUTOR_UNAVAILABLE', 'The pinned model connection is unavailable');
  }
  return { profile, version, currentVersion };
}

/**
 * Neutral final dispatch/acceptance/publication fence. Legacy records without roster fields remain readable.
 * Raw response/cost settlement is recorded outside this fence; it grants no new publication or application.
 */
export async function assertAgentRosterExecutionFence(tx: AgentRosterDatabase, owner: string, members: AgentRosterIdentity[], options: AgentRosterExecutionOptions = {}): Promise<void> {
  const selected = members.filter(member => member.rosterAgentId || member.rosterAgentVersionId);
  if (!selected.length) return;
  if (new Set(selected.map(member => member.rosterAgentId)).size !== selected.length) fail('AGENT_INVALID_INPUT', 'A friend cannot occupy two independent participant seats');
  await lockAgentRosterOwner(tx, owner);
  for (const member of selected) {
    if (!member.rosterAgentId || !member.rosterAgentVersionId) fail('AGENT_INVALID_INPUT', 'Both stable friend identity and exact capability version are required');
    await readAgentRosterVersion(tx, owner, member.rosterAgentId, member.rosterAgentVersionId, options);
  }
}
