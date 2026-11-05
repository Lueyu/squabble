import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScreenshotResult } from './screenshot-result';

test('normalizes fenced vision/local replies without inventing missing cost', () => {
  const result = parseScreenshotResult('```json\n{"broker":"Demo","rows":[{"ticker":" TEST ","shares":"1.5","avgCost":null,"currency":"usd"}]}\n```');
  assert.deepEqual(result, { broker: 'Demo', rows: [{ ticker: 'TEST', company: null, shares: 1.5, avgCost: null, currentPrice: null, currency: 'USD' }] });
});

test('rejects malformed, oversized or ambiguous numeric extraction instead of partial import', () => {
  for (const value of [null, {}, { rows: [null] }, { rows: Array(201).fill({ ticker: 'TEST', shares: 1 }) },
    ...[null, '', false, '1,000', -1, 0, 'NaN'].map(shares => ({ rows: [{ ticker: 'TEST', shares }] })),
    { rows: [{ ticker: 'TEST', shares: 1, avgCost: -1 }] },
    { rows: [{ ticker: 'TEST', shares: 1, currency: 'UNKNOWN' }] }]) {
    assert.throws(() => parseScreenshotResult(JSON.stringify(value)), /INVALID_RESULT/);
  }
  assert.throws(() => parseScreenshotResult('x'.repeat(512_001)), /INVALID_RESULT/);
  assert.throws(() => parseScreenshotResult('{"rows":[]}'), /NO_HOLDINGS/);
});
