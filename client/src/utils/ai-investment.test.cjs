const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const filename = resolve(__dirname, 'ai-investment.ts');
const moduleUnderTest = { exports: {} };
if (existsSync(filename)) runInNewContext(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: moduleUnderTest, exports: moduleUnderTest.exports, Date });
const api = moduleUnderTest.exports;
test('a stale or unknown heartbeat never claims real time monitoring', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  assert.equal(api.displayInvestmentStatus?.('running', null, now), 'offline');
  assert.equal(api.displayInvestmentStatus?.('running', '2026-11-06T09:00:00Z', now), 'offline');
  assert.equal(api.displayInvestmentStatus?.('running', '2026-11-06T09:59:30Z', now), 'running');
  assert.equal(api.displayInvestmentStatus?.('paused', null, now), 'paused');
  assert.equal(api.displayInvestmentStatus?.('reassessing', null, now), 'reassessing');
});
test('cash seed requires explicit positive amount and supported original currency', () => {
  assert.equal(api.validCashSeed?.('', 'USD'), false);
  assert.equal(api.validCashSeed?.('0', 'USD'), false);
  assert.equal(api.validCashSeed?.('NaN', 'USD'), false);
  assert.equal(api.validCashSeed?.('100', 'EUR'), false);
  assert.equal(api.validCashSeed?.('100', 'HKD'), true);
});
test('missing or nonfinite returns remain unknown instead of becoming zero', () => {
  assert.equal(api.returnLabel?.(null), '—');
  assert.equal(api.returnLabel?.(NaN), '—');
  assert.equal(api.returnLabel?.(0), '0.00%');
  assert.equal(api.returnLabel?.(2.25), '+2.25%');
});
test('restriction drafts require the missing identity, range or expiry before confirmation', () => {
  const create = api.constraintDraft;
  assert.equal(create?.({ kind: 'no_sell', ticker: '' }), null);
  assert.equal(create?.({ kind: 'cash_floor', percent: '101' }), null);
  assert.equal(create?.({ kind: 'markets', markets: [] }), null);
  assert.equal(create?.({ kind: 'no_increase', expiresAt: 'not-a-date' }), null);
  assert.equal(JSON.stringify(create?.({ kind: 'no_sell', ticker: ' test ' })), JSON.stringify({ kind: 'no_sell', ticker: 'TEST', expiresAt: null }));
  assert.equal(JSON.stringify(create?.({ kind: 'markets', markets: ['HK', 'HK'] })), JSON.stringify({ kind: 'markets', markets: ['HK'], expiresAt: null }));
});
test('a paused account explicitly includes protective exits and a missing heartbeat stays unknown', () => {
  const { load, render, state } = require('./simple-test-loader.cjs')();
  const Status = load('pages/Paper/InvestmentStatus.tsx').default;
  state.language = 'en';
  assert.match(render(Status, { status: 'paused', lastHeartbeatAt: null }), /including stop-loss and protective exits/);
  assert.match(render(Status, { status: 'running', lastHeartbeatAt: null }), /heartbeat unknown/);
});
test('paper copy is short, permits waiting quotes, and has one optional virtual cash field per currency', () => {
  const { load, render, state } = require('./simple-test-loader.cjs')();
  const Start = load('pages/Paper/StartInvestmentCard.tsx').default;
  state.language = 'en';
  const limits = { maxPositionPct: 10, maxOrderPct: 5, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20, maxGrossExposurePct: 90, minCashPct: 10, dailyLossLimitPct: 3 };
  const html = render(Start, { preview: { id: 'preview', previewId: 'preview', seed: { capturedAt: '2026-11-06T00:00:00Z', positions: [{ ticker: 'TEST', shares: '20', currency: 'USD', sellableShares: '20' }], cash: [], initialEquityUsd: '1000', gaps: ['CASH_UNKNOWN'], model: { feeBps: 5, slippageBps: 10 } }, needsInput: ['CASH_UNKNOWN'], markets: ['US'], limits, budget: { dailyTasks: 6, maxCallsPerTask: 12 }, inheritedConcentration: ['TEST'], expiresAt: '2030-01-01T00:00:00Z' }, onStarted() {} });
  assert.match(html, /Assume zero recorded cash/);
  assert.match(html, /Copy and observe/);
  assert.match(html, /starts in observation/);
  assert.equal((html.match(/type="number"/g) || []).length, 3);
  assert.doesNotMatch(html, /Sellable shares|Allowed investment markets|may discover/);
  assert.doesNotMatch(html, /value="100000"/);
});
test('no-sell restriction confirmation explicitly warns that automatic protection is blocked', () => {
  const { load, render, state } = require('./simple-test-loader.cjs')();
  const Card = load('pages/Council/ConstraintProposalCard.tsx').default;
  state.language = 'en';
  const html = render(Card, { proposal: { id: 'p', text: 'Do not sell TEST', impact: 'Do not sell TEST', constraint: { kind: 'no_sell', ticker: 'TEST', expiresAt: null }, expiresAt: '2030-01-01T00:00:00Z', needsInput: [] }, onClose() {} });
  assert.match(html, /including this stock’s stop-loss and protective exits/);
  assert.match(html, /Apply to AI account/);
});
test('action evidence presents actual pre-trade sources and original review summaries without inventing a room', () => {
  const { load, render, state } = require('./simple-test-loader.cjs')();
  const Evidence = load('pages/Paper/DecisionCard.tsx').DecisionEvidence;
  assert.equal(typeof Evidence, 'function');
  state.language = 'en';
  const html = render(Evidence, { ticker: 'TEST', data: { actualExecutors: [{ memberId: 'actual-cli', connection: 'Connected research CLI', provider: 'Actual provider', model: 'saved-model', identity: 'source-one' }], actualResearch: [{ ticker: 'TEST', drafts: [{ memberId: 'actual-cli', draft: { summary: 'Original independent finding' } }], reviews: [{ memberId: 'actual-cli', summary: 'Original source cross-check', unresolvedDisagreements: ['Cash conversion remains uncertain'] }] }], evidence: [{ versionId: 'frozen-evidence' }], discussionId: null } });
  assert.match(html, /Connected research CLI/);
  assert.match(html, /saved-model/);
  assert.match(html, /Original independent finding/);
  assert.match(html, /Original source cross-check/);
  assert.match(html, /Cash conversion remains uncertain/);
  assert.match(html, /\/analysis\/reports\/frozen-evidence/);
  assert.doesNotMatch(html, /record was found|after-the-fact|\{&quot;/);
});
