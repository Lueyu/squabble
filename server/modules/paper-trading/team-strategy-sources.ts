import { ConflictException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { researchMemories, researchTheses, researchThesisVersions } from '../../database/research-memory.schema';
import type { TeamDatabase } from '../../database/team-context';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const blocked = (): never => { throw new ConflictException('TEAM_REAPPROVAL_REQUIRED'); };

/** Editing or branching a team report does not inherit its accepted model attempt or user approval. */
export async function assertTeamStrategyReportAuthority(tx: TeamDatabase, owner: string, rootId: string,
  adoptedOutputs: ReadonlySet<string>): Promise<void> {
  const active = new Set<string>(), complete = new Map<string, boolean>();
  let count = 0;
  const id = (value: unknown): string => typeof value === 'string' && UUID.test(value) ? value : blocked();
  const referenceIds = (snapshot: Record<string, unknown> | null): string[] => {
    const result: string[] = [];
    const collect = (record: Record<string, unknown>): void => {
      for (const field of ['references', 'resolvedReferences', 'reportReferences']) {
        const refs = record[field];
        if (refs === undefined || refs === null) continue;
        if (!Array.isArray(refs) || refs.length > 100) blocked();
        for (const ref of refs as unknown[]) {
          if (!ref || typeof ref !== 'object') blocked();
          result.push(id((ref as Record<string, unknown>).versionId));
        }
      }
      if (record.sourceReportVersionId !== undefined && record.sourceReportVersionId !== null) result.push(id(record.sourceReportVersionId));
    };
    if (snapshot) {
      collect(snapshot);
      const continuation = snapshot.continuationSummary;
      if (continuation !== undefined && continuation !== null) {
        if (typeof continuation !== 'object' || Array.isArray(continuation)) blocked();
        collect(continuation as Record<string, unknown>);
      }
    }
    if (result.length > 100) blocked();
    return result;
  };

  const inspect = async (versionId: string, depth: number): Promise<boolean> => {
    if (active.has(versionId) || depth > 50) blocked();
    if (complete.has(versionId)) return complete.get(versionId)!;
    if (++count > 100) blocked();
    active.add(versionId);
    const [version] = await tx.select().from(researchDocumentVersions).where(and(
      eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, id(versionId))));
    if (!version || version.deletedAt) blocked();
    const [produced] = await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.researchVersionId, version.id)));
    const [source] = version.source?.type === 'council' ? await tx.select().from(councilReports).where(and(
      eq(councilReports.owner, owner), eq(councilReports.id, version.source.id))) : [];
    const sessionIds = new Set([produced?.sessionId, source?.sessionId,
      typeof version.snapshot?.sessionId === 'string' ? id(version.snapshot.sessionId) : null].filter(Boolean));
    let producedCommission: string | null = null;
    let team = version.snapshot?.teamExecutionContext !== undefined && version.snapshot?.teamExecutionContext !== null;
    for (const sessionId of sessionIds) {
      const [session] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, sessionId)));
      const commission = session?.teamCommissionId ?? session?.teamContext?.commissionId ?? session?.checkpoint?.teamContext?.commissionId;
      if (commission) {
        team = true;
        if (produced?.sessionId === sessionId) producedCommission = commission;
      }
    }
    // Only the exact output of the accepted commission can consume its adoption.
    // A derived report must return through a new team commission and fresh decision.
    if (versionId === rootId && producedCommission && adoptedOutputs.has(`${producedCommission}:${versionId}`)) return true;
    if (team) return true;
    const dependencies = referenceIds(version.snapshot);
    if (version.parentVersionId) dependencies.push(id(version.parentVersionId));
    const inputRefs = version.snapshot?.inputRefs;
    if (inputRefs !== undefined && (!Array.isArray(inputRefs) || inputRefs.length > 100)) blocked();
    for (const ref of (inputRefs ?? []) as Array<Record<string, unknown>>) {
      if (!ref || typeof ref !== 'object') blocked();
      if (ref.kind === 'report_version') dependencies.push(id(ref.id));
      if (ref.kind === 'thesis_version') {
        const [thesisVersion] = await tx.select().from(researchThesisVersions).where(and(eq(researchThesisVersions.owner, owner), eq(researchThesisVersions.id, id(ref.id))));
        const [thesis] = thesisVersion ? await tx.select().from(researchTheses).where(and(eq(researchTheses.owner, owner), eq(researchTheses.id, thesisVersion.thesisId))) : [];
        const [memory] = thesis ? await tx.select().from(researchMemories).where(and(eq(researchMemories.owner, owner), eq(researchMemories.id, thesis.memoryId))) : [];
        const [report] = memory ? await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.id, memory.reportId))) : [];
        if (!report?.researchVersionId) blocked();
        dependencies.push(report.researchVersionId);
      }
    }
    for (const dependency of new Set(dependencies)) if (await inspect(dependency, depth + 1)) team = true;
    active.delete(versionId);
    complete.set(versionId, team);
    return team;
  };
  const hasTeamSource = await inspect(rootId, 0);
  if (!hasTeamSource) return;
  // Exact root output authority is established from the durable Council linkage,
  // not from a caller-controlled snapshot marker or another team's adoption.
  const [report] = await tx.select().from(councilReports).where(and(eq(councilReports.owner, owner), eq(councilReports.researchVersionId, rootId)));
  const [session] = report ? await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, owner), eq(councilSessions.id, report.sessionId))) : [];
  const commission = session?.teamCommissionId ?? session?.teamContext?.commissionId ?? session?.checkpoint?.teamContext?.commissionId;
  if (!commission || !adoptedOutputs.has(`${commission}:${rootId}`)) blocked();
}
