import { councilReportSourceVisible } from '../../database/research-source-visibility';
import { libraryEvidenceAvailability } from '../../database/data-library-visibility';
import { isNull, and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchMemories, researchMemoryEvidence } from '../../database/research-memory.schema';
import { loadComparisonEvidence, type EvidenceRow } from './research-memory.evidence';

type Memory = typeof researchMemories.$inferSelect;
export interface MemorySources {
  reports: Map<string, typeof councilReports.$inferSelect>;
  evidence: Map<string, EvidenceRow[]>;
  peers: Awaited<ReturnType<typeof loadComparisonEvidence>>;
}

/** Constant query count for any number of candidate memories. All authority joins remain owner-scoped. */
export async function loadMemorySources(db: Pick<PostgresJsDatabase, 'select'>, owner: string, memories: Memory[],
  matchesSymbol: (memory: Memory, ticker: string) => boolean): Promise<MemorySources> {
  const result: MemorySources = { reports: new Map(), evidence: new Map(), peers: [] };
  if (!memories.length) return result;
  const sources = await db.select({ report: councilReports, ticker: councilSessions.ticker }).from(councilReports)
    .innerJoin(councilSessions, and(eq(councilReports.sessionId, councilSessions.id), isNull(councilSessions.deletedAt), eq(councilSessions.owner, owner)))
    .where(and(councilReportSourceVisible(), eq(councilReports.owner, owner), inArray(councilReports.id, memories.map(row => row.reportId))));
  const byId = new Map(sources.map(row => [row.report.id, row]));
  const libraryAvailable = await libraryEvidenceAvailability(db, owner, sources.map(row => ({ id: row.report.id, evidence: row.report.evidence })));
  for (const memory of memories) {
    const source = byId.get(memory.reportId);
    if (source && libraryAvailable.get(source.report.id) !== false && source.report.sessionId === memory.sessionId && source.report.version === memory.reportVersion
      && source.report.revision === memory.reportRevision && matchesSymbol(memory, source.ticker)) result.reports.set(memory.id, source.report);
  }
  const records = await db.select().from(researchMemoryEvidence).where(and(eq(researchMemoryEvidence.owner, owner),
    inArray(researchMemoryEvidence.memoryId, memories.map(row => row.id))));
  for (const record of records) {
    const report = result.reports.get(record.memoryId);
    if (!report || record.reportId !== report.id || record.reportVersion !== report.version || record.reportRevision !== report.revision) continue;
    const list = result.evidence.get(record.memoryId) ?? []; list.push(record); result.evidence.set(record.memoryId, list);
  }
  if (records.some(row => row.metadata.sources.some(source => source.facts.length))) result.peers = await loadComparisonEvidence(db, owner, memories);
  return result;
}
