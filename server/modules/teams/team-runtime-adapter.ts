import { Injectable, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { modelConnections } from '../../database/model-connections.schema';
import type { TeamDatabase } from '../../database/team-context';
import { CouncilService } from '../council/council.service';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { executionReadiness } from '../local-agents/execution-readiness';
import { parseNativeAgentConfiguration } from '../local-agents/local-agents.requests';
import { canonicalHash } from './team-contract';
import type { TeamRole, TeamConnectionCheck, TeamExecutionContext, RecoveryInput } from '../../../shared/team-workspace.interface';
import { lockAgentRosterOwner, readAgentRosterVersion } from '../../database/agent-roster-context';
import { teamSourceGrants } from '../../database/teams.schema';
import { a2aAgentConnections } from '../../database/a2a-agents.schema';
import { readA2aConnectionFingerprint } from '../../database/a2a-agent-context';
import type { ResearchSourceRef } from '../../../shared/team-workspace.interface';
@Injectable()
export class TeamRuntimeAdapter {
    constructor(private readonly council: CouncilService,
    @Optional()
    private readonly locals?: LocalAgentsService) { }
    async check(tx: TeamDatabase, owner: string, roles: TeamRole[]): Promise<TeamConnectionCheck[]> {
        const results: TeamConnectionCheck[] = [];
        for (const role of roles) {
            const base = { roleId: role.id, checkedAt: new Date().toISOString(), fingerprint: null, capabilities: [], evidence: 'No executor configured' };
            if (!role.executor) {
                results.push({ ...base, status: 'unsupported' });
                continue;
            }
            if (role.agentId || role.agentVersionId) {
                if (!role.agentId || !role.agentVersionId) throw new Error('TEAM_REFERENCE_NOT_FOUND');
                await lockAgentRosterOwner(tx, owner);
                const grants = await tx.select().from(teamSourceGrants).where(eq(teamSourceGrants.ownerId, owner));
                const sources = role.sourceGrantIds.map(id => grants.find(grant => grant.id === id && grant.state === 'active'));
                if (sources.some(source => !source)) throw new Error('TEAM_SCOPE_REVOKED');
                const { version } = await readAgentRosterVersion(tx, owner, role.agentId, role.agentVersionId, { allowedToolIds: role.allowedToolIds,
                    sourceRefs: sources.map(source => ({ kind: source!.sourceKind as ResearchSourceRef['kind'], id: source!.sourceId, revision: source!.sourceRevision, availability: 'available' })) });
                const pinned = version.config.executor;
                let matches = false;
                if (pinned.executionMode === 'model' && role.executor.executionMode === 'model') {
                    const [connection] = pinned.connectionId ? await tx.select().from(modelConnections).where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, pinned.connectionId))) : [];
                    matches = Boolean(connection && pinned.connectionId === role.executor.connectionId && pinned.model === (role.executor.tier ?? 'slow')
                        && role.executor.model === (pinned.model === 'fast' ? connection.fastModel : connection.slowModel) && !Object.keys(role.executor.settings).length);
                } else if (pinned.executionMode === 'local' && role.executor.executionMode === 'local') {
                    matches = pinned.localAgentId === role.executor.localAgentId && canonicalHash(pinned.settings ?? {}) === canonicalHash(role.executor.settings);
                } else if (pinned.executionMode === 'a2a' && role.executor.executionMode === 'a2a') {
                    matches = pinned.connectionId === role.executor.connectionId;
                }
                if (!matches) throw new Error('TEAM_CAPABILITY_UNAVAILABLE');
            }
            if (role.executor.executionMode === 'model') {
                if (Object.keys(role.executor.settings).length) {
                    results.push({ ...base, status: 'unsupported', evidence: 'This API adapter does not support additional per-role model settings' });
                    continue;
                }
                const [connection] = await tx.select().from(modelConnections).where(and(eq(modelConnections.owner, owner), eq(modelConnections.id, role.executor.connectionId)));
                if (connection && role.executor.model !== (role.executor.tier === 'fast' ? connection.fastModel : connection.slowModel)) {
                    results.push({ ...base, status: 'unsupported', evidence: 'Choose the explicitly configured model for this connection tier' });
                    continue;
                }
                results.push(connection ? { ...base, status: 'supported', fingerprint: canonicalHash({ id: connection.id, updatedAt: connection.updatedAt, model: role.executor.model, settings: role.executor.settings }),
                    capabilities: ['structured_delivery', 'structured_review', 'team_scope', 'durable_attempt'], evidence: 'Configured API adapter; no model request was sent' } : { ...base, status: 'offline', evidence: 'Owned model connection is unavailable' });
            }
            else if (role.executor.executionMode === 'a2a') {
                const [connection] = await tx.select().from(a2aAgentConnections).where(and(eq(a2aAgentConnections.owner, owner), eq(a2aAgentConnections.id, role.executor.connectionId)));
                if (!connection || connection.status !== 'enabled') {
                    results.push({ ...base, status: 'offline', evidence: 'The owned A2A connection is disabled or unavailable' });
                    continue;
                }
                if (!connection.capabilities.structuredOutputVerified) {
                    results.push({ ...base, status: 'unsupported', evidence: 'Complete a structured research reply with this external friend before assigning team work or review' });
                    continue;
                }
                const fingerprint = await readA2aConnectionFingerprint(tx, owner, connection.id);
                results.push({ ...base, status: 'supported', fingerprint: canonicalHash(fingerprint),
                    capabilities: ['structured_delivery', 'structured_review', 'team_scope', 'durable_attempt', 'external_cost_unknown'],
                    evidence: 'A2A v1 JSON-RPC with observed JSON delivery; remote models, tools and billing remain unknown' });
            }
            else {
                const executor = role.executor;
                try {
                    parseNativeAgentConfiguration(executor.settings);
                }
                catch {
                    results.push({ ...base, status: 'unsupported', evidence: 'Native execution settings are unsupported' });
                    continue;
                }
                const local = (await this.locals?.status(owner))?.items.find(x => x.id === executor.localAgentId);
                const settings = { ...(typeof executor.settings.model === 'string' ? { model: executor.settings.model } : {}), ...(typeof executor.settings.reasoningEffort === 'string' ? { reasoningEffort: executor.settings.reasoningEffort } : {}) };
                const readiness = local ? executionReadiness(local, settings) : null;
                if (local && (!local.researchTools || local.researchTools.mode !== 'mcp' || local.researchTools.reason !== 'supported')) {
                    results.push({ ...base, status: 'unsupported', evidence: 'This local adapter has no verified isolated tool transport for private team sources' });
                    continue;
                }
                results.push(local && readiness?.executable ? { ...base, status: 'supported', fingerprint: canonicalHash({ id: local.id, version: local.version, settings, researchTools: local.researchTools }),
                    capabilities: ['structured_delivery', 'structured_review', 'team_scope', 'durable_attempt', 'external_cost_unknown'], evidence: 'Verified local adapter metadata; external billing remains unknown' }
                    : { ...base, status: local?.connected ? 'unknown' : 'offline', evidence: readiness?.state ?? 'Local connection unavailable' });
            }
        }
        return results;
    }
    prepare(tx: TeamDatabase, context: TeamExecutionContext) { return this.council.prepareTeamSessionInTransaction(tx, context); }
    start(owner: string, commandId: string, sessionId: string) { return this.council.runTeamSessionOnce(owner, commandId, sessionId); }
    cancel(owner: string, sessionId: string) { return this.council.cancelTeamSession(owner, sessionId); }
    recover(owner: string, sessionId: string, input: RecoveryInput) { return this.council.recoverTeamSession(owner, sessionId, input); }
}
