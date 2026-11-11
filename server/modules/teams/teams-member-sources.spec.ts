import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { TeamCommissionPlan, TeamRole, ResearchSourceRef } from '../../../shared/team-workspace.interface';
import { freezeTeamMemberGrants, teamWorkInputs, teamVisibleEvidence } from '../../database/team-member-sources';
import { TeamStore } from './team-store';

const x: ResearchSourceRef = { kind: 'document_version', id: randomUUID(), revision: '1', availability: 'available' };
const y: ResearchSourceRef = { ...x, id: randomUUID() };
const z: ResearchSourceRef = { ...x, id: randomUUID() };
const grants = [x, y, z].map(ref => ({ id: randomUUID(), sourceKind: ref.kind, sourceId: ref.id, sourceRevision: ref.revision }));
const denied = (error: unknown) => (error as { getResponse(): { code: string } }).getResponse().code === 'TEAM_SCOPE_REVOKED';
function role(sourceGrantIds: string[]): TeamRole {
  return { id: randomUUID(), departmentId: null, participation: 'enabled', responsibility: 'Fictional role',
    expectedOutput: 'Evidence', executor: null, allowedToolIds: [], sourceGrantIds };
}
function work(key: string, roleId: string, refs: ResearchSourceRef[], deps: string[] = [], reviewerRoleId = roleId) {
  return { workKey: key, roleId, taskKind: 'specialist' as const, objective: key, expectedOutput: 'Evidence', inputRefs: refs,
    dependencyWorkKeys: deps, reviewerRoleId, reviewMode: roleId === reviewerRoleId ? 'self_check' as const : 'independent' as const, requestedByRoleIds: [] };
}
function plan(workItems: ReturnType<typeof work>[]): TeamCommissionPlan { return { work: workItems } as TeamCommissionPlan; }

test('source selection never expands a published role, including independent reviewers and dependency recipients', () => {
  const a = role([grants[0].id]), b = role([]);
  for (const items of [[work('a', a.id, [x]), work('b', b.id, [], ['a'])], [work('a', a.id, [x], [], b.id)]]) {
    assert.throws(() => freezeTeamMemberGrants([a, b], plan(items), [], grants), denied);
  }
  assert.throws(() => freezeTeamMemberGrants([a, b], plan([work('a', a.id, [])]), [x], grants), denied);
});

test('member snapshots contain only explicitly used inputs, with independent work kept separate', () => {
  const a = role(grants.map(grant => grant.id)), b = role([grants[1].id]);
  const p = plan([work('a', a.id, [x]), work('b', b.id, [y]), work('summary', a.id, [], ['a', 'b'])]);
  const frozen = freezeTeamMemberGrants([a, b], p, [], grants);
  assert.deepEqual(frozen.get(a.id)?.sort(), [grants[0].id, grants[1].id].sort());
  assert.deepEqual(frozen.get(b.id), [grants[1].id]);
  assert.deepEqual(teamWorkInputs(p, 'b', []), [y]);
  assert.deepEqual(teamWorkInputs(p, 'summary', []).map(ref => ref.id).sort(), [x.id, y.id].sort());
});

test('unrelated private source and native evidence never enter a task through the shared snapshot', () => {
  const a = role([grants[0].id]), b = role([grants[1].id]);
  const p = plan([work('a', a.id, [x]), work('b', b.id, [y])]);
  const tasks = [{ workKey: 'a', attempts: [{ id: 'attempt-a' }] }, { workKey: 'b', attempts: [{ id: 'attempt-b' }] }];
  const evidence = [{ id: 'team-account:commission' }, { id: x.id }, { id: y.id },
    { id: 'native:attempt-a:0' }, { id: 'native:attempt-b:0' },
    { id: 'tool-x', libraryReferences: [{ sourceId: 'fixture', versionId: x.id }] },
    { id: 'tool-y', libraryReferences: [{ sourceId: 'fixture', versionId: y.id }] }];
  assert.deepEqual(teamVisibleEvidence({ commissionId: 'commission', plan: p, inputSnapshot: { inputRefs: [] } }, 'b', tasks, evidence)
    .map(item => item.id), ['team-account:commission', y.id, 'native:attempt-b:0', 'tool-y']);
});

test('a preview produced before member-scope compilation cannot be consumed after the upgrade', async () => {
  const stored = { id: randomUUID(), kind: 'commission', consumedByRequestKey: null, previewHash: 'fixture-hash',
    compilerVersion: 'team-plan-v1', expiresAt: new Date(Date.now() + 60000) };
  const chain = { from() { return this; }, where() { return this; }, async for() { return [stored]; } };
  const tx = { select: () => chain };
  const store = new TeamStore({} as never);
  await assert.rejects(store.consume(tx as never, 'owner', { id: randomUUID() } as never, 'commission',
    { requestKey: 'new-command', previewId: stored.id, previewHash: stored.previewHash }),
  (error: unknown) => (error as { getResponse(): { code: string } }).getResponse().code === 'TEAM_PREVIEW_STALE');
});
