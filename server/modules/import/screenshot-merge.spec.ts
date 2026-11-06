import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScreenshotRows } from './screenshot-merge';
test('overlapping pages merge sources without adding quantities and preserve conflicts', () => {
  const merged = mergeScreenshotRows([
    {
      id: 'a',
      sourceImageIds: ['one'],
      ticker: '0700',
      market: 'HK',
      shares: 100,
      avgCost: 300,
      currency: 'HKD',
    },
    {
      id: 'b',
      sourceImageIds: ['two'],
      ticker: '700.HK',
      market: 'HK',
      shares: 100,
      avgCost: 300,
      currency: 'HKD',
    },
    {
      id: 'c',
      sourceImageIds: ['three'],
      ticker: '0700',
      market: 'HK',
      shares: 200,
      avgCost: 300,
      currency: 'HKD',
    },
    {
      id: 'd',
      sourceImageIds: ['four'],
      ticker: 'TEST',
      market: 'US',
      company: 'same name',
      shares: 5,
      avgCost: null,
    },
    {
      id: 'e',
      sourceImageIds: ['five'],
      ticker: '600000',
      market: 'CN',
      company: 'same name',
      shares: 7,
      avgCost: null,
    },
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].shares, 100);
  assert.deepEqual(merged[0].sourceImageIds, ['one', 'two', 'three']);
  assert.equal(merged[0].conflicts?.[0].field, 'shares');
  assert.deepEqual(
    merged[0].conflicts?.[0].candidates.map((candidate) => candidate.value),
    [100, 200],
  );
});
