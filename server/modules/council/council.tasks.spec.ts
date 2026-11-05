import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { planResearchTasks, validateDelivery, dependentTaskKeys, validateWorkflowInput } from './council.tasks';
import { DEFAULT_MEMBERS } from './council.rules';

test('comprehensive graph runs independent financial and business work before valuation and review', () => {
  const tasks = planResearchTasks('comprehensive', DEFAULT_MEMBERS);
  assert.deepEqual(tasks.map(t => [t.key, t.dependencies]), [
    ['financials', []], ['business', []], ['valuation', ['financials', 'business']],
    ['challenge', ['valuation']], ['summary', ['financials', 'business', 'valuation', 'challenge']],
  ]);
  assert.ok(tasks.every(t => DEFAULT_MEMBERS.some(m => m.id === t.memberId)));
  assert.deepEqual(dependentTaskKeys(tasks, ['business']), ['business', 'valuation', 'challenge', 'summary']);
});

test('peer allowlist rejects unbounded, duplicate, primary and invalid instruments', () => {
  assert.throws(() => validateWorkflowInput({ goal: 'peers' }, 'AAPL'), /peer/i);
  assert.throws(() => validateWorkflowInput({ goal: 'peers', peers: ['MSFT', 'MSFT'] }, 'AAPL'), /peer/i);
  assert.throws(() => validateWorkflowInput({ goal: 'peers', peers: ['AAPL'] }, 'AAPL'), /peer/i);
  assert.throws(() => validateWorkflowInput({ goal: 'financials', parallelism: 10 }, 'AAPL'));
  assert.equal(validateWorkflowInput({ goal: 'peers', peers: ['msft'] }, 'AAPL')?.peers[0], 'MSFT');
  assert.equal(validateWorkflowInput({ goal: 'peers', peers: ['0700.HK'] }, 'AAPL')?.peers[0], '00700.HK');
  assert.throws(() => validateWorkflowInput({ goal: 'peers', peers: ['00700.HK'] }, '0700'));
});

test('deliverables require cited snapshot IDs, explicit units and pinned skill identities', () => {
  const pins = [{ id: 'financial-verification', version: '1.0.0', hash: 'abc', context: 'steps' }];
  const valid = { conclusion: 'Revenue increased.', evidenceIds: ['e1'], asOf: '2026-11-03',
    currency: 'USD', units: 'USD million', assumptions: [], gaps: [], skillVersions: [{ ...pins[0], context: undefined }],
    response: { thesis: 'Revenue increased.', evidencePoints: ['Reported revenue.'], risks: [], nextChecks: [] } };
  assert.equal(validateDelivery(valid, new Set(['e1']), pins).conclusion, valid.conclusion);
  assert.throws(() => validateDelivery({ ...valid, evidenceIds: ['foreign'] }, new Set(['e1']), pins));
  assert.throws(() => validateDelivery({ ...valid, units: '' }, new Set(['e1']), pins));
  assert.throws(() => validateDelivery({ ...valid, skillVersions: [] }, new Set(['e1']), pins));
  assert.throws(() => validateDelivery({ ...valid, skillVersions: [{ ...valid.skillVersions[0], hash: 'forged' }] }, new Set(['e1']), pins), /DELIVERY_SKILL_VERSION_INVALID/);
  assert.throws(() => validateDelivery({ ...valid, evidenceIds: [] }, new Set(['e1']), pins));
  assert.equal(validateDelivery({ ...valid, evidenceIds: [], gaps: ['Source unavailable'] }, new Set(), pins).gaps.length, 1);
});

test('atomic thesis candidates retain explicit boundaries in both languages without inventing missing structure', () => {
  const delivery = { conclusion: 'Finding', evidenceIds: ['e1', 'e2'], asOf: '2026-11-03', currency: null,
    units: 'ratio', assumptions: [], gaps: [], skillVersions: [],
    response: { thesis: 'Finding', evidencePoints: [], risks: [], nextChecks: [] } };
  for (const claim of ['Cash conversion remains resilient.', '现金转化能力仍有韧性。']) {
    const candidate = { claim, supportingEvidence: [{ evidenceId: 'e1' }], opposingEvidence: ['Margin pressure'],
      assumptions: [], indicators: ['Operating cash flow'], invalidationConditions: ['Two negative quarters'],
      boundaryOrigin: 'stated', horizon: { reviewAt: '2027-02-01T00:00:00.000Z' },
      evidenceRelations: [{ evidenceId: 'e1', role: 'support' }, { evidenceId: 'e2', role: 'refute' }] };
    const result = validateDelivery({ ...delivery, thesisCandidates: [candidate] }, new Set(['e1', 'e2']), []);
    assert.deepEqual(result.thesisCandidates, [{ ...candidate, provenance: { origin: 'agent' } }]);
  }
  assert.equal(validateDelivery(delivery, new Set(['e1', 'e2']), []).thesisCandidates, undefined);
  const sparse = { claim: 'Boundary is unknown', supportingEvidence: [], opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: [] };
  const normalized = validateDelivery({ ...delivery, thesisCandidates: [sparse] }, new Set(['e1', 'e2']), []).thesisCandidates![0];
  assert.equal(normalized.boundaryOrigin, 'unknown');
  assert.deepEqual(normalized.invalidationConditions, []);
  assert.equal(normalized.horizon, undefined);
});

test('atomic candidates reject foreign nested references, invented fields and invalid bounds', () => {
  const delivery = { conclusion: 'Finding', evidenceIds: ['e1'], asOf: '2026-11-03', currency: null,
    units: 'ratio', assumptions: [], gaps: [], skillVersions: [],
    response: { thesis: 'Finding', evidencePoints: [], risks: [], nextChecks: [] } };
  const candidate = { claim: 'A single claim', supportingEvidence: [{ evidenceId: 'e1' }], opposingEvidence: [],
    assumptions: [], indicators: [], invalidationConditions: [], boundaryOrigin: 'unknown', evidenceRelations: [] };
  for (const patch of [
    { supportingEvidence: [{ evidenceId: 'foreign' }] },
    { evidenceRelations: [{ evidenceId: 'foreign', role: 'refute' }] },
    { evidenceRelations: [{ evidenceId: 'e1', role: 'certain' }] },
    { correctnessProbability: 0.99 }, { provenance: { origin: 'user' } },
    { horizon: { startAt: '2027-01-02T00:00:00.000Z', endAt: '2027-01-01T00:00:00.000Z' } },
  ]) assert.throws(() => validateDelivery({ ...delivery, thesisCandidates: [{ ...candidate, ...patch }] }, new Set(['e1']), []));
  for (const thesisCandidates of [[], Array.from({ length: 6 }, () => candidate)]) {
    assert.throws(() => validateDelivery({ ...delivery, thesisCandidates }, new Set(['e1']), []));
  }
});
