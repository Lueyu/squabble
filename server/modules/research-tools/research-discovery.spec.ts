import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchDiscoveryService, verifiedIssuerEtfExposure } from './research-discovery.service';
import { DEFAULT_INVESTMENT_CONFIG } from '../paper-trading/investment-policy.rules';

test('discovery verifies identities, deduplicates aliases and rejects fabricated or leveraged instruments', async () => {
  const web = { search: async () => [{ sourceUrl: 'https://www.sec.gov/fixture', content: 'Fictional ABC company filing', title: 'ABC' }] };
  const market = { getSnapshot: async (ticker: string) => ({ ticker, market: 'US', currency: 'USD', providerSymbol: ticker, price: 100, quoteUsable: true, lotSize: 1, quoteTimestamp: new Date().toISOString() }) };
  class Discovery extends ResearchDiscoveryService {
    override async lookupSecurity(ticker: string) {
      return ticker === 'ABC' ? { symbol: 'ABC', quoteType: 'EQUITY', exchange: 'NMS', sourceUrl: 'https://query1.finance.yahoo.com/fixture' }
        : ticker === 'LEVER' ? { symbol: 'LEVER', quoteType: 'ETF', exchange: 'NMS', leveraged: true, inverse: false, sourceUrl: 'https://query1.finance.yahoo.com/fixture' }
          : null;
    }
  }
  const discovery = new Discovery(web as never, market as never);
  const result = await discovery.discoverCandidates('owner', { ...DEFAULT_INVESTMENT_CONFIG, markets: ['US'] }, 'task', async () => true, async () => ({ candidates: [
    { ticker: 'ABC', sourceUrl: 'https://www.sec.gov/fixture', summary: 'Fictional filing' },
    { ticker: 'abc', sourceUrl: 'https://www.sec.gov/fixture', summary: 'Duplicate alias' },
    { ticker: 'FAKE', sourceUrl: 'https://www.sec.gov/fixture', summary: 'Hallucination' },
    { ticker: 'LEVER', sourceUrl: 'https://www.sec.gov/fixture', summary: 'Leveraged fund' },
  ] }));
  assert.deepEqual(result.candidates.map(c => c.ticker), ['ABC']);
  assert.equal(result.excluded.length, 2);
});

test('ETF non-leverage requires the matching issuer objective, not a quote or ticker name', () => {
  const url = 'https://www.ssga.com/us/en/institutional/etfs/state-street-spdr-sp-500-etf-trust-spy';
  const objective = 'SPY State Street SPDR S&P 500 ETF Trust. Fund Objective: seeks to correspond generally to the price and yield performance of the S&P 500 Index.';
  assert.equal(verifiedIssuerEtfExposure('SPY', url, objective), true);
  assert.equal(verifiedIssuerEtfExposure('SPY', 'https://untrusted.example/spy', objective), false);
  assert.equal(verifiedIssuerEtfExposure('LEVER', url, objective), false);
  assert.equal(verifiedIssuerEtfExposure('SPY', url, 'SPY ETF. Targets two times the daily inverse index return.'), false);
});
