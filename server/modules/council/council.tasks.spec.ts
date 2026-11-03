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
  assert.throws(() => validateDelivery({ ...valid, evidenceIds: [] }, new Set(['e1']), pins));
  assert.equal(validateDelivery({ ...valid, evidenceIds: [], gaps: ['Source unavailable'] }, new Set(), pins).gaps.length, 1);
});
