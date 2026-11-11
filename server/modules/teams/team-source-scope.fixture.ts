import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { makeTeamFixture } from './team-test.fixture';
import { TeamCommissionWorker } from './team-commission.worker';
import { commissionContext } from './team-commission.service';
import { teamCommissions } from '../../database/teams.schema';
import { councilSessions } from '../../database/council.schema';
import { dataLibrarySources, dataLibraryVersions } from '../../database/data-library.schema';
import type { TeamSemanticConfig, TeamWorkItem, ResearchSourceRef } from '../../../shared/team-workspace.interface';

/** Explicitly published source ceilings, independent of a commission's input selection. Fictional PG only. */
export async function makeSourceScopeFixture() {
  const f = await makeTeamFixture();
  const created = await f.service.create(f.owner, { requestKey: randomUUID(), name: 'Fictional source-scoped team' });
  const refs: ResearchSourceRef[] = [], grantIds: string[] = [], sources: Array<{ id: string }> = [];
  for (const name of ['X', 'Y', 'Z']) {
    const [source] = await f.db.insert(dataLibrarySources).values({ owner: f.owner, kind: 'text', title: `Fictional ${name}`, format: 'text' }).returning();
    const [version] = await f.db.insert(dataLibraryVersions).values({ owner: f.owner, sourceId: source.id, version: 1,
      contentHash: `fictional-${name}`, rawContent: `PRIVATE_${name}_CONTENT`, extractedText: `PRIVATE_${name}_CONTENT`,
      sections: [], byteLength: 17, extractionState: 'ready', observedAt: new Date('2020-01-01') }).returning();
    const ref = { kind: 'document_version' as const, id: version.id, revision: '1', availability: 'available' as const };
    const detail = await f.service.detail(f.owner, created.id);
    const result = await f.sources.grant(f.owner, created.id, { requestKey: randomUUID(), expectedScopeRevision: detail.scopeRevision, sourceRef: ref });
    refs.push(ref); grantIds.push(result.grant.id); sources.push(source);
  }
  const [a, b] = [randomUUID(), randomUUID()];
  let config: TeamSemanticConfig = { schemaVersion: 1, departments: [], relations: [], defaults: { leadRoleId: a, parallelism: 1 },
    roles: [a, b].map((id, index) => ({ id, departmentId: null, participation: 'enabled', responsibility: `Fictional role ${index}`,
      expectedOutput: 'Evidence', executor: { executionMode: 'model', connectionId: f.connection.id, model: 'fixture', settings: {} },
      allowedToolIds: ['search_data_library', 'read_browser_source'], sourceGrantIds: index === 0 ? grantIds : [grantIds[1]] })) };
  let published: Awaited<ReturnType<typeof f.versions.publish>>;
  async function publish(next = config) {
    const detail = await f.service.detail(f.owner, created.id);
    const saved = await f.service.save(f.owner, created.id, 'draft', { requestKey: randomUUID(), expectedSemanticRevision: detail.semanticRevision, config: next });
    const preview = await f.versions.publishPreview(f.owner, created.id, { requestKey: randomUUID(), expectedSemanticRevision: saved.semanticRevision });
    published = await f.versions.publish(f.owner, created.id, { requestKey: randomUUID(), previewId: preview.previewId, previewHash: preview.previewHash });
    config = next;
    return published;
  }
  await publish();
  const account = await f.account();
  const bp = await f.versions.bindingPreview(f.owner, created.id, { requestKey: randomUUID(), action: 'assign', accountId: account.id,
    teamVersionId: published!.version.id, expectedBindingRevision: 0, expectedAccountBindingId: null,
    executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true });
  const bound = await f.versions.binding(f.owner, created.id, { requestKey: randomUUID(), previewId: bp.previewId, previewHash: bp.previewHash });
  const work: TeamWorkItem[] = [
    { workKey: 'X', roleId: a, taskKind: 'specialist', objective: 'Handle X', expectedOutput: 'Evidence', inputRefs: [refs[0]], dependencyWorkKeys: [], reviewerRoleId: a, reviewMode: 'self_check', requestedByRoleIds: [] },
    { workKey: 'Y', roleId: b, taskKind: 'specialist', objective: 'Handle Y', expectedOutput: 'Evidence', inputRefs: [refs[1]], dependencyWorkKeys: [], reviewerRoleId: b, reviewMode: 'self_check', requestedByRoleIds: [] },
    { workKey: 'summary', roleId: a, taskKind: 'summary', objective: 'Summarize X and Y', expectedOutput: 'Report', inputRefs: [], dependencyWorkKeys: ['X', 'Y'], reviewerRoleId: a, reviewMode: 'self_check', requestedByRoleIds: [] },
  ];
  async function preview(items = work, globalRefs: ResearchSourceRef[] = [], participants = [a, b]) {
    const detail = await f.service.detail(f.owner, created.id);
    return f.commissions.preview(f.owner, created.id, { requestKey: randomUUID(), teamVersionId: published!.version.id,
      bindingId: detail.binding!.id, expectedBindingRevision: detail.bindingRevision, leadRoleId: participants[0], participantRoleIds: participants,
      supervisorRoleIds: [], objective: 'Fictional source boundaries', expectedOutput: 'Evidence', dataCutoffAt: null,
      deadlineAt: new Date(Date.now() + 3600000).toISOString(), parallelism: 1, inputRefs: globalRefs, conflictResolutions: [], work: items,
      budget: { budgetMode: 'cost_and_calls', ceiling: { amount: '1', currency: 'USD' }, callLimit: items.length * 2, paidRevisionLimit: 0 } });
  }
  async function create(items = work, globalRefs: ResearchSourceRef[] = [], participants = [a, b]) {
    const proposal = await preview(items, globalRefs, participants);
    const command = await f.commissions.create(f.owner, created.id, { requestKey: randomUUID(), previewId: proposal.previewId, previewHash: proposal.previewHash });
    const worker = new TeamCommissionWorker(f.store, f.runtime, f.commissions);
    await worker.runOnce();
    await worker.runOnce();
    const [row] = await f.db.select().from(teamCommissions).where(eq(teamCommissions.id, command.commissionId));
    const [session] = await f.db.select().from(councilSessions).where(eq(councilSessions.id, row.sessionId!));
    const [running] = await f.db.update(councilSessions).set({ status: 'running', checkpoint: { ...session.checkpoint!,
      workflow: { goal: 'comprehensive', peers: [], parallelism: 1, recallEnabled: false } } }).where(eq(councilSessions.id, session.id)).returning();
    return { commission: row, session: running, context: commissionContext(row) };
  }
  return { ...f, teamId: created.id, account, newAccount: f.account, a, b, refs, grantIds, sourceRows: sources, work, publish, preview, create,
    get config() { return config; }, get published() { return published!; } };
}
