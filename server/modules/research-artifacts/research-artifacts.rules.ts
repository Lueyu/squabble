import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { researchSourcePolicies } from '../../database/research-artifacts.schema';
import type { AgentDataClass, AgentSourceVersionRef } from '../../../shared/agent-tooling.interface';

export type SourceDatabase = Pick<PostgresJsDatabase, 'select' | 'execute'>;
export interface InheritedPolicy { dataClasses: AgentDataClass[]; permittedUses: string[]; retentionUntil: string | null }
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_JSON');
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INVALID_JSON');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
export function hashContent(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function intersectUses(policies: string[][]): string[] {
  return policies.length ? [...new Set(policies[0])].filter(value => policies.every(policy => policy.includes(value))).sort() : [];
}
export function earliestRetention(values: Array<string | null>): string | null {
  const dates = values.filter((value): value is string => value !== null).map(value => {
    const time = Date.parse(value); if (!Number.isFinite(time)) throw new Error('INVALID_RETENTION'); return time;
  });
  return dates.length ? new Date(Math.min(...dates)).toISOString() : null;
}
export function sourceRefs(refs: AgentSourceVersionRef[]): AgentSourceVersionRef[] {
  const result = new Map<string, AgentSourceVersionRef>();
  for (const ref of refs) {
    if (!/^[a-f0-9]{64}$/u.test(ref.contentHash)) throw new Error('SOURCE_HASH_INVALID');
    const previous = result.get(ref.sourceVersionId);
    if (previous && canonicalJson(previous) !== canonicalJson(ref)) throw new Error('SOURCE_REFERENCE_CONFLICT');
    result.set(ref.sourceVersionId, ref);
  }
  return [...result.values()].sort((a, b) => a.sourceVersionId.localeCompare(b.sourceVersionId));
}
/** Locks exact existing source rows; a new latest version does not invalidate an older immutable version. */
export async function assertSourceVersions(db: SourceDatabase, owner: string,
  references: AgentSourceVersionRef[]): Promise<InheritedPolicy[]> {
  if (!owner?.trim()) throw new Error('OWNER_REQUIRED');
  const policies: InheritedPolicy[] = [];
  for (const ref of sourceRefs(references)) {
    const rows = await db.execute(sql`select s.id from data_library_sources s
      inner join data_library_versions v on v.source_id=s.id and v.owner=s.owner
      where s.id=${ref.sourceId}::uuid and v.id=${ref.sourceVersionId}::uuid and s.owner=${owner}
      and v.content_hash=${ref.contentHash} and s.enabled=true and s.deleted_at is null for share of s,v`);
    if (!rows.length) throw new Error('SOURCE_UNAVAILABLE');
    const [policy] = await db.select().from(researchSourcePolicies).where(and(
      eq(researchSourcePolicies.owner, owner), eq(researchSourcePolicies.sourceVersionId, ref.sourceVersionId))).for('share');
    if (policy?.revokedAt) throw new Error('SOURCE_REVOKED');
    if (policy?.retentionUntil && policy.retentionUntil.getTime() <= Date.now()) throw new Error('SOURCE_RETENTION_EXPIRED');
    policies.push({ dataClasses: policy?.dataClasses ?? ['private_material'],
      permittedUses: policy?.permittedUses ?? ['research'], retentionUntil: policy?.retentionUntil?.toISOString() ?? null });
  }
  return policies;
}
