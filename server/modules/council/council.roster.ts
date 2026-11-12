import { and, eq, sql } from 'drizzle-orm';
import type { BuilderConfig } from '../../../shared/api.interface';
import type { CouncilMember } from '../../../shared/council.interface';
import type { AgentMemoryScope } from '../../../shared/agent-roster.interface';
import type { ResearchSourceRef } from '../../../shared/team-workspace.interface';
import { assertAgentRosterExecutionFence, readAgentRosterVersion, lockAgentRosterOwner, type AgentRosterDatabase } from '../../database/agent-roster-context';
import { dataLibraryVersions } from '../../database/data-library.schema';
import { libraryEvidenceReferences } from '../../database/data-library-visibility';
import { teamWorkInputs } from '../../database/team-member-sources';
import { councilSessions } from '../../database/council.schema';
import { normalizeCouncil } from '../paper-trading/agent-builder.rules';
import type { CouncilEvidence } from './council.rules';
import { AgentRosterService } from '../agent-roster/agent-roster.service';
import type { PostgresJsDatabase } from '../../common/platform';
import { assertA2aConnectionFingerprint } from '../../database/a2a-agent-context';
import { researchDatasetVersions } from '../../database/research-artifacts.schema';
import { hasCouncilDispatchProof, type CouncilDispatchProofOptions } from '../../database/council-execution-proof';

type Session = typeof councilSessions.$inferSelect;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;

/** Only stored, server-created snapshots use this reader. HTTP input still uses normalizeCouncil. */
export function savedCouncilMembers(config: BuilderConfig): CouncilMember[] {
  const members = config.council?.members;
  if (!members?.some(member => member.rosterAgentId || member.rosterAgentVersionId)) {
    return members && members.length < 2 ? members : normalizeCouncil(config.council).members;
  }
  if (members.length < 1 || members.length > 6 || new Set(members.map(member => member.id)).size !== members.length) throw new Error('AGENT_INVALID_INPUT');
  for (const member of members) {
    if ((member.rosterAgentId || member.rosterAgentVersionId) && (!uuid.test(member.rosterAgentId ?? '') || !uuid.test(member.rosterAgentVersionId ?? ''))
      || !/^[a-zA-Z0-9_-]{1,100}$/u.test(member.id) || !member.name || member.name.length > 100
      || typeof member.instructions !== 'string' || member.instructions.length > 24000
      || !['researcher', 'challenger', 'manager'].includes(member.role) || !['fast', 'slow'].includes(member.model)) throw new Error('AGENT_INVALID_INPUT');
  }
  return members;
}

export function councilAgentMemoryScope(row: Session): AgentMemoryScope {
  if (row.checkpoint?.teamContext) return { kind: 'team', teamId: row.checkpoint.teamContext.teamId };
  return row.profileSnapshot.council?.members.length === 1 ? { kind: 'personal' } : { kind: 'conversation', conversationId: row.id };
}

/** Resolve exact provenance from the work actually sent, never the union of every team grant. */
export async function councilRosterSources(tx: AgentRosterDatabase, row: Session, evidence: CouncilEvidence[], workKey?: string): Promise<ResearchSourceRef[]> {
  const context = row.checkpoint?.teamContext;
  if (context && workKey) return teamWorkInputs(context.plan, workKey, (context.inputSnapshot.inputRefs ?? []) as ResearchSourceRef[]);
  if (context) return [];
  const refs: ResearchSourceRef[] = (row.resolvedReferences ?? []).map(ref => ({ kind: 'report_version', id: ref.versionId,
    revision: String(ref.version), availability: ref.status === 'valid' && ref.sourceStatus === 'available' ? 'available' : 'revoked' }));
  refs.push(...evidence.flatMap(item => item.agentMemory?.sourceRefs ?? []));
  refs.push(...evidence.flatMap(item => item.sourceReferences ?? []));
  const snapshotVersions = new Set<string>();
  for (const snapshot of refs.filter(ref => ref.kind === 'data_snapshot')) {
    const [dataset] = await tx.select({ sourceVersionId: researchDatasetVersions.sourceVersionId }).from(researchDatasetVersions)
      .where(and(eq(researchDatasetVersions.owner, row.owner), eq(researchDatasetVersions.id, snapshot.id)));
    if (dataset) snapshotVersions.add(dataset.sourceVersionId);
  }
  for (const ref of libraryEvidenceReferences(evidence)) {
    const [version] = await tx.select().from(dataLibraryVersions).where(and(eq(dataLibraryVersions.owner, row.owner),
      eq(dataLibraryVersions.sourceId, ref.sourceId), eq(dataLibraryVersions.id, ref.versionId)));
    if (!version) throw new Error('AGENT_SOURCE_UNAVAILABLE');
    if (!snapshotVersions.has(version.id)) refs.push({ kind: 'document_version', id: version.id, revision: String(version.version), availability: 'available' });
  }
  return [...new Map(refs.map(ref => [`${ref.kind}:${ref.id}:${ref.revision}`, ref])).values()];
}

/** Runtime recall always chooses one exact scope; owner history APIs are deliberately not used. */
export async function readCouncilRosterMemory(tx: AgentRosterDatabase, row: Session, member: CouncilMember, workKey?: string): Promise<CouncilEvidence[]> {
  if (!member.rosterAgentId || !member.rosterAgentVersionId) return [];
  const sourceRefs = await councilRosterSources(tx, row, row.evidenceSnapshot, workKey);
  const clock = row.checkpoint?.teamContext ? undefined : await tx.execute(sql`SELECT clock_timestamp() AS cutoff`);
  const cutoff = row.checkpoint?.teamContext?.dataCutoffAt ?? new Date(clock![0].cutoff as string | Date).toISOString();
  const result = await new AgentRosterService(tx as PostgresJsDatabase).readMemoryForExecution(tx, row.owner,
    { agentId: member.rosterAgentId, agentVersionId: member.rosterAgentVersionId }, councilAgentMemoryScope(row),
    { sourceRefs, dataCutoffAt: cutoff });
  const evidence: CouncilEvidence[] = [];
  for (const item of result.items) {
    const libraryReferences = [];
    for (const ref of item.sourceRefs.filter(ref => ref.kind === 'document_version')) {
      const [version] = await tx.select().from(dataLibraryVersions).where(and(eq(dataLibraryVersions.owner, row.owner), eq(dataLibraryVersions.id, ref.id)));
      if (!version) throw new Error('AGENT_SOURCE_UNAVAILABLE');
      libraryReferences.push({ sourceId: version.sourceId, versionId: version.id });
    }
    evidence.push({ id: `agent-memory:${item.id}`, title: item.origin === 'user_note' ? 'Explicit user note' : 'Source-backed friend memory',
      content: item.content, role: 'fundamental', evidenceType: 'scoped_agent_memory', sourceName: 'Scoped friend memory', sourceUrl: null,
      fetchedAt: item.createdAt, relevanceScore: 0, libraryReferences,
      agentMemory: { id: item.id, agentId: item.agentId, scope: item.scope, origin: item.origin, sourceRefs: item.sourceRefs, sharedFrom: item.sharedFrom } });
  }
  return evidence;
}

export async function assertCouncilRosterMember(tx: AgentRosterDatabase, row: Session, member: CouncilMember,
  evidence: CouncilEvidence[] = row.evidenceSnapshot, allowedToolIds: string[] = [], workKey?: string, settlement?: CouncilDispatchProofOptions): Promise<void> {
  if (member.executionMode === 'a2a') {
    if (!member.a2aFingerprint) throw new Error('A2A_FINGERPRINT_REQUIRED');
    await assertA2aConnectionFingerprint(tx, row.owner, member.a2aFingerprint);
  }
  if (!member.rosterAgentId && !member.rosterAgentVersionId) return;
  const allowArchivedSettlement = Boolean(settlement && await hasCouncilDispatchProof(tx, row, member.id, { ...settlement, workKey }));
  await assertAgentRosterExecutionFence(tx, row.owner, [member], { sourceRefs: await councilRosterSources(tx, row, evidence, workKey),
    allowedToolIds, dataCutoffAt: row.checkpoint?.teamContext?.dataCutoffAt, allowArchivedSettlement });
}

export async function assertCouncilRosterPublication(tx: AgentRosterDatabase, row: Session, settlement = false): Promise<void> {
  for (const member of savedCouncilMembers(row.profileSnapshot)) {
    const context = row.checkpoint?.teamContext;
    const works = context?.plan.work.filter(work => context.members.some(item => item.memberId === member.id
      && (item.roleId === work.roleId || item.roleId === work.reviewerRoleId)));
    if (works?.length) for (const work of works) await assertCouncilRosterMember(tx, row, member, row.evidenceSnapshot, [], work.workKey, settlement ? { publication: true } : undefined);
    else await assertCouncilRosterMember(tx, row, member, row.evidenceSnapshot, [], undefined, settlement ? { publication: true } : undefined);
  }
}

/** Commit an exact send intent only after live dispatch permission passes, immediately before transport. */
export async function markCouncilRosterDispatch(tx: AgentRosterDatabase, row: Session, member: CouncilMember,
  evidence: CouncilEvidence[] = row.evidenceSnapshot): Promise<void> {
  if (!member.rosterAgentId && !member.rosterAgentVersionId) return;
  const [current] = await tx.select().from(councilSessions).where(and(eq(councilSessions.owner, row.owner), eq(councilSessions.id, row.id))).for('update');
  if (!current || current.status !== 'running' || current.revision !== row.revision || current.checkpoint?.cycleId !== row.checkpoint?.cycleId) throw new Error('RESEARCH_REVISION_CHANGED');
  await assertCouncilRosterMember(tx, current, member, evidence);
  const proof = { cycleId: current.checkpoint!.cycleId, revision: row.revision, turn: row.checkpoint!.nextTurn, memberId: member.id };
  const retained = (current.checkpoint!.rosterDispatches ?? []).filter(item => item.cycleId === proof.cycleId && item.revision === proof.revision
    && !(item.turn === proof.turn && item.memberId === proof.memberId));
  await tx.update(councilSessions).set({ checkpoint: { ...current.checkpoint!, rosterDispatches: [...retained, proof].slice(-128) } }).where(eq(councilSessions.id, current.id));
}

export async function councilRosterToolIds(tx: AgentRosterDatabase, row: Session, member: CouncilMember, candidates: string[], workKey?: string): Promise<string[]> {
  if (!member.rosterAgentId && !member.rosterAgentVersionId) return candidates;
  await assertCouncilRosterMember(tx, row, member, row.evidenceSnapshot, [], workKey);
  await lockAgentRosterOwner(tx, row.owner);
  const { version, currentVersion } = await readAgentRosterVersion(tx, row.owner, member.rosterAgentId!, member.rosterAgentVersionId!);
  const canonical = (id: string) => id.startsWith('builtin:') ? id.slice(8) : id;
  const pinned = new Set(version.config.allowedToolIds.map(canonical)), current = new Set(currentVersion.config.allowedToolIds.map(canonical));
  const team = row.checkpoint?.teamContext?.members.find(item => item.memberId === member.id);
  return candidates.filter(id => pinned.has(canonical(id)) && current.has(canonical(id)) && (!team || team.allowedToolIds.includes(canonical(id))));
}
