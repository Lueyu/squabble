import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchMemories, researchMemoryEvidence, researchThesisEvidence, researchThesisVersions } from '../../database/research-memory.schema';
import { compareEvidence, evidenceVisibleAt, normalizeEvidenceMetadata } from './research-memory.temporal';
import type { CouncilReport } from '@shared/council.interface';
import type { ResearchEvidenceGraph, ThesisContent } from '@shared/research-memory.interface';

type WriteDb = Pick<PostgresJsDatabase, 'select' | 'insert'>;
type Memory = typeof researchMemories.$inferSelect;
export type EvidenceRow = typeof researchMemoryEvidence.$inferSelect;

export async function archiveEvidence(db: WriteDb, owner: string, memory: Memory, evidence: CouncilReport['evidence']): Promise<EvidenceRow[]> {
  if (!evidence.length) return [];
  return db.insert(researchMemoryEvidence).values(evidence.map(item => ({ owner, memoryId: memory.id,
    reportId: memory.reportId, reportVersion: memory.reportVersion, reportRevision: memory.reportRevision,
    evidenceId: item.id, metadata: normalizeEvidenceMetadata(item), ingestedAt: memory.createdAt }))).onConflictDoNothing().returning();
}

export async function bindThesisEvidence(db: WriteDb, owner: string, versionId: string, content: ThesisContent, evidence: EvidenceRow[]): Promise<void> {
  const refs = [...content.supportingEvidence.map(ref => ({ ...ref, role: 'support' as const })), ...(content.evidenceRelations ?? [])];
  const values = refs.flatMap(ref => {
    const source = evidence.find(row => row.evidenceId === ref.evidenceId && row.owner === owner);
    return source ? [{ owner, versionId, evidenceRecordId: source.id, role: ref.role }] : [];
  });
  if (values.length) await db.insert(researchThesisEvidence).values(values).onConflictDoNothing();
}

export async function evidenceComparisons(db: Pick<PostgresJsDatabase, 'select'>, owner: string, memory: Memory,
  local: EvidenceRow[], asOf: string, matchesSymbol: (ticker: string) => boolean): Promise<ResearchEvidenceGraph['comparisons']> {
  if (!local.some(row => row.metadata.sources.some(source => source.facts.length))) return [];
  const rows = await db.select({ evidence: researchMemoryEvidence, memory: researchMemories, ticker: councilSessions.ticker }).from(researchMemoryEvidence)
    .innerJoin(researchMemories, and(eq(researchMemories.id, researchMemoryEvidence.memoryId), eq(researchMemories.owner, owner)))
    .innerJoin(councilReports, and(eq(councilReports.id, researchMemoryEvidence.reportId), eq(councilReports.owner, owner),
      eq(councilReports.version, researchMemoryEvidence.reportVersion), eq(councilReports.revision, researchMemoryEvidence.reportRevision)))
    .innerJoin(councilSessions, and(eq(councilSessions.id, councilReports.sessionId), eq(councilSessions.owner, owner),
      eq(councilSessions.id, researchMemories.sessionId)))
    .where(and(eq(researchMemoryEvidence.owner, owner), eq(researchMemories.ticker, memory.ticker),
      eq(researchMemories.market, memory.market), eq(researchMemories.excluded, false), isNull(researchMemories.deletedAt)));
  const results: ResearchEvidenceGraph['comparisons'] = [];
  for (const left of local) for (const { evidence: right, memory: peer, ticker } of rows) {
    if (left.id === right.id || !matchesSymbol(ticker) || peer.reportCreatedAt.getTime() > Date.parse(asOf)
      || !evidenceVisibleAt(left.metadata, left.ingestedAt.toISOString(), asOf)
      || !evidenceVisibleAt(right.metadata, right.ingestedAt.toISOString(), asOf)) continue;
    for (const [leftSourceIndex, a] of left.metadata.sources.entries()) for (const [rightSourceIndex, b] of right.metadata.sources.entries())
      for (const [leftFactIndex, x] of a.facts.entries()) for (const [rightFactIndex, y] of b.facts.entries()) {
      const { kind } = compareEvidence({ source: a, fact: x }, { source: b, fact: y });
      if (['conflict', 'superseded', 'different_period'].includes(kind)) results.push({ left: left.id, right: right.id,
        leftSourceIndex, leftFactIndex, rightSourceIndex, rightFactIndex, kind });
    }
  }
  return [...new Map(results.map(result => [JSON.stringify(result), result])).values()];
}

export async function evidenceRelations(db: Pick<PostgresJsDatabase, 'select'>, owner: string, records: EvidenceRow[]): Promise<ResearchEvidenceGraph['relations']> {
  if (!records.length) return [];
  const rows = await db.select({ relation: researchThesisEvidence, version: researchThesisVersions }).from(researchThesisEvidence)
    .innerJoin(researchThesisVersions, and(eq(researchThesisVersions.id, researchThesisEvidence.versionId), eq(researchThesisVersions.owner, owner)))
    .where(eq(researchThesisEvidence.owner, owner));
  const ids = new Set(records.map(row => row.id));
  return rows.filter(row => ids.has(row.relation.evidenceRecordId)).map(({ relation, version }) => ({
    thesisId: version.thesisId, version: version.version, evidenceRecordId: relation.evidenceRecordId, role: relation.role }));
}
