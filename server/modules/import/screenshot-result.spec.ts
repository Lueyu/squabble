import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScreenshotResult } from './screenshot-result';

test('normalizes fenced vision/local replies without inventing missing cost', () => {
  const result = parseScreenshotResult(
    '```json\n{"broker":"Demo","rows":[{"ticker":" TEST ","shares":"1.5","avgCost":null,"currency":"usd"}]}\n```',
  );
  assert.deepEqual(result, {
    broker: 'Demo',
    rows: [
      {
        ticker: 'TEST',
        company: null,
        shares: 1.5,
        avgCost: null,
        currentPrice: null,
        currency: 'USD',
      },
    ],
  });
});

test('rejects malformed and oversized envelopes', () => {
  for (const value of [
    null,
    {},
    { rows: Array(201).fill({ ticker: 'TEST', shares: 1 }) },
  ]) {
    assert.throws(
      () => parseScreenshotResult(JSON.stringify(value)),
      /INVALID_RESULT/,
    );
  }
  assert.throws(
    () => parseScreenshotResult('x'.repeat(512_001)),
    /INVALID_RESULT/,
  );
  assert.throws(() => parseScreenshotResult('{"rows":[]}'), /NO_HOLDINGS/);
});

test('one illegible row preserves nine good rows and the raw field for correction', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    ticker: `TEST${index}`,
    shares: index === 4 ? 'unclear' : 10,
    avgCost: null,
    currency: 'USD',
  }));
  const result = parseScreenshotResult(JSON.stringify({ rows }), 'image-one');
  assert.equal(result.rows.length, 9);
  assert.equal(result.problemRows?.length, 1);
  assert.equal(result.problemRows?.[0].raw.shares, 'unclear');
  assert.equal(result.problemRows?.[0].issues[0].field, 'shares');
  assert.equal(result.problemRows?.[0].sourceImageId, 'image-one');
});

test('missing currency requires explicit review and is never guessed from the ticker', () => {
  const result = parseScreenshotResult(
    JSON.stringify({ rows: [{ ticker: 'TEST', shares: 1, currency: null }] }),
  );
  assert.equal(result.rows.length, 0);
  assert.equal(
    result.problemRows?.[0].issues.some((issue) => issue.field === 'currency'),
    true,
  );
});

test('missing identity and bad optional values remain reviewable without zero substitution', () => {
  const result = parseScreenshotResult(
    JSON.stringify({
      rows: [
        { ticker: null, shares: null },
        { ticker: 'TEST', shares: 5, avgCost: -1 },
      ],
    }),
  );
  assert.equal(result.rows.length, 0);
  assert.equal(result.problemRows?.length, 2);
  assert.ok(
    result.problemRows?.[0].issues.some((issue) => issue.field === 'ticker'),
  );
});
