import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, exists, ilike, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { agentRosterProfiles as profiles, agentRosterVersions as versions, agentRosterRequests as requests, agentRosterMemories as memories, agentRosterMemoryShares as shares } from '../../database/agent-roster.schema';
import { modelConnections } from '../../database/model-connections.schema';
import { a2aAgentConnections } from '../../database/a2a-agents.schema';
import { userApiSettings } from '../../database/schema';
import { teams, teamVersions, teamSourceGrants } from '../../database/teams.schema';
import { lockAgentRosterOwner, readAgentRosterVersion } from '../../database/agent-roster-context';
import { councilSessions } from '../../database/council.schema';
import { libraryEvidenceReferences } from '../../database/data-library-visibility';
import { sourceFingerprint } from '../../database/team-source-context';
import type { TeamDatabase } from '../../database/team-context';
import type { LocalAgentsService } from '../local-agents/local-agents.service';
import { assertA2aConnectionFingerprint, readA2aConnectionFingerprint } from '../../database/a2a-agent-context';
import { executionReadiness } from '../local-agents/execution-readiness';
import type { AgentProfile, AgentVersion, AgentExecutor, AgentSelection, AgentResolveOptions, AgentMemoryRecallOptions, AgentCouncilMember, AgentMemory, AgentMemoryScope, AgentTemplateId } from '../../../shared/agent-roster.interface';
import type { ResearchSourceRef } from '../../../shared/team-workspace.interface';
import type { CouncilMember } from '../../../shared/council.interface';
import type { LocalAgentConnection } from '../../../shared/local-agents.interface';
import { AGENT_TEMPLATES, LEGACY_AGENT_TEMPLATE_IDS, archiveSchema, assertCeiling, canonicalAgentToolId, parseCreate, parseRoster, prepareAgent, recommendedSchema, rosterError, rosterHash, scopeSchema, shareMemorySchema, snapshotMember, sourceKey, sourceSchema, updateSchema, uuid, writeMemorySchema } from './agent-roster.rules';
import { ensureBuiltinFriends } from '../../database/agent-roster-builtins';

type ProfileRow = typeof profiles.$inferSelect;
type VersionRow = typeof versions.$inferSelect;
type MemoryRow = typeof memories.$inferSelect;
type RosterDb = TeamDatabase;
type BuiltinExecutor = Exclude<AgentExecutor, { executionMode: 'a2a' }>;
export const AGENT_ROSTER_LOCAL_STATUS = 'AGENT_ROSTER_LOCAL_STATUS';
function versionView(row: VersionRow): AgentVersion { return { id: row.id, agentId: row.agentId, version: row.version, config: row.config, createdAt: row.createdAt.toISOString() }; }

const legacyModelExecutor: BuiltinExecutor = { executionMode: 'model', model: 'slow' };
const currentVersionJoin = and(eq(versions.ownerId, profiles.ownerId), eq(versions.agentId, profiles.id), eq(versions.id, profiles.currentVersionId));

function selectBuiltinExecutor(passedConnectionIds: string[], locals: LocalAgentConnection[], legacyAvailable: boolean): BuiltinExecutor | null {
  const routes: BuiltinExecutor[] = passedConnectionIds.map(connectionId => ({ executionMode: 'model', connectionId, model: 'slow' }));
  for (const item of locals) {
    if (executionReadiness(item).executable) routes.push({ executionMode: 'local', localAgentId: item.id });
  }
  if (routes.length) return routes.length === 1 ? routes[0] : null;
  return legacyAvailable ? legacyModelExecutor : null;
}

function sameExecutorRoute(left: AgentExecutor, right: BuiltinExecutor): boolean {
  if (left.executionMode === 'model' && right.executionMode === 'model') {
    return left.connectionId === right.connectionId && left.model === right.model;
  }
  return left.executionMode === 'local' && right.executionMode === 'local' && left.localAgentId === right.localAgentId
    && left.settings?.model === right.settings?.model && left.settings?.reasoningEffort === right.settings?.reasoningEffort;
}

function profileView(row: ProfileRow, version: VersionRow, configured: boolean, effectiveExecutor: AgentExecutor | null): AgentProfile {
  return { ...(version.config.origin === 'builtin' ? { origin: 'builtin' as const } : {}), ...(effectiveExecutor ? { effectiveExecutor } : {}),
    id: row.id, avatar: row.avatar, name: row.name, specialty: row.specialty, description: row.description, status: row.status as AgentProfile['status'], revision: row.revision,
    currentVersionId: row.currentVersionId, currentVersion: versionView(version), availability: configured ? 'configured' : 'unavailable',
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** Owns persistent identity and capability ceilings. Runtime authorization remains an intersection at every use. */
@Injectable()
export class AgentRosterService {
  constructor(@Inject(DRIZZLE_DATABASE) readonly db: PostgresJsDatabase,
    @Optional() @Inject(AGENT_ROSTER_LOCAL_STATUS) private readonly locals?: Pick<LocalAgentsService, 'status'>) { }

  templates() { return { items: AGENT_TEMPLATES }; }

  private async lock(tx: RosterDb, owner: string): Promise<void> {
    await lockAgentRosterOwner(tx, owner);
  }

  private async mutate<T>(owner: string, operation: string, input: { requestKey: string }, identity: unknown, action: (tx: RosterDb) => Promise<T>): Promise<T> {
    const { requestKey, ...body } = input;
    const inputHash = rosterHash({ operation, identity, body });
    return this.db.transaction(async tx => {
      await this.lock(tx, owner);
      const [prior] = await tx.select().from(requests).where(and(eq(requests.ownerId, owner), eq(requests.requestKey, requestKey)));
      if (prior) {
        if (prior.inputHash !== inputHash) rosterError('AGENT_REQUEST_KEY_CONFLICT', 'The request key was already used for different changes');
        return prior.result as T;
      }
      const result = JSON.parse(JSON.stringify(await action(tx))) as T;
      await tx.insert(requests).values({ ownerId: owner, requestKey, operation, inputHash, result });
      return result;
    });
  }

  private async row(tx: RosterDb, owner: string, id: string, active = false): Promise<ProfileRow> {
    parseRoster(uuid, id);
    const [row] = await tx.select().from(profiles).where(and(eq(profiles.ownerId, owner), eq(profiles.id, id)));
    if (!row) rosterError('AGENT_NOT_FOUND', 'This friend could not be found');
    if (active && row.status !== 'active') rosterError('AGENT_ARCHIVED', 'This friend is archived; choose an active friend');
    return row;
  }

  private async versionRow(tx: RosterDb, owner: string, agentId: string, versionId: string): Promise<VersionRow> {
    parseRoster(uuid, versionId);
    const [row] = await tx.select().from(versions).where(and(eq(versions.ownerId, owner), eq(versions.agentId, agentId), eq(versions.id, versionId)));
    if (!row) rosterError('AGENT_NOT_FOUND', 'This exact friend version could not be found');
    return row;
  }

  private checkRevision(row: ProfileRow, expected: number): void {
    if (row.revision !== expected) rosterError('AGENT_REVISION_CONFLICT', 'This friend changed; reload before saving', { actualRevision: row.revision });
  }

  private async executorAvailable(tx: RosterDb, owner: string, executor: AgentExecutor): Promise<boolean> {
    if (executor.executionMode === 'a2a') {
      try { await readA2aConnectionFingerprint(tx, owner, executor.connectionId); return true; } catch { return false; }
    }
    if (executor.executionMode === 'local') {
      const local = (await this.locals?.status(owner))?.items.find(item => item.id === executor.localAgentId);
      return Boolean(local && executionReadiness(local, executor.settings).executable);
    }
    if (executor.connectionId) {
      const [connection] = await tx.select({ id: modelConnections.id }).from(modelConnections).where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, executor.connectionId)));
      return Boolean(connection);
    }
    return this.legacyModelAvailable(tx, owner);
  }

  /** Check an executor from a server-created Council snapshot before accepting new work. */
  async assertFrozenExecutorAvailable(tx: RosterDb, owner: string, member: CouncilMember): Promise<void> {
    if (member.executionMode === 'a2a') {
      if (!member.connectionId || member.a2aFingerprint?.connectionId !== member.connectionId) {
        rosterError('AGENT_EXECUTOR_UNAVAILABLE', 'The saved external assistant does not match its connection fingerprint');
      }
      await assertA2aConnectionFingerprint(tx, owner, member.a2aFingerprint);
      return;
    }
    const executor: AgentExecutor | null = member.executionMode === 'local'
      ? member.agentId ? { executionMode: 'local', localAgentId: member.agentId, settings: member.agentSettings } : null
      : { executionMode: 'model', connectionId: member.connectionId, model: member.model };
    if (!executor || !await this.executorAvailable(tx, owner, executor)) {
      rosterError('AGENT_EXECUTOR_UNAVAILABLE', 'Repair this friend’s saved connection in Settings');
    }
  }

  private async legacyModelAvailable(tx: RosterDb, owner: string): Promise<boolean> {
    const [settings] = await tx.select({ key: userApiSettings.llmApiKeyEnc }).from(userApiSettings).where(eq(userApiSettings.owner, owner));
    return Boolean(settings?.key || process.env.DOUBAO_API_KEY);
  }

  private async assertExecutorReference(tx: RosterDb, owner: string, executor: AgentExecutor): Promise<void> {
    if (executor.executionMode === 'a2a') {
      if (!await this.executorAvailable(tx, owner, executor)) rosterError('AGENT_EXECUTOR_UNAVAILABLE', 'Choose an enabled external assistant connection');
      return;
    }
    if (executor.executionMode === 'model') {
      if (executor.connectionId && !await this.executorAvailable(tx, owner, executor)) rosterError('AGENT_EXECUTOR_UNAVAILABLE', 'Choose an existing model connection from Settings');
    } else {
      const local = (await this.locals?.status(owner))?.items.find(item => item.id === executor.localAgentId && item.connected);
      if (!local) rosterError('AGENT_EXECUTOR_UNAVAILABLE', 'Connect this local assistant in Settings first');
    }
  }

  private async assertSources(tx: RosterDb, owner: string, refs: ResearchSourceRef[], cutoff?: string): Promise<void> {
    try { for (const ref of refs) await sourceFingerprint(tx, owner, ref, cutoff); }
    catch { rosterError('AGENT_SOURCE_UNAVAILABLE', 'A saved source was removed or is no longer authorized; choose its current version'); }
  }

  private async rosterAvailability(tx: RosterDb, owner: string) {
    const [models, external, status, legacy] = await Promise.all([
      tx.select({ id: modelConnections.id, testState: modelConnections.testState }).from(modelConnections).where(eq(modelConnections.owner, owner)),
      tx.select({ id: a2aAgentConnections.id }).from(a2aAgentConnections)
        .where(and(eq(a2aAgentConnections.owner, owner), eq(a2aAgentConnections.status, 'enabled'))),
      this.locals?.status(owner),
      this.legacyModelAvailable(tx, owner),
    ]);
    const locals = status?.items ?? [];
    const modelIds = new Set(models.map(({ id }) => id));
    const testedModelIds = new Set(models.filter(model => model.testState === 'passed').map(({ id }) => id));
    const externalIds = new Set(external.map(({ id }) => id));
    const defaultExecutor = selectBuiltinExecutor([...testedModelIds], locals, legacy);
    function available(executor: AgentExecutor): boolean {
      if (executor.executionMode === 'model') return executor.connectionId ? modelIds.has(executor.connectionId) : legacy;
      if (executor.executionMode === 'a2a') return externalIds.has(executor.connectionId);
      const local = locals.find(item => item.id === executor.localAgentId);
      return Boolean(local && executionReadiness(local, executor.settings).executable);
    }

    // A null entry records conflicting runnable routes for this specialty.
    const savedRoutes = new Map<AgentTemplateId, BuiltinExecutor | null>();
    if (!defaultExecutor) {
      const specialty = sql<AgentTemplateId>`${versions.config}->>'templateId'`;
      const savedExecutor = sql<BuiltinExecutor>`${versions.config}->'executor'`;
      const candidates = await tx.select({ templateId: specialty, executor: savedExecutor })
        .from(profiles).innerJoin(versions, currentVersionJoin)
        .where(and(eq(profiles.ownerId, owner), this.legacyRecommendedCandidate(tx)))
        .groupBy(specialty, savedExecutor);
      for (const { templateId, executor } of candidates) {
        if (!available(executor)) continue;
        if (executor.executionMode === 'model' && executor.connectionId && !testedModelIds.has(executor.connectionId)) continue;
        const prior = savedRoutes.get(templateId);
        if (prior === undefined) {
          const route = executor.executionMode === 'local' && !executor.settings?.model && !executor.settings?.reasoningEffort
            ? { executionMode: 'local', localAgentId: executor.localAgentId } satisfies BuiltinExecutor
            : executor;
          savedRoutes.set(templateId, route);
        } else if (prior && !sameExecutorRoute(prior, executor)) {
          savedRoutes.set(templateId, null);
        }
      }
    }
    return { builtinFor: (templateId: AgentTemplateId) => defaultExecutor ?? savedRoutes.get(templateId) ?? null, available };
  }

  private async view(tx: RosterDb, owner: string, row: ProfileRow): Promise<AgentProfile> {
    const version = await this.versionRow(tx, owner, row.id, row.currentVersionId);
    const builtin = version.config.origin === 'builtin';
    const active = row.status === 'active';
    const effectiveExecutor = builtin && active ? (await this.rosterAvailability(tx, owner)).builtinFor(version.config.templateId) : null;
    const configured = active && (builtin ? Boolean(effectiveExecutor) : await this.executorAvailable(tx, owner, version.config.executor));
    return profileView(row, version, configured, effectiveExecutor);
  }

  async detail(owner: string, id: string): Promise<AgentProfile> { return this.view(this.db, owner, await this.row(this.db, owner, id)); }

  private legacyRecommendedCandidate(tx: RosterDb) {
    const builtin = alias(profiles, 'builtin_profile');
    const builtinVersion = alias(versions, 'builtin_version');
    const activeBuiltin = tx.select({ id: builtin.id }).from(builtin).innerJoin(builtinVersion, and(
      eq(builtinVersion.ownerId, builtin.ownerId), eq(builtinVersion.agentId, builtin.id), eq(builtinVersion.id, builtin.currentVersionId),
    )).where(and(
      eq(builtin.ownerId, profiles.ownerId), eq(builtin.status, 'active'),
      sql`${builtinVersion.config}->>'origin' = 'builtin'`,
      sql`${builtinVersion.config}->>'templateId' = ${versions.config}->>'templateId'`,
      sql`coalesce(${builtinVersion.config} #>> '{preferences,language}', 'zh-CN') = coalesce(${versions.config} #>> '{preferences,language}', 'zh-CN')`,
    ));
    // The receipt identifies an unedited batch preset even if historical catalog defaults differ.
    const originalReceipt = tx.select({ id: requests.id }).from(requests).where(and(
      eq(requests.ownerId, profiles.ownerId), eq(requests.operation, 'recommended'),
      sql`${requests.result} @> jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
        'id', ${profiles.id}, 'revision', ${profiles.revision}, 'currentVersionId', ${profiles.currentVersionId}
      )))`,
    ));
    return and(eq(profiles.status, 'active'), sql`${versions.config}->>'origin' IS DISTINCT FROM 'builtin'`,
      sql`${versions.config} #>> '{executor,executionMode}' IN ('model', 'local')`,
      exists(activeBuiltin), exists(originalReceipt),
    notExists(tx.select({ id: memories.id }).from(memories).where(and(eq(memories.ownerId, profiles.ownerId), eq(memories.agentId, profiles.id)))),
    notExists(tx.select({ id: shares.id }).from(shares).where(and(eq(shares.ownerId, profiles.ownerId), eq(shares.targetAgentId, profiles.id)))));
  }

  async list(owner: string, query: unknown = {}) {
    const q = parseRoster(z.object({ status: z.enum(['active', 'archived', 'all']).default('active'), q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(1000).optional() }).strict(), query);
    let cursor: { id: string; at: string } | undefined;
    if (q.cursor) {
      try { cursor = parseRoster(z.object({ id: uuid, at: z.iso.datetime() }).strict(), JSON.parse(Buffer.from(q.cursor, 'base64url').toString())); }
      catch { rosterError('AGENT_INVALID_INPUT', 'Invalid page cursor'); }
    }
    if (q.status !== 'archived') await this.db.transaction(tx => ensureBuiltinFriends(tx, owner));
    const availability = q.status === 'archived' ? null : await this.rosterAvailability(this.db, owner);
    const duplicateCandidate = availability ? this.legacyRecommendedCandidate(this.db) : sql`false`;
    const batchSize = Math.max(30, q.limit + 1);
    const page: { agent: AgentProfile; cursorAt: string }[] = [];
    // Read current versions with their profiles and scan past hidden presets before deciding whether another page exists.
    while (page.length <= q.limit) {
      const rows = await this.db.select({
        profile: profiles, version: versions, duplicateCandidate: sql<boolean>`(${duplicateCandidate})`,
        cursorAt: sql<string>`to_char(${profiles.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
        .from(profiles).innerJoin(versions, currentVersionJoin)
        .where(and(eq(profiles.ownerId, owner), q.status === 'all' ? undefined : eq(profiles.status, q.status),
          q.q ? ilike(profiles.name, '%' + q.q + '%') : undefined,
          cursor ? sql`(${profiles.updatedAt},${profiles.id})<(${cursor.at}::timestamptz,${cursor.id}::uuid)` : undefined))
        .orderBy(desc(profiles.updatedAt), desc(profiles.id)).limit(batchSize);
      for (const { profile, version, duplicateCandidate, cursorAt } of rows) {
        const active = profile.status === 'active';
        const isBuiltin = version.config.origin === 'builtin';
        const builtinExecutor = active ? availability?.builtinFor(version.config.templateId) : null;
        const effectiveExecutor = isBuiltin ? builtinExecutor ?? null : null;
        const configured = active && (isBuiltin ? Boolean(effectiveExecutor) : Boolean(availability?.available(version.config.executor)));
        if (duplicateCandidate && (!configured || (builtinExecutor && sameExecutorRoute(version.config.executor, builtinExecutor)))) continue;
        page.push({ agent: profileView(profile, version, configured, effectiveExecutor), cursorAt });
        if (page.length > q.limit) break;
      }
      const lastScanned = rows.at(-1);
      if (rows.length < batchSize || !lastScanned) break;
      cursor = { id: lastScanned.profile.id, at: lastScanned.cursorAt };
    }
    const last = page[q.limit - 1];
    return { items: page.slice(0, q.limit).map(({ agent }) => agent), nextCursor: page.length > q.limit && last
      ? Buffer.from(JSON.stringify({ id: last.agent.id, at: last.cursorAt })).toString('base64url') : null };
  }

  private async insert(tx: RosterDb, owner: string, input: Parameters<typeof prepareAgent>[0]): Promise<AgentProfile> {
    const prepared = prepareAgent(input), id = randomUUID(), versionId = randomUUID();
    await this.assertExecutorReference(tx, owner, prepared.config.executor);
    await this.assertSources(tx, owner, prepared.config.allowedSources);
    const [row] = await tx.insert(profiles).values({ id, ownerId: owner, avatar: prepared.avatar, name: prepared.name, specialty: prepared.specialty, description: prepared.description, currentVersionId: versionId }).returning();
    await tx.insert(versions).values({ id: versionId, ownerId: owner, agentId: id, version: 1, config: prepared.config });
    return this.view(tx, owner, row);
  }

  async create(owner: string, input: unknown): Promise<AgentProfile> {
    const request = parseCreate(input);
    return this.mutate(owner, 'create', request, null, tx => this.insert(tx, owner, request));
  }

  async recommended(owner: string, input: unknown) {
    const request = parseRoster(recommendedSchema, input);
    return this.mutate(owner, 'recommended', request, null, async tx => {
      const items: AgentProfile[] = [];
      for (const id of request.templateIds ?? LEGACY_AGENT_TEMPLATE_IDS) items.push(await this.insert(tx, owner, { templateId: id, executor: request.executor, preferences: { language: request.language ?? 'zh-CN' } }));
      return { items };
    });
  }

  async update(owner: string, id: string, input: unknown): Promise<AgentProfile> {
    const request = parseRoster(updateSchema, input);
    return this.mutate(owner, 'update', request, id, async tx => {
      const row = await this.row(tx, owner, id, true); this.checkRevision(row, request.expectedRevision);
      const prior = await this.versionRow(tx, owner, id, row.currentVersionId);
      if (prior.config.origin === 'builtin') rosterError('AGENT_BUILTIN_READ_ONLY', 'Built-in friends are read-only');
      const config = { ...prior.config, ...(request.templateId ? { templateId: request.templateId } : {}), ...(request.instructions ? { instructions: request.instructions } : {}),
        ...(request.executor ? { executor: request.executor } : {}), ...(request.allowedToolIds ? { allowedToolIds: request.allowedToolIds.map(canonicalAgentToolId) } : {}), ...(request.allowedSources ? { allowedSources: request.allowedSources } : {}),
        preferences: { ...prior.config.preferences, ...request.preferences } };
      let versionId = prior.id;
      if (rosterHash(config) !== rosterHash(prior.config)) {
        await this.assertExecutorReference(tx, owner, config.executor);
        await this.assertSources(tx, owner, config.allowedSources);
        versionId = randomUUID();
        await tx.insert(versions).values({ id: versionId, ownerId: owner, agentId: id, version: prior.version + 1, config });
      }
      const [updated] = await tx.update(profiles).set({ avatar: request.avatar ?? row.avatar, name: request.name ?? row.name, specialty: request.specialty ?? row.specialty, description: request.description ?? row.description,
        currentVersionId: versionId, revision: row.revision + 1, updatedAt: new Date() }).where(and(eq(profiles.ownerId, owner), eq(profiles.id, id))).returning();
      return this.view(tx, owner, updated);
    });
  }

  async archive(owner: string, id: string, input: unknown): Promise<AgentProfile> {
    const request = parseRoster(archiveSchema, input);
    return this.mutate(owner, 'archive', request, id, async tx => {
      const row = await this.row(tx, owner, id, true); this.checkRevision(row, request.expectedRevision);
      const version = await this.versionRow(tx, owner, id, row.currentVersionId);
      if (version.config.origin === 'builtin') rosterError('AGENT_BUILTIN_READ_ONLY', 'Built-in friends are read-only');
      const [updated] = await tx.update(profiles).set({ status: 'archived', revision: row.revision + 1, updatedAt: new Date() }).where(and(eq(profiles.ownerId, owner), eq(profiles.id, id))).returning();
      return this.view(tx, owner, updated);
    });
  }

  async version(owner: string, id: string, versionId: string): Promise<AgentVersion> {
    await this.row(this.db, owner, id);
    return versionView(await this.versionRow(this.db, owner, id, versionId));
  }

  async history(owner: string, id: string) {
    await this.row(this.db, owner, id);
    const rows = await this.db.select().from(versions).where(and(eq(versions.ownerId, owner), eq(versions.agentId, id))).orderBy(desc(versions.version)).limit(100);
    return { items: rows.map(versionView) };
  }

  async resolveMembers(owner: string, selections: AgentSelection[], options: AgentResolveOptions = {}): Promise<AgentCouncilMember[]> {
    return this.db.transaction(async tx => { await this.lock(tx, owner); return this.resolveMembersInTransaction(tx, owner, selections, options); });
  }

  /** Call inside the dispatch/publication transaction to keep the final authority check adjacent to its write. */
  async resolveMembersInTransaction(tx: RosterDb, owner: string, selections: AgentSelection[], options: AgentResolveOptions = {}): Promise<AgentCouncilMember[]> {
    parseRoster(z.array(z.object({ agentId: uuid, agentVersionId: uuid, memberId: z.string().min(1).max(100).optional(), role: z.enum(['researcher', 'challenger', 'manager']).optional() }).strict()).min(1).max(8), selections);
    if (new Set(selections.map(s => s.agentId)).size !== selections.length || new Set(selections.map(s => s.memberId ?? s.agentId)).size !== selections.length)
      rosterError('AGENT_INVALID_INPUT', 'Choose each friend only once in a discussion');
    parseRoster(z.array(sourceSchema).max(100), options.sourceRefs ?? []);
    const result: AgentCouncilMember[] = [];
    let availability: Awaited<ReturnType<AgentRosterService['rosterAvailability']>> | undefined;
    for (const selection of selections) {
      const { profile, version } = await readAgentRosterVersion(tx, owner, selection.agentId, selection.agentVersionId, options);
      const executor = version.config.origin === 'builtin'
        ? (availability ??= await this.rosterAvailability(tx, owner)).builtinFor(version.config.templateId)
        : version.config.executor;
      if (!executor) rosterError('AGENT_EXECUTOR_UNAVAILABLE', 'A built-in friend needs one unambiguous usable connection for personal research');
      if (version.config.origin !== 'builtin') {
        await this.assertExecutorReference(tx, owner, executor);
        if (!await this.executorAvailable(tx, owner, executor)) rosterError('AGENT_EXECUTOR_UNAVAILABLE', 'Repair this friend’s saved connection in Settings');
      }
      const member = snapshotMember(profile, { ...version, config: { ...version.config, executor } }, selection);
      if (executor.executionMode === 'a2a') member.a2aFingerprint = await readA2aConnectionFingerprint(tx, owner, executor.connectionId);
      result.push(member);
    }
    return result;
  }

  private async assertScope(tx: RosterDb, owner: string, input: AgentMemoryScope, refs: ResearchSourceRef[] = [], agentId?: string, agentVersionId?: string): Promise<void> {
    const scope = parseRoster(scopeSchema, input);
    if (scope.kind === 'team') {
      const [team] = await tx.select({ id: teams.id, currentVersionId: teams.currentVersionId }).from(teams).where(and(eq(teams.ownerId, owner), eq(teams.id, scope.teamId), eq(teams.status, 'active')));
      if (!team) rosterError('AGENT_SCOPE_DENIED', 'This team is unavailable');
      const [version] = team.currentVersionId ? await tx.select().from(teamVersions).where(and(eq(teamVersions.ownerId, owner), eq(teamVersions.teamId, scope.teamId), eq(teamVersions.id, team.currentVersionId))) : [];
      if (agentId && !version?.config.roles.some(role => role.participation === 'enabled' && role.agentId === agentId && (!agentVersionId || role.agentVersionId === agentVersionId)))
        rosterError('AGENT_SCOPE_DENIED', 'Invite this friend to the team’s published membership before sharing team memory');
      for (const ref of refs) {
        const [grant] = await tx.select({ id: teamSourceGrants.id }).from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, scope.teamId), eq(teamSourceGrants.sourceKind, ref.kind), eq(teamSourceGrants.sourceId, ref.id), eq(teamSourceGrants.sourceRevision, ref.revision), eq(teamSourceGrants.state, 'active')));
        if (!grant) rosterError('AGENT_SCOPE_DENIED', 'Sharing a memory does not grant its sources to this team');
      }
    } else if (scope.kind === 'conversation') {
      const [session] = await tx.select({ id: councilSessions.id, deletedAt: councilSessions.deletedAt, snapshot: councilSessions.profileSnapshot, resolvedReferences: councilSessions.resolvedReferences, evidence: councilSessions.evidenceSnapshot, teamCommissionId: councilSessions.teamCommissionId }).from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, scope.conversationId)));
      if (!session || session.deletedAt) rosterError('AGENT_SCOPE_DENIED', 'This conversation is unavailable');
      if (session.teamCommissionId) rosterError('AGENT_SCOPE_DENIED', 'Team work uses its team memory scope');
      if (agentId && !session.snapshot.council?.members.some(member => member.rosterAgentId === agentId && (!agentVersionId || member.rosterAgentVersionId === agentVersionId)))
        rosterError('AGENT_SCOPE_DENIED', 'Only a participant in this exact conversation can use its private memory');
      const reportRefs = new Set(session.resolvedReferences.map(ref => `report_version:${ref.versionId}:${ref.version}`));
      const libraryRefs = new Set(libraryEvidenceReferences(session.evidence).map(ref => ref.versionId));
      if (refs.some(ref => !reportRefs.has(sourceKey(ref)) && !(ref.kind === 'document_version' && libraryRefs.has(ref.id))))
        rosterError('AGENT_SCOPE_DENIED', 'The memory references sources outside this conversation’s fixed inputs');
    }
  }

  private async liveMemory(tx: RosterDb, owner: string, memory: MemoryRow, target: VersionRow, targetScope: AgentMemoryScope = memory.scope, cutoff?: string): Promise<boolean> {
    try {
      const source = await this.row(tx, owner, memory.agentId);
      const sourceVersion = await this.versionRow(tx, owner, source.id, source.currentVersionId);
      assertCeiling(sourceVersion.config.allowedSources, [], memory.sourceRefs, []);
      assertCeiling(target.config.allowedSources, [], memory.sourceRefs, []);
      await this.assertScope(tx, owner, memory.scope, memory.sourceRefs, memory.agentId);
      await this.assertScope(tx, owner, targetScope, memory.sourceRefs, target.agentId);
      await this.assertSources(tx, owner, memory.sourceRefs, cutoff);
      return true;
    } catch { return false; }
  }

  private memoryView(row: MemoryRow, targetAgentId: string, scope: AgentMemoryScope, shared = false): AgentMemory {
    return { id: row.id, agentId: targetAgentId, scope, content: row.content, origin: row.origin as AgentMemory['origin'], sourceRefs: row.sourceRefs, createdAt: row.createdAt.toISOString(),
      sharedFrom: shared ? { memoryId: row.id, agentId: row.agentId, scope: row.scope } : null };
  }

  async writeMemory(owner: string, id: string, input: unknown): Promise<AgentMemory> {
    const request = parseRoster(writeMemorySchema, input);
    return this.mutate(owner, 'memory-write', request, id, async tx => {
      const profile = await this.row(tx, owner, id, true); this.checkRevision(profile, request.expectedRevision);
      const version = await this.versionRow(tx, owner, id, profile.currentVersionId);
      await this.assertScope(tx, owner, request.scope, request.sourceRefs, id);
      assertCeiling(version.config.allowedSources, [], request.sourceRefs, []);
      await this.assertSources(tx, owner, request.sourceRefs);
      const [memory] = await tx.insert(memories).values({ ownerId: owner, agentId: id, scope: request.scope, content: request.content, origin: request.origin, sourceRefs: request.sourceRefs }).returning();
      return this.memoryView(memory, id, request.scope);
    });
  }

  async readMemory(owner: string, id: string, input: AgentMemoryScope, options: AgentResolveOptions = {}): Promise<{ items: AgentMemory[] }> {
    const scope = parseRoster(scopeSchema, input);
    const profile = await this.row(this.db, owner, id), version = await this.versionRow(this.db, owner, id, profile.currentVersionId);
    await this.assertScope(this.db, owner, scope, [], id);
    return this.readScopedMemory(this.db, owner, version, scope, options);
  }

  /** A runtime caller supplies the exact trusted scope and work-source intersection; no owner-wide fallback. */
  async readMemoryForExecution(tx: RosterDb, owner: string, selection: AgentSelection, input: AgentMemoryScope, inputOptions: AgentMemoryRecallOptions): Promise<{ items: AgentMemory[] }> {
    const options = parseRoster(z.object({ sourceRefs: z.array(sourceSchema).max(100), dataCutoffAt: z.iso.datetime(), allowedToolIds: z.array(z.string().min(1).max(160)).max(100).optional() }).strict(), inputOptions) as AgentMemoryRecallOptions;
    const scope = parseRoster(scopeSchema, input);
    await this.lock(tx, owner);
    const { version } = await readAgentRosterVersion(tx, owner, selection.agentId, selection.agentVersionId, options);
    await this.assertScope(tx, owner, scope, options.sourceRefs, selection.agentId, selection.agentVersionId);
    return this.readScopedMemory(tx, owner, version, scope, options);
  }

  private async readScopedMemory(tx: RosterDb, owner: string, version: VersionRow, scope: AgentMemoryScope, options: AgentResolveOptions): Promise<{ items: AgentMemory[] }> {
    const id = version.agentId;
    const own = await tx.select().from(memories).where(and(eq(memories.ownerId, owner), eq(memories.agentId, id), eq(memories.scope, scope))).orderBy(desc(memories.createdAt), desc(memories.id)).limit(100);
    const shared = await tx.select({ memory: memories }).from(shares).innerJoin(memories, and(eq(memories.ownerId, shares.ownerId), eq(memories.id, shares.memoryId)))
      .where(and(eq(shares.ownerId, owner), eq(shares.targetAgentId, id), eq(shares.targetScope, scope))).orderBy(desc(shares.createdAt), desc(shares.id)).limit(100);
    const items: AgentMemory[] = [];
    const requested = options.sourceRefs ? new Set(options.sourceRefs.map(sourceKey)) : null;
    for (const { memory, shared: wasShared } of [...own.map(memory => ({ memory, shared: false })), ...shared.map(row => ({ memory: row.memory, shared: true }))]) {
      if (options.dataCutoffAt && memory.createdAt.getTime() > Date.parse(options.dataCutoffAt)) continue;
      if (requested && memory.sourceRefs.some(ref => !requested.has(sourceKey(ref)))) continue;
      if (await this.liveMemory(tx, owner, memory, version, scope, options.dataCutoffAt)) items.push(this.memoryView(memory, id, scope, wasShared));
    }
    return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 100) };
  }

  async shareMemory(owner: string, id: string, memoryId: string, input: unknown) {
    const request = parseRoster(shareMemorySchema, input); parseRoster(uuid, memoryId);
    return this.mutate(owner, 'memory-share', request, { id, memoryId }, async tx => {
      const profile = await this.row(tx, owner, id, true); this.checkRevision(profile, request.expectedRevision);
      const target = await this.row(tx, owner, request.targetAgentId, true), targetVersion = await this.versionRow(tx, owner, target.id, target.currentVersionId);
      const [memory] = await tx.select().from(memories).where(and(eq(memories.ownerId, owner), eq(memories.agentId, id), eq(memories.id, memoryId)));
      if (!memory) rosterError('AGENT_NOT_FOUND', 'The original memory could not be found');
      await this.assertScope(tx, owner, request.targetScope, memory.sourceRefs, target.id);
      if (!await this.liveMemory(tx, owner, memory, targetVersion, request.targetScope)) rosterError('AGENT_SCOPE_DENIED', 'The original memory or its source is no longer authorized for this recipient');
      await tx.insert(shares).values({ ownerId: owner, memoryId, targetAgentId: target.id, targetScope: request.targetScope }).onConflictDoNothing();
      return { memory: this.memoryView(memory, target.id, request.targetScope, true), shared: true as const };
    });
  }
}
