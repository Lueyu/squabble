import { Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { teams, teamDrafts, teamVersions } from '../../database/teams.schema';
import { TeamStore, versionView } from './team-store';
import { parseTeam, requestKeySchema, revisionSchema, teamError, EMPTY_CONFIG, EMPTY_LAYOUT, uuidSchema } from './team-contract';
import { displaySchema, layoutSchema, semanticSchema, normalizeSemanticConfig } from './team-graph';
import { teamCapabilities } from './team-config';
import type { TeamDetail, TeamLayout, TeamSemanticConfig, TeamDisplay, TeamListResult } from '../../../shared/team-workspace.interface';
import { TEAM_TEMPLATES } from '../../../shared/team-templates';
function copyConfig(config: TeamSemanticConfig, display: TeamDisplay, layout: TeamLayout) {
    const ids = new Map([...config.departments, ...config.roles, ...config.relations].map(n => [n.id, randomUUID()]));
    const remap = (id: string | null) => id ? ids.get(id) ?? null : null;
    return { config: { ...config, departments: config.departments.map(d => ({ ...d, id: ids.get(d.id)!, parentDepartmentId: remap(d.parentDepartmentId) })),
            roles: config.roles.map(r => ({ ...r, id: ids.get(r.id)!, departmentId: remap(r.departmentId), sourceGrantIds: [] })),
            relations: config.relations.map(r => ({ ...r, id: ids.get(r.id)!, fromRoleId: ids.get(r.fromRoleId)!, toRoleId: ids.get(r.toRoleId)! })),
            defaults: { ...config.defaults, leadRoleId: remap(config.defaults.leadRoleId) } },
        display: { ...display, departmentLabels: Object.fromEntries(Object.entries(display.departmentLabels).map(([k, v]) => [ids.get(k), v])),
            roleLabels: Object.fromEntries(Object.entries(display.roleLabels).map(([k, v]) => [ids.get(k), v])) },
        layout: { ...layout, positions: Object.fromEntries(Object.entries(layout.positions).filter(([k]) => ids.has(k)).map(([k, v]) => [ids.get(k), v])), collapsedDepartmentIds: layout.collapsedDepartmentIds.filter(id => ids.has(id)).map(id => ids.get(id)!) } };
}
@Injectable()
export class TeamsService {
    constructor(readonly store: TeamStore) { }
    detail(owner: string, id: string) { return this.store.detail(owner, id); }
    async list(owner: string, query: unknown): Promise<TeamListResult> {
        const q = parseTeam(z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30), status: z.enum(['active', 'archived']).optional(), q: z.string().max(100).optional(), filter: z.enum(['all', 'published', 'draft', 'unbound']).default('all') }).strict(), query);
        const capabilities = teamCapabilities();
        let cursor: {
            id: string;
            at: string;
        } | null = null;
        if (q.cursor) {
            try {
                cursor = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
                parseTeam(z.object({ id: uuidSchema, at: z.iso.datetime() }).strict(), cursor);
            }
            catch {
                teamError('TEAM_INVALID_INPUT', 'Invalid cursor');
            }
        }
        const conditions = [eq(teams.ownerId, owner)];
        if (q.status)
            conditions.push(eq(teams.status, q.status));
        if (q.q)
            conditions.push(ilike(teams.name, '%' + q.q + '%'));
        if (q.filter === 'unbound')
            conditions.push(sql `${teams.accountId} IS NULL`);
        if (q.filter === 'published')
            conditions.push(sql `${teams.currentVersionId} IS NOT NULL`);
        if (q.filter === 'draft')
            conditions.push(sql `EXISTS(SELECT 1 FROM team_drafts d WHERE d.team_id=${teams.id} AND NOT EXISTS(SELECT 1 FROM team_versions v WHERE v.id=${teams.currentVersionId} AND v.config_json=d.config_json))`);
        if (cursor)
            conditions.push(sql `(${teams.updatedAt},${teams.id}) < (${cursor.at}::timestamptz,${cursor.id}::uuid)`);
        const rows = await this.store.db.select().from(teams).where(and(...conditions)).orderBy(desc(teams.updatedAt), desc(teams.id)).limit(q.limit + 1);
        const items: TeamDetail[] = [];
        for (const row of rows.slice(0, q.limit))
            items.push(await this.store.detail(owner, row.id));
        const last = rows[q.limit - 1];
        return { items, nextCursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify({ id: last.id, at: last.updatedAt.toISOString() })).toString('base64url') : null, capabilities };
    }
    async create(owner: string, input: unknown) {
        const request = parseTeam(z.object({ requestKey: requestKeySchema, name: z.string().trim().min(1).max(80), description: z.string().max(2000).default(''), avatar: z.string().max(500).nullable().optional(), copyFromTeamVersionId: uuidSchema.optional(), templateId: z.string().max(80).optional() }).strict(), input);
        if (request.templateId && request.copyFromTeamVersionId)
            teamError('TEAM_INVALID_INPUT', 'Choose template or copy');
        return this.store.mutate(owner, null, 'create', request, async (tx) => {
            let config: TeamSemanticConfig = EMPTY_CONFIG, layout: TeamLayout = EMPTY_LAYOUT;
            let display: TeamDisplay = { name: request.name, avatar: request.avatar ?? null, departmentLabels: {}, roleLabels: {} };
            if (request.copyFromTeamVersionId) {
                const [v] = await tx.select().from(teamVersions).where(and(eq(teamVersions.ownerId, owner), eq(teamVersions.id, request.copyFromTeamVersionId)));
                if (!v)
                    teamError('TEAM_REFERENCE_NOT_FOUND');
                const [sourceTeam] = await tx.select().from(teams).where(and(eq(teams.ownerId, owner), eq(teams.id, v.teamId)));
                const copy = copyConfig(v.config, v.displaySnapshot, sourceTeam?.layout ?? EMPTY_LAYOUT);
                layout = copy.layout;
                config = copy.config;
                display = { ...copy.display, name: request.name, avatar: request.avatar ?? null };
            }
            if (request.templateId) {
                const template = TEAM_TEMPLATES.find(t => t.id === request.templateId);
                if (!template)
                    teamError('TEAM_REFERENCE_NOT_FOUND');
                const copy = copyConfig(template.config, template.display, template.layout);
                config = copy.config;
                layout = copy.layout;
                display = { ...copy.display, name: request.name, avatar: request.avatar ?? null };
            }
            const [team] = await tx.insert(teams).values({ ownerId: owner, name: request.name, description: request.description, avatar: request.avatar ?? null, display, layout }).returning();
            await tx.insert(teamDrafts).values({ teamId: team.id, ownerId: owner, config: normalizeSemanticConfig(config) });
            return { ...await this.store.detail(owner, team.id, tx), requestKey: request.requestKey };
        });
    }
    async save(owner: string, id: string, kind: 'display' | 'layout' | 'draft', input: unknown) {
        const schemas = {
            display: z.object({ requestKey: requestKeySchema, expectedDisplayRevision: revisionSchema, display: displaySchema }).strict(),
            layout: z.object({ requestKey: requestKeySchema, expectedLayoutRevision: revisionSchema, layout: layoutSchema }).strict(),
            draft: z.object({ requestKey: requestKeySchema, expectedSemanticRevision: revisionSchema, config: semanticSchema }).strict(),
        };
        const request = parseTeam(schemas[kind] as z.ZodType<{
            requestKey: string;
        }>, input);
        return this.store.mutate(owner, id, kind, request, async (tx) => {
            const team = await this.store.team(tx, owner, id, true);
            const [draft] = await tx.select().from(teamDrafts).where(eq(teamDrafts.teamId, id));
            const data = request as Record<string, unknown>;
            if (kind === 'draft') {
                this.store.revision(draft.semanticRevision, Number(data.expectedSemanticRevision));
                const config = normalizeSemanticConfig(parseTeam(semanticSchema, data.config));
                await tx.update(teamDrafts).set({ config, semanticRevision: draft.semanticRevision + 1, updatedAt: new Date() }).where(eq(teamDrafts.teamId, id));
                await tx.update(teams).set({ updatedAt: new Date() }).where(eq(teams.id, id));
            }
            else {
                const known = new Set([...draft.config.departments, ...draft.config.roles].map(n => n.id));
                if (kind === 'display') {
                    this.store.revision(team.displayRevision, Number(data.expectedDisplayRevision));
                    const display = parseTeam(displaySchema, data.display);
                    if ([...Object.keys(display.roleLabels), ...Object.keys(display.departmentLabels)].some(k => !known.has(k)))
                        teamError('TEAM_INVALID_INPUT', 'Unknown label node');
                    await tx.update(teams).set({ display, name: display.name, avatar: display.avatar, displayRevision: team.displayRevision + 1, updatedAt: new Date() }).where(eq(teams.id, id));
                }
                else {
                    this.store.revision(team.layoutRevision, Number(data.expectedLayoutRevision));
                    const layout = parseTeam(layoutSchema, data.layout);
                    if ([...Object.keys(layout.positions), ...layout.collapsedDepartmentIds].some(k => !known.has(k)))
                        teamError('TEAM_INVALID_INPUT', 'Unknown layout node');
                    await tx.update(teams).set({ layout, layoutRevision: team.layoutRevision + 1, updatedAt: new Date() }).where(eq(teams.id, id));
                }
            }
            return { ...await this.store.detail(owner, id, tx), requestKey: request.requestKey };
        });
    }
    async versions(owner: string, id: string, versionId?: string, query: unknown = {}) {
        await this.store.detail(owner, id);
        const request = parseTeam(z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().positive().max(100).default(30) }).strict(), query);
        let before: number | undefined;
        if (request.cursor)
            try {
                before = parseTeam(z.object({ version: z.number().int().positive() }).strict(), JSON.parse(Buffer.from(request.cursor, 'base64url').toString())).version;
            }
            catch {
                teamError('TEAM_INVALID_INPUT', 'Invalid version cursor');
            }
        const rows = await this.store.db.select().from(teamVersions).where(and(eq(teamVersions.ownerId, owner), eq(teamVersions.teamId, id), versionId ? eq(teamVersions.id, parseTeam(uuidSchema, versionId)) : undefined, before ? sql `${teamVersions.version}<${before}` : undefined)).orderBy(desc(teamVersions.version)).limit(request.limit + 1);
        if (versionId) {
            if (!rows[0])
                teamError('TEAM_REFERENCE_NOT_FOUND');
            return versionView(rows[0]);
        }
        return { items: rows.slice(0, request.limit).map(versionView), nextCursor: rows.length > request.limit ? Buffer.from(JSON.stringify({ version: rows[request.limit - 1].version })).toString('base64url') : null };
    }
}
