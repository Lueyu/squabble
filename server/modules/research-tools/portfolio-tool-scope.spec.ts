import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frozenPortfolioInstruments, requireFrozenInstrument } from './portfolio-tool-scope';

test('portfolio tool scope uses frozen holdings intersected with the run allowlist', () => {
  const evidence = [{ sourceName: 'Frozen owner context', content: JSON.stringify({
    holdings: [{ ticker: 'AAPL', market: 'US', shares: '10' }, { ticker: '000001', market: 'CN', exchange: 'SZSE', shares: null }],
    cash: [{ amount: null, currency: 'HKD' }],
  }) }];
  const frozen = frozenPortfolioInstruments(evidence, ['US:AAPL']);
  assert.deepEqual(frozen.map(item => item.instrumentId), ['US:AAPL']);
  assert.throws(() => requireFrozenInstrument(frozen, 'US:MSFT'), /OUTSIDE_FROZEN_PORTFOLIO/);
  assert.equal(requireFrozenInstrument(frozen, 'us:aapl').ticker, 'AAPL');
  assert.equal(frozenPortfolioInstruments(evidence)[1].exchange, 'SZSE');
});

test('an absent or malformed frozen snapshot never expands scope to current owner holdings', () => {
  assert.deepEqual(frozenPortfolioInstruments([]), []);
  assert.throws(() => frozenPortfolioInstruments([{ sourceName: 'Frozen owner context', content: '{bad' }]), /FROZEN_PORTFOLIO_INVALID/);
  assert.deepEqual(frozenPortfolioInstruments([{ sourceName: 'Public news', content: '{bad' }]), []);
});
