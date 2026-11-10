import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../common/platform';
import type { DataLibraryReference } from '../../shared/data-library.interface';
import { dataLibrarySources, dataLibraryVersions } from './data-library.schema';

// Internal accumulated research provenance can span many tool calls. Public requests still cap at 30.
export const MAX_LIBRARY_EVIDENCE_REFERENCES = 1000;

/** Only server-projected provenance fields are inspected, never arbitrary content JSON. */
export function libraryEvidenceReferences(value: unknown): DataLibraryReference[] {
  const records = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const refs: DataLibraryReference[] = [];
  for (const item of records) {
    if (!item || typeof item !== 'object') continue;
    if ('libraryReferences' in item && item.libraryReferences !== undefined) {
      if (!Array.isArray(item.libraryReferences)) refs.push({ sourceId: 'invalid', versionId: 'invalid' });
      else for (const ref of item.libraryReferences) {
        refs.push(ref && typeof ref === 'object' && typeof ref.sourceId === 'string' && typeof ref.versionId === 'string'
          ? { sourceId: ref.sourceId, versionId: ref.versionId } : { sourceId: 'invalid', versionId: 'invalid' });
      }
    }
    if ('evidence' in item && Array.isArray(item.evidence)) refs.push(...libraryEvidenceReferences(item.evidence));
  }
  return [...new Map(refs.map(ref => [`${ref.sourceId}:${ref.versionId}`, ref])).values()];
}

/** Empty old snapshots require no new table. Locks are held by the caller's execution transaction. */
export async function libraryReferencesAvailable(database: Pick<PostgresJsDatabase, 'select'>, owner: string,
  references: DataLibraryReference[], lock = false): Promise<boolean> {
  const refs = [...new Map(references.map(ref => [`${ref.sourceId}:${ref.versionId}`, ref])).values()];
  if (!refs.length) return true;
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
  if (!owner || refs.length > MAX_LIBRARY_EVIDENCE_REFERENCES || refs.some(ref => !uuid.test(ref.sourceId) || !uuid.test(ref.versionId))) return false;
  const query = database.select({ sourceId: dataLibrarySources.id, versionId: dataLibraryVersions.id })
    .from(dataLibrarySources).innerJoin(dataLibraryVersions, and(eq(dataLibraryVersions.sourceId, dataLibrarySources.id),
      eq(dataLibraryVersions.owner, owner)))
    .where(and(eq(dataLibrarySources.owner, owner), isNull(dataLibrarySources.deletedAt),
      eq(dataLibrarySources.enabled, true), inArray(dataLibraryVersions.id, refs.map(ref => ref.versionId))));
  const rows = await (lock ? query.for('share') : query);
  return refs.every(ref => rows.some(row => row.sourceId === ref.sourceId && row.versionId === ref.versionId));
}

export function libraryEvidenceAvailable(database: Pick<PostgresJsDatabase, 'select'>, owner: string,
  evidence: unknown, lock = false): Promise<boolean> {
  return libraryReferencesAvailable(database, owner, libraryEvidenceReferences(evidence), lock);
}

/** Bulk read projection keeps the per-report bound without N+1 queries on old or repeated sources. */
export async function libraryEvidenceAvailability(database: Pick<PostgresJsDatabase, 'select'>, owner: string,
  reports: Array<{ id: string; evidence: unknown }>): Promise<Map<string, boolean>> {
  const references = reports.map(report => ({ id: report.id, refs: libraryEvidenceReferences(report.evidence) }));
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
  const valid = references.filter(report => report.refs.length <= MAX_LIBRARY_EVIDENCE_REFERENCES && report.refs.every(ref => uuid.test(ref.sourceId) && uuid.test(ref.versionId)));
  const ids = [...new Set(valid.flatMap(report => report.refs.map(ref => ref.versionId)))];
  const visible = new Set<string>();
  if (owner) for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = await database.select({ sourceId: dataLibrarySources.id, versionId: dataLibraryVersions.id })
      .from(dataLibrarySources).innerJoin(dataLibraryVersions, and(eq(dataLibraryVersions.sourceId, dataLibrarySources.id), eq(dataLibraryVersions.owner, owner)))
      .where(and(eq(dataLibrarySources.owner, owner), isNull(dataLibrarySources.deletedAt), eq(dataLibrarySources.enabled, true),
        inArray(dataLibraryVersions.id, ids.slice(offset, offset + 500))));
    rows.forEach(row => visible.add(`${row.sourceId}:${row.versionId}`));
  }
  const available = new Map(references.map(report => [report.id, false]));
  for (const report of valid) available.set(report.id, report.refs.every(ref => visible.has(`${ref.sourceId}:${ref.versionId}`)));
  return available;
}
