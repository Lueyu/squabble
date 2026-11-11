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
