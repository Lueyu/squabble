const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');

function accountFixture(started) {
  const f = fixture();
  f.state.queries.set('ai-investment', { data: { account: started ? { id: 'fictional-account' } : null,
    policy: started ? { status: 'observing', revision: 1 } : null, currentStrategy: null,
    limits: {}, budget: {}, cycles: [], legacyAccounts: [], actions: [], holdings: [], constraints: [], waitingReasons: [] } });
  f.state.queries.set('investment-strategies', { data: { current: null, drafts: [], history: [] } });
  return f;
}

test('the simulation page manages strategies in place after account setup', () => {
  const f = accountFixture(true);
  const html = f.render(f.load('pages/Paper/AiInvestmentPage.tsx').default);
  assert.match(html, /id="investment-strategy"/);
  assert.match(html, /href="\/council"/);
  assert.doesNotMatch(html, /View and apply strategy on Today/);
});

test('an imported draft survives first account setup without an editor blocking setup', () => {
  const f = accountFixture(false);
  const Page = f.load('pages/Paper/AiInvestmentPage.tsx').default;
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/paper?investmentStrategyId=imported-draft'] }, React.createElement(Page)));
  assert.match(html, /Your copied strategy is saved/);
  assert.match(html, /Create your simulated account/);
  assert.doesNotMatch(html, /id="investment-strategy"/);
  assert.match(html, /Start with simulated cash/);
});

test('trade receipts link back to their exact strategy in the simulation', () => {
  const f = fixture();
  const Card = f.load('pages/Paper/DecisionCard.tsx').default;
  const html = f.render(Card, { action: { id: 'order-one', ticker: 'FICT', side: 'buy', quantity: 2, status: 'filled', strategyId: 'strategy-one', strategyEntryId: 'one', createdAt: '2026-11-07T00:00:00Z' } });
  assert.match(html, /href="\/paper\?investmentStrategyId=strategy-one#investment-strategy"/);
});

test('simulation header and strategy card agree on effective authority, dates and heartbeat', () => {
  const now = Date.now(), past = new Date(now - 3600000).toISOString(), future = new Date(now + 3600000).toISOString();
  const strategy = { id: 'fictional-strategy', revision: 1, status: 'confirmed', confirmedAt: past, sources: [],
    content: { title: 'Fictional strategy', body: '', timezone: 'Asia/Shanghai', startsAt: past, endsAt: future,
      entries: [{ id: 'first', text: 'Fictional condition', sourceKeys: [] }] },
    preview: { entries: [], directives: [{ entryId: 'first' }], mandateRules: [], issues: [], canConfirm: true } };
  const cases = [
    { name: 'observation', plan: { ...strategy, preview: { ...strategy.preview, directives: [] } }, en: 'Observation only, no automatic trades', zh: '仅观察，不自动买卖' },
    { name: 'future strategy', plan: { ...strategy, content: { ...strategy.content, startsAt: future } }, en: 'Starts later', zh: '等待生效' },
    { name: 'future entries', plan: { ...strategy, content: { ...strategy.content, entries: [{ ...strategy.content.entries[0], startsAt: future }] } }, en: 'Starts later', zh: '等待生效' },
    { name: 'expired strategy', plan: { ...strategy, content: { ...strategy.content, endsAt: past } }, en: 'Expired', zh: '已到期' },
    { name: 'expired entries', plan: { ...strategy, content: { ...strategy.content, entries: [{ ...strategy.content.entries[0], endsAt: past }] } }, en: 'Expired', zh: '已到期' },
    { name: 'paused', plan: strategy, paused: true, en: 'Automatic trading paused', zh: '自动交易已暂停' },
    { name: 'missing heartbeat', plan: strategy, heartbeat: null, en: 'Service offline or heartbeat unknown', zh: '服务离线或心跳未知' },
    { name: 'stale heartbeat', plan: strategy, heartbeat: past, en: 'Service offline or heartbeat unknown', zh: '服务离线或心跳未知' },
    { name: 'disabled executor', plan: strategy, disabled: true, en: 'Automatic trading stopped', zh: '自动交易已停止' },
    { name: 'reassessing with unknown heartbeat', plan: strategy, heartbeat: null, busy: true, en: 'Service offline or heartbeat unknown', zh: '服务离线或心跳未知' },
    { name: 'reassessing with current heartbeat', plan: strategy, busy: true, en: 'Reassessing current conditions', zh: '正在重新评估' },
    { name: 'running', plan: strategy, en: 'Automatic trading enabled', zh: '自动交易已开启' },
  ];
  for (const scenario of cases) for (const language of ['en', 'zh-CN']) {
    const f = accountFixture(true); f.state.language = language;
    const investment = f.state.queries.get('ai-investment').data;
    Object.assign(investment, { status: scenario.paused ? 'paused' : 'running', currentStrategy: scenario.plan,
      account: { id: 'fictional-account', botEnabled: !scenario.disabled },
      policy: { status: scenario.paused ? 'paused' : 'running', revision: 1 },
      cycles: scenario.busy ? [{ state: 'researching' }] : [],
      lastHeartbeatAt: 'heartbeat' in scenario ? scenario.heartbeat : new Date(now).toISOString() });
    f.state.queries.set('investment-strategies', { data: { current: scenario.plan, drafts: [], history: [] } });
    const dom = new JSDOM(f.render(f.load('pages/Paper/AiInvestmentPage.tsx').default));
    const expected = language === 'en' ? scenario.en : scenario.zh;
    assert.ok(dom.window.document.querySelector('[role="status"]').textContent.includes(expected), `${scenario.name}: header (${language})`);
    assert.equal(dom.window.document.querySelector('#investment-strategy span.rounded-full').textContent, expected, `${scenario.name}: strategy card (${language})`);
    dom.window.close();
  }
});
