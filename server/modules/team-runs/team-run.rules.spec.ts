import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueTeamRun, teamRunInputSchema, compileRunCommission } from './team-run.rules';
import { tradingMarketSchedule } from '../paper-trading/trading-market.calendar';
import { randomUUID } from 'node:crypto';
import type { TeamRunConfiguration } from '../../../shared/team-run.interface';
import type { TeamSemanticConfig } from '../../../shared/team-workspace.interface';

test('after-close cadence uses official CN close and excludes lunch/weekends', () => {
  for (const value of ['2026-11-12T04:30:00Z', '2026-11-12T07:59:59Z', '2026-11-14T09:00:00Z']) {
    const now = new Date(value);
    assert.equal(dueTeamRun(tradingMarketSchedule('CN', now), 60, now), null);
  }
  const now = new Date('2026-11-12T08:00:00Z');
  assert.equal(dueTeamRun(tradingMarketSchedule('CN', now), 60, now), '2026-11-12');
});

test('calendar and DST determine US cycle without guessed fixed UTC close', () => {
  assert.equal(dueTeamRun(tradingMarketSchedule('US', new Date('2026-11-12T21:59:59Z')), 60, new Date('2026-11-12T21:59:59Z')), null);
  assert.equal(dueTeamRun(tradingMarketSchedule('US', new Date('2026-11-12T22:00:00Z')), 60, new Date('2026-11-12T22:00:00Z')), '2026-11-12');
  const future = new Date('2027-01-04T23:00:00Z');
  assert.equal(dueTeamRun(tradingMarketSchedule('US', future), 60, future), null);
});

test('an autonomous agreement rejects missing, zero and inconsistent finite budgets', () => {
  for (const budget of [null, { perRun: { ceiling: { amount: null, currency: 'USD' }, callLimit: 4 } }]) {
    assert.equal(teamRunInputSchema.safeParse({ budget }).success, false);
  }
  assert.throws(() => compileRunCommission({ roles: [], defaults: { leadRoleId: null } } as never, {} as never, 'cycle', new Date()));
  const input = { requestKey: 'fixture', teamVersionId: randomUUID(), bindingId: randomUUID(), expectedBindingRevision: 1,
    objective: 'Fictional research', market: 'CN', budget: { perRun: { budgetMode: 'cost_and_calls', ceiling: { amount: '1', currency: 'USD' }, callLimit: 2, paidRevisionLimit: 0 },
      daily: { costUsd: '2', calls: 4 }, monthly: { costUsd: '4', calls: 8 } }, replacementPolicy: { kind: 'replace_combination', allocationPct: 50 }, inputRefs: [] };
  assert.equal(teamRunInputSchema.parse(input).cadence.delayMinutes, 60);
  assert.equal(teamRunInputSchema.parse(input).initialRun, undefined, 'Omitted startup mode preserves scheduled legacy behavior');
  for (const initialRun of ['immediate', 'scheduled']) {
    assert.equal(teamRunInputSchema.parse({ ...input, initialRun }).initialRun, initialRun);
  }
  assert.equal(teamRunInputSchema.safeParse({ ...input, initialRun: 'unbounded' }).success, false);
  for (const amount of [null, '0', '-1', 'Infinity']) {
    assert.equal(teamRunInputSchema.safeParse({ ...input, budget: { ...input.budget, perRun: { ...input.budget.perRun, ceiling: { amount, currency: 'USD' } } } }).success, false);
  }
  assert.equal(teamRunInputSchema.safeParse({ ...input, budget: { ...input.budget, daily: { costUsd: '0.5', calls: 4 } } }).success, false);
  assert.equal(teamRunInputSchema.safeParse({ ...input, budget: { ...input.budget, monthly: { costUsd: '4', calls: 1 } } }).success, false);
  assert.equal(teamRunInputSchema.safeParse({ ...input, actorType: 'user' }).success, false, 'HTTP bodies cannot choose a system actor');
});

test('explicitly uncapped periods keep per-run calls finite and normalize absent monetary ceilings', () => {
  const input = { requestKey: 'fixture', teamVersionId: randomUUID(), bindingId: randomUUID(), expectedBindingRevision: 1,
    objective: 'Fictional uncapped research', market: 'CN', budget: {
      perRun: { budgetMode: 'cost_and_calls', ceiling: { amount: null, currency: 'USD' }, callLimit: 8, paidRevisionLimit: 0 },
      daily: { costUsd: null, calls: null }, monthly: { costUsd: null, calls: null },
    }, replacementPolicy: { kind: 'replace_combination', allocationPct: 50 }, inputRefs: [] };
  const parsed = teamRunInputSchema.parse(input);
  assert.equal(parsed.budget.perRun.budgetMode, 'calls_only');
  assert.equal(parsed.budget.perRun.ceiling.amount, null);
  assert.deepEqual(parsed.budget.daily, { costUsd: null, calls: null });
  for (const callLimit of [null, 0, 501, Infinity]) {
    assert.equal(teamRunInputSchema.safeParse({ ...input, budget: { ...input.budget, perRun: { ...input.budget.perRun, callLimit } } }).success, false);
  }
  assert.equal(teamRunInputSchema.safeParse({ ...input, budget: { ...input.budget, daily: { costUsd: '2', calls: null } } }).success, false,
    'A finite aggregate cost limit needs a conservative per-run reservation');
  assert.equal(teamRunInputSchema.safeParse({ ...input, budget: { ...input.budget, monthly: { costUsd: null, calls: 4 } } }).success, false);
  const finiteRun = { ...input.budget.perRun, ceiling: { amount: '2', currency: 'USD' } };
  assert.equal(teamRunInputSchema.safeParse({ ...input, budget: { ...input.budget, perRun: finiteRun, daily: { costUsd: '2', calls: null } } }).success, true);
});

test('initial research uses the verified market-local date even outside a trading session', () => {
  for (const [instant, date] of [
    ['2026-11-12T15:00:00Z', '2026-11-12'],
    ['2026-11-14T01:00:00Z', '2026-11-13'],
    ['2026-11-14T15:00:00Z', '2026-11-14'],
  ]) {
    const now = new Date(instant);
    assert.equal(dueTeamRun(tradingMarketSchedule('US', now), 60, now, true), date);
  }
  const unknown = new Date('2027-01-04T15:00:00Z');
  assert.equal(dueTeamRun(tradingMarketSchedule('US', unknown), 60, unknown, true), null);
});

test('calls-only commission keeps finite agreement reservations while disclosing an unknown external fee ceiling', () => {
  const roleId = randomUUID();
  const config: TeamSemanticConfig = { schemaVersion: 1, departments: [], relations: [], defaults: { leadRoleId: roleId, parallelism: 1 },
    roles: [{ id: roleId, departmentId: null, participation: 'enabled', responsibility: 'Fictional research', expectedOutput: 'Report', executor: null, allowedToolIds: [], sourceGrantIds: [] }] };
  const agreement = { teamVersionId: randomUUID(), bindingId: randomUUID(), expectedBindingRevision: 1, objective: 'Fictional objective',
    budget: { perRun: { budgetMode: 'calls_only', ceiling: { amount: '3', currency: 'USD' }, callLimit: 2, paidRevisionLimit: 0 } }, inputRefs: [] } as TeamRunConfiguration;
  const plan = compileRunCommission(config, agreement, 'fixture', new Date('2026-11-12T09:00:00Z'));
  assert.equal(plan.budget.ceiling.amount, null);
  assert.equal(agreement.budget.perRun.ceiling.amount, '3');
  assert.equal(plan.budget.callLimit, 2);
  assert.equal(plan.work[0].reviewMode, 'self_check');
  assert.equal(plan.deadlineAt, '2026-11-12T15:00:00.000Z');
});
