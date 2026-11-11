import { sourceFingerprint } from '../../database/team-source-context';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { TeamStore } from './team-store';
import { teamSourceGrants, teams } from '../../database/teams.schema';
import { parseTeam, requestKeySchema, revisionSchema, sourceRefSchema, teamError, uuidSchema, pageFields, decodeTeamCursor, encodeTeamCursor } from './team-contract';
import type { ResearchSourceRef, TeamSourceGrant } from '../../../shared/team-workspace.interface';
export function grantView(row: typeof teamSourceGrants.$inferSelect): TeamSourceGrant {
    return { id: row.id, teamId: row.teamId, sourceRef: { kind: row.sourceKind as ResearchSourceRef['kind'], id: row.sourceId, revision: row.sourceRevision, availability: row.state === 'active' ? 'available' : 'revoked' },
        state: row.state as 'active' | 'revoked', grantedAt: row.grantedAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null, reason: row.reason };
}
@Injectable()
export class TeamSourceAccessService {
    constructor(private readonly store: TeamStore) { }
    async list(owner: string, id: string, query: unknown = {}) {
        await this.store.detail(owner, id);
        const request = parseTeam(z.object(pageFields).strict(), query), cursor = decodeTeamCursor(request.cursor);
        const rows = await this.store.db.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, id), cursor ? sql `(${teamSourceGrants.grantedAt},${teamSourceGrants.id})<(${cursor.at}::timestamptz,${cursor.id}::uuid)` : undefined)).orderBy(desc(teamSourceGrants.grantedAt), desc(teamSourceGrants.id)).limit(request.limit + 1);
        const items: TeamSourceGrant[] = [];
        for (const row of rows.slice(0, request.limit)) {
            const view = grantView(row);
            if (row.state === 'active')
                try {
                    await sourceFingerprint(this.store.db, owner, view.sourceRef);
                }
                catch {
                    view.sourceRef.availability = 'missing';
                }
            items.push(view);
        }
        const last = rows[request.limit - 1];
        return { items, nextCursor: rows.length > request.limit ? encodeTeamCursor({ id: last.id, createdAt: last.grantedAt }) : null };
    }
    async grant(owner: string, id: string, input: unknown) {
        const request = parseTeam(z.object({ requestKey: requestKeySchema, expectedScopeRevision: revisionSchema, sourceRef: sourceRefSchema }).strict(), input);
        return this.store.mutate(owner, id, 'source-grant', request, async (tx) => {
            const team = await this.store.team(tx, owner, id, true);
            this.store.revision(team.scopeRevision, request.expectedScopeRevision);
            await sourceFingerprint(tx, owner, request.sourceRef);
            const [prior] = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, id), eq(teamSourceGrants.sourceKind, request.sourceRef.kind), eq(teamSourceGrants.sourceId, request.sourceRef.id), eq(teamSourceGrants.sourceRevision, request.sourceRef.revision), eq(teamSourceGrants.state, 'active')));
            if (prior)
                return { grant: grantView(prior), scopeRevision: team.scopeRevision, requestKey: request.requestKey };
            const [grant] = await tx.insert(teamSourceGrants).values({ ownerId: owner, teamId: id, sourceKind: request.sourceRef.kind, sourceId: request.sourceRef.id, sourceRevision: request.sourceRef.revision, state: 'active', grantedBy: owner }).returning();
            await tx.update(teams).set({ scopeRevision: team.scopeRevision + 1, updatedAt: new Date() }).where(eq(teams.id, id));
            return { grant: grantView(grant), scopeRevision: team.scopeRevision + 1, requestKey: request.requestKey };
        });
    }
    async revoke(owner: string, id: string, grantId: string, input: unknown) {
        parseTeam(uuidSchema, grantId);
        const request = parseTeam(z.object({ requestKey: requestKeySchema, expectedScopeRevision: revisionSchema, reason: z.string().min(1).max(2000) }).strict(), input);
        return this.store.mutate(owner, id, 'source-revoke', request, async (tx) => {
            const team = await this.store.team(tx, owner, id);
            this.store.revision(team.scopeRevision, request.expectedScopeRevision);
            const [grant] = await tx.select().from(teamSourceGrants).where(and(eq(teamSourceGrants.ownerId, owner), eq(teamSourceGrants.teamId, id), eq(teamSourceGrants.id, grantId)));
            if (!grant)
                teamError('TEAM_REFERENCE_NOT_FOUND');
            const revision = team.scopeRevision + Number(grant.state === 'active');
            const [saved] = await tx.update(teamSourceGrants).set({ state: 'revoked', revokedAt: grant.revokedAt ?? new Date(), reason: request.reason }).where(eq(teamSourceGrants.id, grantId)).returning();
            await tx.update(teams).set({ scopeRevision: revision, updatedAt: new Date() }).where(eq(teams.id, id));
            return { grant: grantView(saved), scopeRevision: revision, requestKey: request.requestKey };
        }, { grantId });
    }
}
