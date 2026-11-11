import { and, eq, inArray, isNull } from 'drizzle-orm';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchThesisVersions } from '../../database/research-memory.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { teamSourceGrants } from '../../database/teams.schema';
import { sourceFingerprint, fixedOutputLibraryReferences } from '../../database/team-source-context';
import { commonTeamGrantIds, teamSourceIdentity, type TeamGrantIdentity } from '../../database/team-member-sources';
import { assertTeamExecutionFence, listTeamSourceGrants } from '../../database/team-context';
import type { PostgresJsDatabase } from '../../common/platform';
import type { TeamExecutionContext, ResearchSourceRef } from '../../../shared/team-workspace.interface';
import type { ResearchMemoryRecallItem } from '../../../shared/research-memory.interface';


/** Team-owned interpretations are shared only when their restricted inputs are authorized for every recipient. */
export function teamScopedMemoryVisible(source: { teamId: string | null; accountId: string | null },
  context: Pick<TeamExecutionContext, 'teamId' | 'accountId'>, output: ResearchSourceRef,
  requiredRefs: ResearchSourceRef[], grants: TeamGrantIdentity[]): boolean {
  const allowed = new Set(grants.map(grant => JSON.stringify([grant.sourceKind, grant.sourceId, grant.sourceRevision])));
  if (allowed.has(teamSourceIdentity(output))) return true;
  return source.teamId === context.teamId && source.accountId === context.accountId
    && requiredRefs.every(ref => allowed.has(teamSourceIdentity(ref)));
}

/** Filter before ranking. Human owner inventory remains available through separate UI readers. */
export async function filterTeamMemory(db: Pick<PostgresJsDatabase, 'select'>, owner: string,
  items: ResearchMemoryRecallItem[], context?: TeamExecutionContext): Promise<ResearchMemoryRecallItem[]> {
  if (!items.length) return [];
  if (context) await assertTeamExecutionFence(db as PostgresJsDatabase, owner, context);
  const sessions = await db.select().from(councilSessions).where(and(eq(councilSessions.owner, owner),
    isNull(councilSessions.deletedAt), inArray(councilSessions.id, [...new Set(items.map(item => item.source.sessionId))])));
  const byId = new Map(sessions.map(session => [session.id, session]));
  if (!context) return items.filter(item => {
    const session = byId.get(item.source.sessionId);
    return session && !session.teamCommissionId && !session.teamContext && !session.checkpoint?.teamContext;
  });
  const common = commonTeamGrantIds(context.members);
  const grants = (await listTeamSourceGrants(db as PostgresJsDatabase, owner, context.teamId)).filter(grant => common.has(grant.id));
  const reports = await db.select({ id: councilReports.id, versionId: councilReports.researchVersionId })
    .from(councilReports).where(and(eq(councilReports.owner, owner), inArray(councilReports.id, items.map(item => item.source.reportId))));
  const thesisIds = items.filter(item => item.kind === 'thesis').map(item => item.id);
  const versions = thesisIds.length ? await db.select().from(researchThesisVersions)
    .where(and(eq(researchThesisVersions.owner, owner), inArray(researchThesisVersions.thesisId, thesisIds))) : [];
  const outputIds = reports.flatMap(report => report.versionId ? [report.versionId] : []);
  const outputs = outputIds.length ? await db.select({ id: researchDocumentVersions.id, version: researchDocumentVersions.version })
    .from(researchDocumentVersions).where(and(eq(researchDocumentVersions.owner, owner), inArray(researchDocumentVersions.id, outputIds))) : [];
  const historicGrantIds = [...new Set(sessions.flatMap(session => (session.teamContext ?? session.checkpoint?.teamContext)?.members.flatMap(member => member.sourceGrantIds) ?? []))];
  const historicGrants = historicGrantIds.length ? await db.select().from(teamSourceGrants)
    .where(and(eq(teamSourceGrants.ownerId, owner), inArray(teamSourceGrants.id, historicGrantIds))) : [];
  const indirectlyAllowed = new Set<string>();
  for (const grant of grants.filter(grant => grant.sourceKind === 'report_version' || grant.sourceKind === 'thesis_version')) {
    for (const library of await fixedOutputLibraryReferences(db as PostgresJsDatabase, owner,
      { kind: grant.sourceKind as ResearchSourceRef['kind'], id: grant.sourceId, revision: grant.sourceRevision, availability: 'available' }, context.dataCutoffAt)) {
      indirectlyAllowed.add(`${library.sourceId}:${library.versionId}`);
    }
  }
  const visible: ResearchMemoryRecallItem[] = [];
  const checked = new Map<string, boolean>();
  for (const item of items) {
    const session = byId.get(item.source.sessionId);
    if (!session) continue;
    const prior = session.teamContext ?? session.checkpoint?.teamContext;
    const report = outputs.find(version => version.id === reports.find(row => row.id === item.source.reportId)?.versionId);
    const thesis = item.kind === 'thesis' ? versions.find(version => version.thesisId === item.id && version.version === item.version) : undefined;
    const output: ResearchSourceRef | null = item.kind === 'thesis'
      ? thesis ? { kind: 'thesis_version', id: thesis.id, revision: String(thesis.version), availability: 'available' } : null
      : report ? { kind: 'report_version', id: report.id, revision: String(report.version), availability: 'available' } : null;
    if (!output) continue;
    const priorIds = prior ? [...new Set(prior.members.flatMap(member => member.sourceGrantIds))] : [];
    const lineageGrants = historicGrants.filter(grant => priorIds.includes(grant.id));
    const required = [...((prior?.inputSnapshot.inputRefs ?? []) as ResearchSourceRef[]), ...(prior?.plan.work.flatMap(work => work.inputRefs) ?? []),
      ...lineageGrants.map(grant => ({ kind: grant.sourceKind as ResearchSourceRef['kind'], id: grant.sourceId, revision: grant.sourceRevision, availability: 'available' as const }))];
    if (!teamScopedMemoryVisible({ teamId: prior?.teamId ?? null, accountId: prior?.accountId ?? null }, context, output, required, grants)) continue;
    const explicit = grants.some(grant => JSON.stringify([grant.sourceKind, grant.sourceId, grant.sourceRevision]) === teamSourceIdentity(output));
    if (!explicit && (lineageGrants.length !== priorIds.length || lineageGrants.some(grant => grant.state !== 'active')
      || item.libraryReferences?.some(ref => !indirectlyAllowed.has(`${ref.sourceId}:${ref.versionId}`)
        && !grants.some(grant => grant.sourceKind === 'document_version' && grant.sourceId === ref.versionId)))) continue;
    const key = teamSourceIdentity(output);
    if (!checked.has(key)) {
      try { await sourceFingerprint(db as PostgresJsDatabase, owner, output, context.dataCutoffAt); checked.set(key, true); }
      catch { checked.set(key, false); }
    }
    if (checked.get(key)) visible.push(item);
  }
  return visible;
}
