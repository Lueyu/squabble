import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBuilderService } from './agent-builder.service';
import { normalizeBuilderConfig, normalizeCouncil } from './agent-builder.rules';
import { DEFAULT_STRATEGY_AUTOMATION } from '../../../shared/strategy.interface';

test('automatic preview explains daily plans, fast review and protected exits while preserving the legacy preview', () => {
  const service = new AgentBuilderService({} as never, {} as never);
  const config = normalizeBuilderConfig({ name: 'Preview', template: 'balanced', tickers: ['AAPL'],
    minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 2,
    notifyOnProposal: false, council: { ...normalizeCouncil(), enabled: true } });
  const automatic = { ...config, automation: { ...DEFAULT_STRATEGY_AUTOMATION, enabled: true } };
  assert.deepEqual(service.preview(automatic).scenarios.map(({ key, result }) => ({ key, result })), [
    { key: 'daily-plan-trigger', result: 'paper' },
    { key: 'review-wait', result: 'wait' },
    { key: 'protective-stop', result: 'paper' },
    { key: 'invalid-data', result: 'wait' },
  ]);
  assert.equal(service.preview({ ...automatic, template: 'guard' }).scenarios[0].result, 'block');
  assert.ok(service.preview(config).scenarios.some((scenario) => scenario.key === 'rated-buy'));
  assert.ok(!service.preview(automatic).scenarios.some((scenario) => scenario.key === 'rated-buy'));
});
