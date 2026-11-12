import assert from 'node:assert/strict';
import { test } from 'node:test';
import { teamCouncilMembers, teamTaskPlan, dependentTeamWorkKeys, parseSavedTeamResponse } from './council.team';
import type { TeamExecutionContext } from '../../../shared/team-workspace.interface';

const context = { plan: { leadRoleId: 'lead', work: [
  { workKey: 'a', roleId: 'expert', taskKind: 'specialist', dependencyWorkKeys: [], reviewerRoleId: 'lead', objective: '2025 cash flow', expectedOutput: 'sources' },
  { workKey: 'b', roleId: 'expert', taskKind: 'specialist', dependencyWorkKeys: [], reviewerRoleId: 'lead', objective: '2026 cash flow', expectedOutput: 'sources' },
  { workKey: 'summary', roleId: 'lead', taskKind: 'summary', dependencyWorkKeys: ['a', 'b'], reviewerRoleId: 'lead', objective: 'synthesis', expectedOutput: 'decision' },
] }, members: [
  { roleId: 'lead', memberId: 'leader', label: 'Lead', responsibility: 'synthesize', expectedOutput: 'decision', executor: { executionMode: 'model', connectionId: 'explicit', model: 'fixture' } },
  { roleId: 'expert', memberId: 'expert', label: 'Expert', responsibility: 'verify', expectedOutput: 'sources', executor: { executionMode: 'model', connectionId: 'explicit-2', model: 'fixture' } },
] } as unknown as TeamExecutionContext;
test('frozen plan preserves distinct work identities and explicit reviewer', () => {
  const plan = teamTaskPlan(context);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map(p => p.workKey), ['a', 'b', 'summary']);
  assert.deepEqual(plan[2].dependencyWorkKeys, ['a', 'b']);
  assert.equal(plan[0].reviewerMemberId, 'leader');
});
test('role and execution connection remain independent, with exactly one manager', () => {
  const members = teamCouncilMembers(context);
  assert.equal(members.filter(m => m.role === 'manager').length, 1);
  assert.equal(members[1].connectionId, 'explicit-2');
  assert.ok(members[1].instructions?.includes('verify'));
  const solo = structuredClone(context); solo.members = [context.members[0]];
  assert.equal(teamCouncilMembers(solo).length, 1);
});
test('retry invalidates every downstream summary while retaining unrelated branches', () => {
  const tasks = [
    { workKey: 'a', dependencyWorkKeys: [] }, { workKey: 'b', dependencyWorkKeys: [] },
    { workKey: 'c', dependencyWorkKeys: ['a'] }, { workKey: 'summary', dependencyWorkKeys: ['b', 'c'] },
  ];
  assert.deepEqual([...dependentTeamWorkKeys(tasks, 'a')].sort(), ['a', 'c', 'summary']);
});
test('saved-response parsing preserves JSON and never puts private malformed text in errors', () => {
  assert.deepEqual(parseSavedTeamResponse({ text: '```json\n{"ok":true}\n```' }), { ok: true });
  assert.throws(() => parseSavedTeamResponse({ text: 'private model text' }), { message: 'LLM_INVALID_JSON' });
});

test('team execution retains exact friend identity and personality alongside role responsibility', () => {
  const saved = structuredClone(context);
  Object.assign(saved.members[0], { rosterAgentId: 'friend', rosterAgentVersionId: 'version', agentInstructions: 'PINNED_PERSONALITY', avatar: 'news', agentName: 'Actual friend' });
  const member = teamCouncilMembers(saved)[0];
  assert.equal(member.rosterAgentId, 'friend');
  assert.equal(member.rosterAgentVersionId, 'version');
  assert.match(member.instructions, /PINNED_PERSONALITY/u);
  assert.match(member.instructions, /synthesize/u);
  assert.equal(member.avatar, 'news');
  assert.equal(member.name, 'Actual friend');
  assert.equal(member.roleTitle, 'Lead');
  saved.plan.leadRoleId = 'expert';
  assert.equal(teamCouncilMembers(saved)[0].avatar, 'news', 'changing the execution role cannot change appearance');
  assert.equal(teamCouncilMembers(context)[0].avatar, undefined, 'legacy snapshots retain their display fallback');
});
