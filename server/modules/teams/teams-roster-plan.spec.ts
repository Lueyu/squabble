import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TeamCommissionPlan, TeamSemanticConfig } from '../../../shared/team-workspace.interface';
import { compileTeamPlan } from './team-graph';

test('a single commission cannot count the same persistent person as two researchers', () => {
  const slots = [randomUUID(), randomUUID(), randomUUID()];
  const person = randomUUID(); const lead = randomUUID(); const connection = randomUUID();
  const config: TeamSemanticConfig = { schemaVersion: 1, departments: [], relations: [], defaults: { leadRoleId: slots[2], parallelism: 1 }, roles: slots.map((id, index) => ({ id, agentId: index === 2 ? lead : person, agentVersionId: randomUUID(), departmentId: null, participation: 'enabled', responsibility: 'Analyze', expectedOutput: 'Evidence', executor: { executionMode: 'model', connectionId: connection, model: 'model', tier: 'fast', settings: {} }, sourceGrantIds: [], allowedToolIds: [] })) };
  const plan: TeamCommissionPlan = { schemaVersion: 1, leadRoleId: slots[2], participantRoleIds: slots, objective: 'Review', expectedOutput: 'Report', dataCutoffAt: '2026-11-12T00:00:00.000Z', deadlineAt: '2026-11-13T00:00:00.000Z', supervisorRoleIds: [], parallelism: 1, conflictResolutions: [], budget: { budgetMode: 'cost_and_calls', ceiling: { amount: '1', currency: 'USD' }, callLimit: 8, paidRevisionLimit: 0 }, work: slots.map((roleId, index) => ({ workKey: `work-${index}`, roleId, taskKind: index === 2 ? 'summary' : 'financials', objective: `Task ${index}`, expectedOutput: 'Evidence', dependencyWorkKeys: index === 2 ? ['work-0', 'work-1'] : [], reviewerRoleId: index === 2 ? slots[0] : slots[2], reviewMode: 'independent', inputRefs: [], requestedByRoleIds: [] })) };
  assert.throws(() => compileTeamPlan(config, plan, {}), /different persistent|distinct persistent|same persistent/);
  config.roles[1].agentId = randomUUID();
  assert.doesNotThrow(() => compileTeamPlan(config, plan, {}));
});
