import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import type { TeamErrorCode } from '../../../shared/team-workspace.interface';
export function teamError(code: TeamErrorCode, message: string = code, details: Record<string, unknown> = {}): never {
    const status = code.includes('NOT_FOUND') ? 404 : ['TEAM_INVALID_INPUT', 'TEAM_GRAPH_INVALID'].includes(code) ? 400
        : code === 'TEAM_DEPENDENCY_UNAVAILABLE' ? 503
            : ['TEAM_CAPABILITY_UNAVAILABLE', 'TEAM_PLAN_INVALID', 'TEAM_SOURCE_UNAVAILABLE', 'TEAM_SCOPE_REVOKED', 'TEAM_BUDGET_BLOCKED'].includes(code) ? 422 : 409;
    throw new HttpException({ code, message, ...details }, status);
}
export function canonicalJson(value: unknown): string {
    if (value instanceof Date)
        return JSON.stringify(value.toISOString());
    if (Array.isArray(value))
        return '[' + value.map(canonicalJson).join(',') + ']';
    if (value !== null && typeof value === 'object')
        return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
    return JSON.stringify(value);
}
export function canonicalHash(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function parseTeam<T>(schema: z.ZodType<T>, input: unknown): T {
    const serialized = JSON.stringify(input);
    if (serialized && Buffer.byteLength(serialized) > 262144)
        teamError('TEAM_INVALID_INPUT', 'Request exceeds the size limit');
    function depth(value: unknown, level: number): void {
        if (level > 12)
            teamError('TEAM_INVALID_INPUT', 'JSON nesting exceeds the depth limit');
        if (value !== null && typeof value === 'object')
            for (const nested of Object.values(value))
                depth(nested, level + 1);
    }
    depth(input, 0);
    const result = schema.safeParse(input);
    if (!result.success)
        teamError('TEAM_INVALID_INPUT', result.error.issues[0]?.message, { issues: result.error.issues });
    return result.data;
}
export const uuidSchema = z.string().uuid();
export const requestKeySchema = z.string().trim().min(1).max(128);
export const revisionSchema = z.number().int().nonnegative();
export const pageFields = { cursor: z.string().max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) };
export function decodeTeamCursor(cursor: string | undefined): {
    id: string;
    at: string;
} | null {
    if (!cursor)
        return null;
    try {
        return parseTeam(z.object({ id: uuidSchema, at: z.iso.datetime() }).strict(), JSON.parse(Buffer.from(cursor, 'base64url').toString())) as {
            id: string;
            at: string;
        };
    }
    catch {
        teamError('TEAM_INVALID_INPUT', 'Invalid cursor');
    }
}
export function encodeTeamCursor(row: {
    id: string;
    createdAt: Date;
}): string { return Buffer.from(JSON.stringify({ id: row.id, at: row.createdAt.toISOString() })).toString('base64url'); }
export const confirmSchema = z.object({ requestKey: requestKeySchema, previewId: uuidSchema, previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const sourceRefSchema = z.object({ kind: z.enum(['report_version', 'thesis_version', 'document_version', 'data_snapshot']), id: z.string().min(1).max(128), revision: z.string().min(1).max(128), availability: z.enum(['available', 'revoked', 'deleted', 'missing']) }).strict();
export const moneySchema = z.object({ amount: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).max(60).nullable(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export function compareDecimal(a: string, b: string): number {
    const [ai, af = ''] = a.split('.'), [bi, bf = ''] = b.split('.');
    const scale = Math.max(af.length, bf.length);
    const av = BigInt(ai + af.padEnd(scale, '0')), bv = BigInt(bi + bf.padEnd(scale, '0'));
    return av < bv ? -1 : av > bv ? 1 : 0;
}
export const COMPILER_VERSION = 'team-plan-v2-member-scope';
export const EMPTY_CONFIG = { schemaVersion: 1 as const, departments: [], roles: [], relations: [], defaults: { leadRoleId: null, parallelism: 1 as const } };
export const EMPTY_LAYOUT = { schemaVersion: 1 as const, positions: {}, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 1 } };
