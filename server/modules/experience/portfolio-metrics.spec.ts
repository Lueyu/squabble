import test from 'node:test';
import assert from 'node:assert/strict';
import { computePortfolioMetrics, resolvePortfolioFx } from './portfolio-metrics';

const at = new Date('2026-11-06T04:00:00Z');
const quote = { symbol: 'ACME', price: '110', previousClose: '100', currency: 'USD', market: 'US',
  quoteAt: '2026-11-05T21:00:00Z', tradingDate: '2026-11-05', source: 'fixture' };
const holding = { ticker: 'ACME', shares: '10', currentPrice: '110', currency: 'USD', market: 'US' };
const cash = { currency: 'USD', balance: '500', reconciliationStatus: 'confirmed' };
const calculate = (changes: Record<string, unknown> = {}) => computePortfolioMetrics({ at, timezone: 'Asia/Shanghai',
  holdings: [holding], cash: [cash], rates: [], quotes: { ACME: quote }, transactions: [], ...changes } as Parameters<typeof computePortfolioMetrics>[0]);

test('portfolio valuation resolves reverse dated FX and never uses future or invalid rates', () => {
  const rates = [{ base: 'USD', quote: 'HKD', rate: '8', rateDate: '2026-11-05' },
    { base: 'HKD', quote: 'USD', rate: '5', rateDate: '2026-11-07' }];
  assert.equal(resolvePortfolioFx(rates, 'HKD', '2026-11-06')?.rate, 0.125);
  assert.equal(resolvePortfolioFx([{ ...rates[0], rate: '0' }], 'HKD', '2026-11-06'), null);
  assert.equal(resolvePortfolioFx([rates[0],{base:'HKD',quote:'USD',rate:'0.13',rateDate:'2026-11-05'}],'HKD','2026-11-06')?.rate,0.13,'same-date direct pair is stable regardless of database order');
  const value = calculate({ holdings: [{ ...holding, currency: 'HKD', market: 'HK', currentPrice: '80' }],
    cash: [{ ...cash, currency: 'HKD', balance: '800' }], quotes: {}, rates });
  assert.equal(value.totalValueUsd, 200);
  assert.equal(value.cashUsd, 100);
  assert.equal(value.estimated, true);
});

test('daily holding return starts from previous close and includes confirmed cash in its denominator', () => {
  const value = calculate();
  assert.equal(value.totalValueUsd, 1600);
  assert.equal(value.dailyPnlUsd, 100);
  assert.ok(Math.abs(value.returnPct! - 100 / 1500 * 100) < 1e-6);
});

test('intraday buys, sells and fees preserve starting holdings and include sold quantity', () => {
  const transactions = [
    { ticker: 'ACME', txType: 'Buy', txDate: '2026-11-05', shares: '2', price: '105', fees: '1', currency: 'USD' },
    { ticker: 'ACME', txType: 'Sell', txDate: '2026-11-05', shares: '3', price: '108', fees: '1', currency: 'USD' },
  ];
  const value = calculate({ holdings: [{ ...holding, shares: '9' }], cash: [{ ...cash, balance: '612' }], transactions });
  assert.equal(value.totalValueUsd, 1602);
  assert.equal(value.dailyPnlUsd, 102);
  assert.ok(Math.abs(value.returnPct! - 6.8) < 1e-6);
  const funded = calculate({ holdings: [{ ...holding, shares: '9' }], cash: [{ ...cash, balance: '1612' }],
    transactions: [...transactions, { ticker: '', txType: 'Deposit', txDate: '2026-11-05', shares: '1000', price: '1', fees: '0', currency: 'USD' }] });
  assert.equal(funded.dailyPnlUsd, 102);
  assert.equal(funded.returnPct, value.returnPct, 'new cash is not investment performance');
});

test('a fully sold stock remains in daily P/L while proceeds remain in cash', () => {
  const value = calculate({ holdings: [], cash: [{ ...cash, balance: '1578' }], transactions: [
    { ticker: 'ACME', txType: 'Sell', txDate: '2026-11-05', shares: '10', price: '108', fees: '2', currency: 'USD' },
  ] });
  assert.equal(value.totalValueUsd, 1578);
  assert.equal(value.dailyPnlUsd, 78);
  assert.ok(Math.abs(value.returnPct! - 5.2) < 1e-6);
});

test('missing previous close or actual quote date does not manufacture a zero daily return', () => {
  for (const broken of [{ ...quote, previousClose: undefined }, { ...quote, quoteAt: undefined },
    { ...quote, tradingDate: '2026-11-04' }]) {
    const value = calculate({ quotes: { ACME: broken } });
    assert.equal(value.dailyPnlUsd, null);
    assert.equal(value.returnPct, null);
    assert.equal(value.knownValueUsd, 1600);
  }
});

test('unconfirmed or conflicting cash is excluded from complete equity but known holdings remain visible', () => {
  const value = calculate({ cash: [{ ...cash, balance: '1000', reconciliationStatus: 'review' }] });
  assert.equal(value.totalValueUsd, null);
  assert.equal(value.knownValueUsd, 1100);
  assert.equal(value.partial, true);
  assert.equal(value.returnPct, null);
  const duplicate = calculate({ cash: [cash, cash] });
  assert.equal(duplicate.totalValueUsd, null);
  assert.equal(duplicate.knownValueUsd, 1100, 'duplicate balances must not be summed');
});

test('missing FX keeps a partial known value rather than treating currencies as equivalent', () => {
  const value = calculate({ holdings: [holding, { ticker: 'HKACME', shares: '10', currentPrice: '80', currency: 'HKD', market: 'HK' }] });
  assert.equal(value.totalValueUsd, null);
  assert.equal(value.knownValueUsd, 1600);
  assert.equal(value.partial, true);
});

test('future quotes never replace an imported valuation and deposit fees remain investment costs',()=>{
  const future=calculate({quotes:{ACME:{...quote,price:'999',quoteAt:'2026-11-07T21:00:00Z',tradingDate:'2026-11-07'}}});
  assert.equal(future.knownValueUsd,1600);
  const funded=calculate({cash:[{...cash,balance:'1495'}],transactions:[
    {ticker:'',txType:'Deposit',txDate:'2026-11-06',shares:'1000',price:'1',fees:'5',currency:'USD'},
  ]});
  assert.equal(funded.dailyPnlUsd,95);
  assert.ok(Math.abs(funded.returnPct!-95/1500*100)<1e-6);
});

test('same-session stale observations and unconfirmed cash fees cannot look like complete daily P/L',()=>{
  const stale=calculate({at:new Date('2026-11-05T18:00:00Z'),quotes:{ACME:{...quote,quoteAt:'2026-11-05T14:30:00Z'}}});
  assert.equal(stale.dailyPnlUsd,null);
  const uncertain=calculate({cash:[{...cash,reconciliationStatus:'unconfirmed'}],transactions:[
    {ticker:'',txType:'Fee',txDate:'2026-11-05',shares:'5',price:'1',fees:'0',currency:'USD'},
  ]});
  assert.equal(uncertain.dailyPnlUsd,null);
});
test('an opening-session quote is not a verified closing value on the following day',()=>{
  const value=calculate({quotes:{ACME:{...quote,quoteAt:'2026-11-05T14:30:00Z'}}});
  assert.equal(value.dailyPnlUsd,null);
  assert.equal(value.returnPct,null);
  assert.ok(value.gaps.includes('QUOTE_TIME_UNVERIFIED:ACME'));
});
test('confirmed empty currencies do not require FX and a missing holding-currency cash account is unknown',()=>{
  const zeroCurrencies=calculate({cash:[cash,{currency:'HKD',balance:'0',reconciliationStatus:'confirmed'},{currency:'CNY',balance:'0',reconciliationStatus:'confirmed'}]});
  assert.equal(zeroCurrencies.totalValueUsd,1600);
  assert.equal(zeroCurrencies.dailyPnlUsd,100);
  const missing=calculate({holdings:[{...holding,currency:'HKD',market:'HK'}],rates:[{base:'USD',quote:'HKD',rate:'8',rateDate:'2026-11-05'}],quotes:{}});
  assert.equal(missing.totalValueUsd,null);
  assert.ok(missing.gaps.includes('CASH_UNCONFIRMED:HKD'));
});
test('known cash fees remain investment costs even while the opening cash balance needs confirmation',()=>{
  const value=calculate({cash:[{...cash,reconciliationStatus:'unconfirmed'}],transactions:[{ticker:'',txType:'Fee',txDate:'2026-11-05',shares:'5',price:'1',fees:'0',currency:'USD'}]});
  assert.equal(value.dailyPnlUsd,null);
  assert.equal(value.knownDailyPnlUsd,95);
});
test('one dated quote does not certify other holdings in the same market',()=>{
  for(const holdings of [[holding,{...holding,ticker:'UNDATED'}],[{...holding,ticker:'UNDATED'},holding]]){
    const value=calculate({holdings});
    assert.equal(value.marketTimes[0].dataAsOf,null);
    assert.equal(value.dailyPnlUsd,null);
  }
});
