'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('./fixture-server.cjs');

const args = process.argv.slice(2);
const realOnly = args.includes('--real-only');
const holdingsFiltersOnly = args.includes('--holdings-filters');
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const dist = path.resolve(option('--dist', path.join(__dirname, '../../dist/client')));
const output = path.resolve(option('--output', 'output/playwright/overview-accounts'));
const widths = args.includes('--width') ? [Number(option('--width'))] : [1440, 1920, 2560, 390, 3840];
const [paperA, paperB, pendingPaper, formerPaper] = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
];
const first = '2026-11-17T01:35:00.000Z';
const outside = '2026-11-04T02:15:00.000Z';
const to = '2026-11-18T02:10:00.000Z';
const paperTime = '2026-11-18T02:05:00.000Z';
const orderId = 'fictional-account-order';
const title = 'Fictional published daily';

function point(timestamp, equityUsd, returnPct, gaps = []) {
  return { timestamp, date: timestamp.slice(0, 10), equityUsd, returnPct, gaps };
}

async function fictionalRoutes(context, origin, language) {
  const zh = language === 'zh-CN';
  const accounts = (realOnly ? [] : [paperA, paperB, pendingPaper]).map((id, index) => ({
    id,
    name: (zh ? ['青岚模拟账户', '长期模拟账户', '待估值模拟账户'] : ['Fictional Alpha', 'Fictional Long View', 'Fictional Waiting'])[index],
    status: 'paused',
    companionId: ['moderator', 'technical', 'news'][index],
    createdAt: ['2026-11-17T01:00:00.000Z', outside, first][index],
    equityUsd: index === 2 ? null : '1100',
    cashBalance: '1000',
    strategyCount: 0,
    policyRevision: 1,
  }));
  const former = {
    ...accounts[0], id: formerPaper, name: zh ? '历史模拟账户' : 'Historical simulation',
    formerTeam: { id: 'fictional-archived-team', name: zh ? '历史研究团队' : 'Historical research team' },
  };
  const seen = [];
  const imports = [];
  let pendingAccounts;
  const assets = accountId => ({
    accountId,
    positions: [{ id: accountId, ticker: accountId === paperA ? 'PAPERA' : accountId === formerPaper ? 'PAST' : 'PAPERB', shares: '4', avgCost: null,
      currentPrice: null, company: null, currency: 'USD', market: 'US', marketValue: null, unrealizedPl: null }],
    cash: [
      { currency: 'CNY', availabilityKnown: true, available: '9170', frozen: '0', unsettled: '0' },
      { currency: 'USD', availabilityKnown: true, available: '10000', frozen: '0', unsettled: '0' },
      { currency: 'HKD', availabilityKnown: false, available: null, frozen: null, unsettled: null },
    ],
    orders: accountId === paperA ? [{ id: orderId, ticker: 'PAPERA', status: 'filled', side: 'buy', quantity: '4',
      filledPrice: '25.50', currency: 'USD', filledAt: paperTime, createdAt: paperTime }] : [],
    trades: [],
    equityUsd: '1100',
    valuedAt: paperTime,
    gaps: [],
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/')) seen.push(url);
    if (pathname === '/api/ai-investment/accounts') {
      await pendingAccounts;
      return route.fulfill({ json: realOnly ? accounts : [...accounts, former] });
    }
    if (pathname.startsWith('/api/ai-investment/accounts/') && pathname.endsWith('/assets')) {
      return route.fulfill({ json: assets(pathname.split('/')[4]) });
    }
    if (pathname === '/api/teams') return route.fulfill({ json: {
      items: [{
        id: 'fictional-overview-team', name: 'Fictional team', accountId: paperA, binding: { state: 'active' }, status: 'active',
        cost: { confirmed: { amount: null, currency: 'USD' }, externalUsageUnknown: false, unknownAttemptIds: [] },
      }],
      total: 1, nextCursor: null, capabilities: { workspaceEnabled: true, researchEnabled: true },
    } });
    if (pathname === '/api/ai-investment/comparison') {
      const period = url.searchParams.get('period');
      const from = period === '1D' ? '2026-11-17T02:10:00.000Z' : '2026-11-11T02:10:00.000Z';
      const real = [
        point('2026-11-12T02:10:00.000Z', 10000, 0),
        point('2026-11-13T02:10:00.000Z', 10060, 0.6),
        point('2026-11-16T02:10:00.000Z', null, null, ['MISSING_OBSERVATION']),
        point('2026-11-17T03:10:00.000Z', 10100, 1),
        point(to, 10120, 1.2),
      ];
      const a = [point(first, 1000, 0), point('2026-11-17T03:10:00.000Z', 1002, 0.2), point(paperTime, 1008, 0.8)];
      const b = [point(outside, 1000, 0), point('2026-11-12T02:10:00.000Z', 1002, 0.2), point(paperTime, 1010, 1)];
      const waiting = [point(paperTime, null, null, ['INCOMPLETE_VALUATION'])];
      const comparisonAccounts = realOnly ? accounts : [...accounts, former];
      const series = [{ id: 'real', name: 'Real portfolio', status: 'real', createdAt: null }, ...comparisonAccounts].map((account, index) => {
        const visible = [real, a, b, waiting, b][index].filter(item => item.timestamp >= from);
        const points = realOnly && period === '1D' ? visible.slice(-1).map(item => ({ ...item, returnPct: null }))
          : realOnly && ['1M', '3M'].includes(period)
            ? visible.map(item => point(item.timestamp, null, null, ['INCOMPLETE_VALUATION', 'CASH_UNCONFIRMED']))
            : visible;
        const latest = points.at(-1);
        return {
          accountId: account.id, name: account.name, kind: index === 0 ? 'real' : 'simulation', status: account.status,
          createdAt: account.createdAt, firstIncludedAt: [null, first, outside, null, outside][index], colorIndex: index - 1,
          valuationAsOf: latest?.equityUsd != null ? latest.timestamp : null,
          equityUsd: latest?.equityUsd ?? null, returnPct: latest?.returnPct ?? null, returnFrom: points[0]?.timestamp ?? null,
          strategyCount: 0, points, gaps: points.flatMap(item => item.gaps),
        };
      });
      return route.fulfill({ json: { currency: 'USD', period, from, to, granularity: 'observations',
        methodology: 'saved_valuations_no_external_flows', series } });
    }
    if (pathname === '/api/portfolio-history') {
      const period = url.searchParams.get('period');
      if (period === '1D') return route.fulfill({ status: 503, json: {} });
      const date = '2026-11-13';
      const quote = { date, valueUsd: 9875, knownValueUsd: 9875, coveredPositions: 1, totalPositions: 1,
        priceAsOf: [{ ticker: 'FICT', date, source: 'fictional-close' }], fxAsOf: [], gaps: [] };
      const points = realOnly && period === '1M' ? [] : realOnly && period === '3M'
        ? ['2026-11-12', date, '2026-11-16'].map(day => ({
          ...quote, date: day, valueUsd: null, knownValueUsd: day === date ? 9900 : 9875, totalPositions: 2,
          priceAsOf: [{ ticker: 'FICT', date: day, source: 'fictional-close' }], gaps: ['COHORT_EXCLUDED:EXMP'],
        })) : [quote];
      return route.fulfill({ json: { refreshing: false, series: [{ accountId: 'real', points, gaps: [],
        coverage: { completePoints: points.filter(item => item.valueUsd !== null).length,
          totalPoints: points.length, coveredPositions: points.at(-1)?.coveredPositions ?? 0, totalPositions: points.at(-1)?.totalPositions ?? 0 } }] } });
    }
    if (pathname === '/api/daily-workspace/research') return route.fulfill({ json: {
      date: url.searchParams.get('date'), timezone: 'Asia/Shanghai', latest: null,
      reports: [{ versionId: 'fictional-daily', sessionId: 'fictional-session', title, createdAt: to, readAt: to,
        factsHash: 'fictional', content: 'Fictional published daily body' }],
    } });
    if (pathname === '/api/daily-workspace') return route.fulfill({ json: {
      date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
      readAt: to, accounts: [], personal: { returnBasis: { pnlUsd: null }, transactions: [], gaps: [] },
      reports: { initial: null, latestDiscussion: null, history: [] },
    } });
    if (pathname === '/api/import/batches' || pathname === '/api/import/history') return route.fulfill({ json: [] });
    if (pathname === '/api/portfolio/holdings') return route.fulfill({ json: { items: [
      { id: 'known', ticker: '600000', company: 'Fictional priced holding', market: 'CN', currency: 'CNY',
        shares: '400', buyPrice: '31.20', currentPrice: '32.10', updatedAt: to },
      { id: 'unknown', ticker: 'EXMP', company: 'Fictional unpriced holding', market: 'US', currency: 'USD',
        shares: '80', buyPrice: '42.20', currentPrice: null, updatedAt: to },
    ], total: 2 } });
    if (pathname === '/api/quote/batch') return route.fulfill({ json: { items: [
      { symbol: '600000', market: 'CN', currency: 'CNY', price: '32.10', quoteAt: to },
    ] } });
    if (pathname === '/api/cash') return route.fulfill({ json: { items: [
      { id: 'fixture-cash', currency: 'CNY', balance: '9170', reconciliationStatus: 'confirmed', updatedAt: to },
    ] } });
    if (pathname === '/api/import/commit' && route.request().method() === 'POST') {
      imports.push(route.request().postDataJSON());
      return route.fulfill({ json: { receiptId: 'fictional-import', created: 1, updated: 0, skipped: 0, failed: [] } });
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  return {
    accounts, former, seen, imports,
    delayAccounts() {
      let release;
      pendingAccounts = new Promise(resolve => { release = resolve; });
      return release;
    },
  };
}

async function verifyHoldingsFilters(page, language, label) {
  const word = (zh, en) => language === 'zh-CN' ? zh : en;
  const account = page.getByRole('combobox', { name: word('切换资产账户', 'Switch asset account') });
  const market = page.getByRole('button', { name: word('市场筛选', 'Market filter') });
  const currency = page.getByRole('combobox', { name: word('币种', 'Currency') });
  const rows = page.getByRole('region', { name: word('持仓明细', 'Position details'), exact: true }).getByRole('rowheader');
  const allMarkets = word('全部市场', 'All markets');
  const allCurrencies = word('全部币种', 'All currencies');
  const params = () => new URL(page.url()).searchParams;
  const focused = locator => locator.and(page.locator(':focus')).waitFor();
  const style = (locator, properties) => locator.evaluate((element, names) => {
    const computed = getComputedStyle(element);
    return names.map(name => computed.getPropertyValue(name));
  }, properties);

  await rows.last().waitFor();
  const triggerProperties = ['height', 'background-color', 'border-color', 'border-radius', 'border-width',
    'font-size', 'padding-inline', 'gap'];
  const accountStyle = await style(account, triggerProperties);
  assert.deepEqual(await style(market, triggerProperties), accountStyle, 'market trigger matches the account Select');
  assert.deepEqual(await style(currency, triggerProperties), accountStyle, 'currency trigger matches the account Select');

  const menuProperties = ['background-color', 'color', 'border-color', 'border-radius', 'border-width', 'box-shadow'];
  const optionProperties = ['font-size', 'padding-inline-start', 'padding-inline-end', 'padding-block', 'border-radius'];
  const accountList = page.getByRole('listbox');
  await account.press('Enter');
  await accountList.waitFor();
  const accountMenuStyle = await style(accountList, menuProperties);
  const accountOptionStyle = await style(accountList.getByRole('option').first(), optionProperties);
  await page.keyboard.press('Escape');
  await accountList.waitFor({ state: 'hidden' });

  await market.press('ArrowDown');
  const menu = page.getByRole('menu', { name: word('市场筛选', 'Market filter') });
  const marketOption = name => menu.getByRole('menuitemcheckbox', { name, exact: true });
  const clearMarkets = menu.getByRole('menuitem', { name: allMarkets, exact: true });
  const hk = marketOption(word('港股', 'HK'));
  const us = marketOption(word('美股', 'US'));
  const cn = marketOption(word('A股', 'CN'));
  await menu.waitFor();
  assert.deepEqual(await style(menu, menuProperties), accountMenuStyle, 'market menu matches the account Select');
  assert.deepEqual(await style(hk, optionProperties), accountOptionStyle, 'market checkbox spacing matches the account Select');
  assert.equal(await hk.getAttribute('aria-checked'), 'true');
  await focused(clearMarkets);
  await page.keyboard.press('ArrowDown');
  await focused(us);
  await page.keyboard.press('ArrowDown');
  await focused(hk);
  await page.keyboard.press('Space');
  await page.waitForURL(url => url.searchParams.get('markets') === 'US,CN');
  await hk.and(page.locator('[aria-checked="false"]')).waitFor();
  assert.equal(await us.getAttribute('aria-checked'), 'true');
  assert.equal(await cn.getAttribute('aria-checked'), 'true');
  await page.screenshot({ path: path.join(output, label + '-market-filter.png'), animations: 'disabled' });
  await page.keyboard.press('ArrowUp');
  await focused(us);
  await page.keyboard.press('Space');
  await page.waitForURL(url => url.searchParams.get('markets') === 'CN');
  await us.and(page.locator('[aria-checked="false"]')).waitFor();
  await page.keyboard.press('Escape');
  await focused(market);
  await rows.filter({ hasText: 'Fictional priced holding' }).waitFor();
  assert.equal(await rows.count(), 1);
  await market.press('ArrowDown');
  await focused(clearMarkets);
  await page.keyboard.press('ArrowDown');
  await focused(us);
  await page.keyboard.press('Space');
  await page.waitForURL(url => url.searchParams.get('markets') === 'US,CN');
  await us.and(page.locator('[aria-checked="true"]')).waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await focused(market);
  assert.equal((await market.textContent()).trim(), word('多个市场', 'Multiple markets'));
  assert.equal(await rows.count(), 2);

  await currency.press('Enter');
  const currencyList = page.getByRole('listbox');
  const currencyOption = name => currencyList.getByRole('option', { name, exact: true });
  await currencyList.waitFor();
  assert.deepEqual(await style(currencyList, menuProperties), accountMenuStyle, 'currency menu matches the account Select');
  await focused(currencyOption(allCurrencies));
  assert.equal(await currencyOption(allCurrencies).getAttribute('aria-selected'), 'true');
  await page.screenshot({ path: path.join(output, label + '-currency-filter.png'), animations: 'disabled' });
  await page.keyboard.press('ArrowDown');
  await focused(currencyOption('CNY'));
  await page.keyboard.press('ArrowDown');
  await focused(currencyOption('USD'));
  await page.keyboard.press('Enter');
  await page.waitForURL(url => url.searchParams.get('currency') === 'USD');
  assert.equal(params().get('markets'), 'US,CN');
  await focused(currency);
  await rows.filter({ hasText: 'Fictional priced holding' }).waitFor({ state: 'detached' });
  assert.equal(await rows.count(), 1);

  await page.reload();
  await rows.filter({ hasText: 'Fictional unpriced holding' }).waitFor();
  assert.equal(await rows.count(), 1);
  assert.equal((await currency.textContent()).trim(), 'USD');
  await market.click();
  await menu.waitFor();
  assert.equal(await hk.getAttribute('aria-checked'), 'false');
  await clearMarkets.click();
  await page.waitForURL(url => !url.searchParams.has('markets') && url.searchParams.get('currency') === 'USD');
  await menu.waitFor({ state: 'hidden' });
  await currency.click();
  await currencyOption(allCurrencies).click();
  await page.waitForURL(url => url.search === '?accountId=real');
  await rows.filter({ hasText: 'Fictional priced holding' }).waitFor();
  assert.equal(await rows.count(), 2);
  assert.equal((await geometry(page)).horizontalOverflow, false, 'filtered holdings fit the viewport');
}

async function geometry(page) {
  return page.evaluate(() => {
    const box = element => {
      const rect = element?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom } : null;
    };
    const main = document.querySelector('.app-content');
    const container = document.querySelector('.portfolio-page');
    const brand = document.querySelector('.app-brand');
    const mark = brand.querySelector('.squabble-mascot img');
    return {
      tabs: box(document.querySelector('.workspace-section-tabs')),
      page: box(container),
      chart: box(container?.querySelector('.portfolio-comparison')),
      sections: [...(container?.querySelectorAll('section') ?? [])].map(box),
      logo: mark ? { ...box(mark), src: mark.getAttribute('src'), loaded: mark.complete && mark.naturalWidth > 0 } : null,
      brand: box(brand),
      brandLink: box(brand.querySelector('a')),
      horizontalOverflow: main.scrollWidth > main.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
}

function checkGeometry(metrics) {
  assert.equal(metrics.tabs, null, 'the overview is a single page');
  assert.equal(metrics.sections.length, 3, 'chart, account list and daily are visible');
  assert.ok(Math.abs(metrics.chart.x - metrics.page.x) <= 1, 'chart aligns with page');
  assert.ok(Math.abs(metrics.chart.right - metrics.page.right) <= 1, 'chart aligns with page');
  assert.ok(metrics.logo?.loaded, 'existing brand logo is loaded');
  assert.ok(['/logo.svg', '/logo-pixel.svg'].includes(metrics.logo.src));
  assert.ok(metrics.logo.width >= 24 && metrics.logo.width <= 45);
  assert.ok(metrics.brandLink.right <= metrics.brand.right + 1, 'brand stays within sidebar');
  assert.equal(metrics.horizontalOverflow, false);
}

async function verifyJourneys(page, base, scenario, language, label) {
  const zh = language === 'zh-CN';
  const [a, b, pending] = scenario.accounts;
  const word = (chinese, english) => zh ? chinese : english;
  const inclusion = id => page.locator('[data-inclusion-account="' + id + '"] time');
  assert.equal(await inclusion(paperA).getAttribute('datetime'), first);
  assert.equal(await inclusion(paperB).count(), 0);
  assert.equal(await inclusion(pendingPaper).count(), 0);

  const choose = page.getByRole('button', { name: word(/^选择账户/, /^Select accounts/) });
  await choose.press('Enter');
  for (const account of [b, pending]) {
    const checkbox = page.getByRole('checkbox', { name: account.name });
    await checkbox.click();
    await page.waitForURL(url => url.searchParams.get('accounts')?.split(',').includes(account.id));
    await page.getByRole('checkbox', { name: account.name, checked: true }).waitFor();
  }
  await page.keyboard.press('Escape');
  await choose.and(page.locator(':focus')).waitFor();
  assert.match(await choose.textContent(), /4/);
  await page.getByText(word('等待首次完整估值', 'Awaiting a first complete valuation'), { exact: true }).waitFor();
  assert.equal(await inclusion(paperB).count(), 0, 'older simulation already started outside the window');
  assert.equal(await inclusion(pendingPaper).count(), 0, 'partial observations have no marker');
  const history = page.getByText(word('查看历史估值表', 'View historical valuations'), { exact: true });
  await history.press('Enter');
  await page.getByRole('region', { name: word('历史估值数据', 'Historical valuation data') }).getByRole('table').waitFor();
  assert.ok(await page.getByRole('rowheader', { name: b.name }).count() > 0, 'second simulation renders actual chart rows');
  await history.press('Enter');
  async function selectChartData(value) {
    await choose.press('Enter');
    await page.getByRole('combobox', { name: word('图表口径', 'Chart data') }).selectOption(value);
    await page.keyboard.press('Escape');
    await choose.and(page.locator(':focus')).waitFor();
  }
  assert.equal(scenario.seen.some(url => url.pathname === '/api/portfolio-history'), false);
  await selectChartData('reference');
  const sources = page.getByText(word('查看参考市值与历史价格来源', 'View reference values and price sources'), { exact: true });
  await sources.press('Enter');
  const referenceRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '2026-11-13', exact: true }) });
  await referenceRow.getByRole('cell', { name: /9,875\.00/ }).waitFor();
  await referenceRow.locator('summary').press('Enter');
  await referenceRow.getByText('FICT · 2026-11-13 · fictional-close', { exact: true }).waitFor();
  const historyUrl = scenario.seen.find(url => url.pathname === '/api/portfolio-history');
  assert.equal(historyUrl.searchParams.get('period'), '1W');
  assert.deepEqual(historyUrl.searchParams.get('accountIds').split(',').sort(), ['real', paperA, paperB, pendingPaper].sort());
  await sources.press('Enter');
  const intradayResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/ai-investment/comparison' && url.searchParams.get('period') === '1D' && response.ok();
  });
  await page.getByRole('button', { name: word('日内', 'Intraday'), exact: true }).click();
  await intradayResponse;
  await page.getByRole('alert').filter({ hasText: word('历史行情暂时无法读取', 'Historical prices are unavailable') }).waitFor();
  await selectChartData('equity');
  await page.getByRole('heading', { name: word('账户资产金额', 'Account equity'), exact: true }).waitFor();
  await history.press('Enter');
  await page.getByRole('cell', { name: /10,120\.00/ }).waitFor();
  await history.press('Enter');
  await selectChartData('return');
  await page.getByRole('heading', { name: word('账户收益率', 'Account returns'), exact: true }).waitFor();
  await inclusion(paperA).waitFor({ state: 'detached' });
  await page.locator('.portfolio-chart svg').first().waitFor();
  assert.equal(await inclusion(paperA).count(), 0, 'intraday never dates inception at its first visible observation');

  await page.getByRole('link', { name: word('阅读投资日报', 'Read the investment daily'), exact: true }).click();
  await page.waitForURL(base + '/daily');
  await page.getByText('Fictional published daily body').waitFor();
  await page.goBack();
  await page.waitForURL(url => url.pathname === '/' && url.searchParams.get('period') === '1D' && url.searchParams.get('metric') === 'return');

  const realName = word('我的实仓', 'My real portfolio');
  await page.getByRole('link', { name: word('查看持仓 · ', 'View holdings · ') + realName }).click();
  await page.waitForURL(url => url.pathname === '/holdings' && url.searchParams.get('accountId') === 'real');
  const real = page.getByRole('region', { name: word('持仓明细', 'Position details'), exact: true });
  await real.getByRole('rowheader', { name: 'Fictional priced holding · 600000' }).waitFor();
  const unpriced = real.getByRole('row').filter({ hasText: 'Fictional unpriced holding' });
  assert.equal(await unpriced.getByText('—', { exact: true }).count(), 4);
  await unpriced.getByText(word('暂无报价', 'No quote'), { exact: true }).waitFor();
  await real.locator('tbody time[datetime="' + to + '"]').waitFor();
  assert.equal((await geometry(page)).horizontalOverflow, false, 'real holdings fit the viewport');
  const tableScroll = real.getByRole('region', { name: word('持仓明细表，可横向滚动', 'Position details table, scrollable horizontally') });
  if (label.startsWith('390-')) {
    assert.equal(await tableScroll.evaluate(element => {
      element.scrollLeft = element.scrollWidth;
      const reachedEnd = element.scrollLeft > 0 && element.scrollLeft + element.clientWidth >= element.scrollWidth - 1;
      element.scrollLeft = 0;
      return reachedEnd;
    }), true, 'all columns are available inside the narrow table');
  }
  assert.equal(new URL(page.url()).search, '?accountId=real', 'opening the real account must not navigate a second time to write default filters');
  await page.screenshot({ path: path.join(output, label + '-real-holdings.png'), animations: 'disabled' });
  assert.equal(scenario.seen.some(url => url.pathname === '/api/multi-agent/runs' && url.searchParams.get('status') === 'awaiting_human'), false);
  const search = page.getByRole('textbox', { name: word('搜索名称或代码', 'Search name or ticker') });
  await search.pressSequentially('unmatched-ticker');
  await page.waitForURL(url => url.searchParams.get('q') === 'unmatched-ticker');
  await real.getByRole('table').waitFor({ state: 'detached' });
  assert.equal(await real.getByRole('rowheader').count(), 0);
  await search.fill('');
  await real.getByRole('rowheader').first().waitFor();
  assert.equal(new URL(page.url()).search, '?accountId=real');
  await page.getByRole('combobox', { name: word('币种', 'Currency') }).click();
  await page.getByRole('listbox').getByRole('option', { name: 'USD', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('currency') === 'USD');
  await real.getByRole('rowheader', { name: 'Fictional priced holding · 600000' }).waitFor({ state: 'detached' });
  await unpriced.waitFor();
  assert.equal(await real.getByRole('rowheader').count(), 1);
  await page.getByRole('button', { name: word('重置', 'Reset'), exact: true }).click();
  await page.waitForURL(url => url.search === '?accountId=real');
  await real.getByRole('rowheader', { name: 'Fictional priced holding · 600000' }).waitFor();
  assert.equal(await real.getByRole('rowheader').count(), 2);

  for (const [action, dialogName] of [
    [word('录入交易', 'Record a trade'), word('添加交易记录', 'Add transaction')],
    [word('调整现金', 'Adjust cash'), word('核对账户现金', 'Confirm account cash')],
  ]) {
    await page.getByRole('button', { name: action, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: dialogName });
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  }
  assert.equal(await page.getByRole('link', { name: word('查看操作记录', 'View ledger activity') }).getAttribute('href'),
    '/transactions?accountId=real');

  await page.getByRole('link', { name: word('导入持仓', 'Import holdings'), exact: true }).click();
  await page.waitForURL(base + '/import?accountId=real');
  await page.getByRole('button', { name: word('CSV 文件', 'CSV File'), exact: true }).click();
  await page.locator('input[type=file][accept=".csv,text/csv"]').setInputFiles({
    name: 'fictional-holdings.csv', mimeType: 'text/csv',
    buffer: Buffer.from('ticker,shares,cost,company\nFICT,3,12.5,Fictional CSV holding\n'),
  });
  await page.getByRole('button', { name: word('保存持仓', 'Save holdings'), exact: true }).click();
  await page.waitForFunction(() => /Created|新建/.test(document.querySelector('main').textContent));
  assert.equal(scenario.imports.length, 1);
  assert.equal(scenario.imports[0].analyze, false);
  assert.equal(scenario.imports[0].rows[0].ticker, 'FICT');
  await page.goBack();

  const formerTeamsLink = word('已归档团队账户（1）', 'Accounts from archived teams (1)');
  await page.getByRole('link', { name: formerTeamsLink, exact: true }).waitFor({ timeout: 6000 });
  async function selectAccount(name) {
    const accountSwitcher = page.getByRole('navigation', { name: word('切换资产账户', 'Switch asset account') });
    const link = accountSwitcher.getByRole('link', { name, exact: true });
    const selector = page.getByRole('combobox', { name: word('切换资产账户', 'Switch asset account') });
    await link.or(selector).first().waitFor();
    if (await selector.isVisible()) {
      await selector.click();
      assert.equal(await page.getByRole('option', { name: scenario.former.name }).count(), 0);
      await page.getByRole('option', { name, exact: true }).click();
    } else {
      await link.press('Enter');
    }
  }
  await selectAccount(a.name);
  await page.waitForURL(base + '/holdings?accountId=' + paperA);
  await page.getByRole('region', { name: a.name }).getByText('PAPERA').waitFor();
  await page.getByRole('link', { name: word('查看团队运行', 'View team run') }).waitFor();
  await page.screenshot({ path: path.join(output, label + '-paper-holdings.png'), animations: 'disabled' });
  assert.equal(await page.getByRole('link', { name: word('导入持仓', 'Import holdings'), exact: true }).count(), 0);
  assert.equal((await geometry(page)).horizontalOverflow, false, 'paper account contents stay in the mobile viewport');
  await selectAccount(b.name);
  await page.getByRole('region', { name: b.name }).getByText('PAPERB').waitFor();
  assert.equal(await page.getByRole('region', { name: a.name }).count(), 0, 'previous account rows are gone');

  await page.getByRole('link', { name: word('管理模拟账户', 'Manage simulation accounts'), exact: true }).click();
  await page.waitForURL(base + '/holdings/accounts');
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: b.name, exact: true }) });
  assert.equal(await card.getByRole('link', { name: word('管理账户', 'Manage account'), exact: true }).getAttribute('href'), '/holdings/accounts/' + paperB);
  await card.getByRole('link', { name: word('查看持仓', 'View holdings'), exact: true }).click();
  await page.getByRole('region', { name: b.name }).getByText('PAPERB').waitFor();
  await page.goto(base + '/paper?status=paused');
  await page.waitForURL(base + '/holdings/accounts?status=paused');
  await page.getByRole('button', { name: word(/^已暂停/, /^Paused/) }).waitFor();
  assert.equal(await page.getByRole('heading', { name: scenario.former.name, exact: true }).count(), 0);
  await page.goto(base + '/teams');
  await page.getByRole('link', { name: formerTeamsLink, exact: true }).click();
  await page.waitForURL(base + '/holdings/accounts?status=former-team');
  const formerCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: scenario.former.name }) });
  assert.equal(await formerCard.getByRole('link', { name: scenario.former.formerTeam.name }).getAttribute('href'),
    '/teams/fictional-archived-team?panel=overview');
  assert.equal(await page.getByRole('article').count(), 1);
  await formerCard.getByRole('link', { name: word('查看持仓', 'View holdings'), exact: true }).click();
  await page.waitForURL(base + '/holdings?accountId=' + formerPaper);
  await page.getByRole('region', { name: scenario.former.name }).getByText('PAST').waitFor();
  await page.goto(base + '/paper/' + paperB + '?tab=holdings');
  await page.waitForURL(base + '/holdings?accountId=' + paperB);
  await page.getByRole('region', { name: b.name }).waitFor();
  await page.goto(base + '/paper/' + paperA + '?orderId=' + orderId);
  await page.waitForURL(url => url.pathname === '/transactions' && url.searchParams.get('accountId') === paperA);
  await page.locator('#asset-order-' + orderId).waitFor();
  await page.goto(base + '/paper?investmentStrategyId=fictional-draft#investment-strategy');
  await page.waitForURL(base + '/holdings/accounts?investmentStrategyId=fictional-draft#investment-strategy');
  const strategyCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: a.name, exact: true }) });
  const strategyHref = '/paper/' + paperA + '/strategies?investmentStrategyId=fictional-draft';
  for (const name of [a.name, word('选择此账户', 'Choose account')]) {
    const link = strategyCard.getByRole('link', { name, exact: true });
    await link.waitFor({ state: 'visible' });
    assert.equal(await link.getAttribute('href'), strategyHref);
  }
  await page.goto(base + '/import?accountId=' + paperA);
  await page.getByRole('heading', { name: word('模拟盘不支持实仓导入', 'Simulation accounts do not support real-portfolio imports') }).waitFor();
  await page.goto(base + '/');
  const formerOption = page.getByRole('checkbox', { name: new RegExp(scenario.former.name) });
  await page.getByRole('button', { name: word('选择账户（4）', 'Select accounts (4)'), exact: true }).click();
  assert.equal(await formerOption.isChecked(), false);
  assert.equal(await page.getByRole('link', { name: word('查看持仓 · ', 'View holdings · ') + scenario.former.name }).count(), 0);
  await formerOption.click();
  await page.waitForURL(url => url.searchParams.get('accounts')?.split(',').includes(formerPaper));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: word('选择账户（5）', 'Select accounts (5)'), exact: true }).waitFor();

  const releaseAccounts = scenario.delayAccounts();
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: word('选择账户（1）', 'Select accounts (1)'), exact: true }).click();
    assert.equal(await formerOption.isChecked(), false, 'unclassified accounts are not selected implicitly');
    await page.getByRole('checkbox', { name: a.name, exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('accounts') === 'real,' + paperA);
    await page.keyboard.press('Escape');
  } finally {
    releaseAccounts();
  }
  await page.getByRole('button', { name: word('选择账户（2）', 'Select accounts (2)'), exact: true }).waitFor();
  assert.equal(scenario.imports.length, 1);
}

async function verifyRealOnly(page, language, label) {
  const zh = language === 'zh-CN';
  const panel = page.getByRole('region', { name: zh ? '账户表现' : 'Account performance' });
  const rangeButton = panel.getByRole('button', { name: zh ? /^统计区间/ : /^Date range/ });
  const range = page.getByRole('combobox', { name: zh ? '统计区间' : 'Date range' });
  const plot = panel.locator('.portfolio-chart svg').first();
  const cases = [
    ['1W', zh ? '多次有效观测' : 'Multiple valid observations', true],
    ['1D', zh ? '仅一次有效观测' : 'One valid observation', true],
    ['1M', zh ? '暂无有效观测' : 'No valid observations', false],
  ];
  for (const [period, heading, hasPlot] of cases) {
    if (period !== '1W') {
      await rangeButton.click();
      await range.selectOption(period);
      await page.keyboard.press('Escape');
    }
    await panel.getByRole('heading', { name: heading }).waitFor();
    if (hasPlot) await plot.waitFor();
    else {
      await plot.waitFor({ state: 'detached' });
      assert.doesNotMatch(await panel.textContent(), /\$0\.00/);
    }
    assert.equal((await geometry(page)).horizontalOverflow, false, period + ' remains within the viewport');
    await panel.screenshot({ path: path.join(output, label + '-real-' + period + '.png'), animations: 'disabled' });
  }
  await rangeButton.click();
  await range.selectOption('3M');
  await page.keyboard.press('Escape');
  await panel.getByRole('heading', { name: zh ? '持仓参考市值' : 'Holdings lookback', exact: true }).waitFor({ timeout: 5000 });
  await panel.getByText(zh ? /覆盖 1\/2 项持仓/ : /1\/2 holdings covered/).waitFor();
  await plot.waitFor();
  await panel.getByText(zh ? /使用当前持仓数量和历史行情/ : /Uses current holdings and historical prices/).waitFor();
  await panel.screenshot({ path: path.join(output, label + '-real-reference-fallback.png'), animations: 'disabled' });
  await rangeButton.click();
  await range.selectOption('1W');
  await page.keyboard.press('Escape');
  const chartData = page.getByRole('combobox', { name: zh ? '图表口径' : 'Chart data' });
  for (const [value, heading] of [
    ['return', zh ? '账户收益率' : 'Account returns'],
    ['equity', zh ? '账户资产金额' : 'Account equity'],
    ['reference', zh ? '持仓参考市值' : 'Holdings lookback'],
    ['auto', zh ? '多次有效观测' : 'Multiple valid observations'],
  ]) {
    const controls = value === 'return' ? rangeButton : panel.getByRole('button', { name: zh ? /^选择账户/ : /^Select accounts/ });
    await controls.click();
    await chartData.selectOption(value);
    await page.keyboard.press('Escape');
    await panel.getByRole('heading', { name: heading, exact: true }).waitFor();
    await plot.waitFor();
  }
}

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const fixture = await start({ port: 0, dist });
  let browser;
  const results = [];
  try {
    browser = await chromium.launch();
    for (const width of widths) {
      for (const language of ['zh-CN', 'en']) {
        for (const theme of ['light', 'dark']) {
          if (width === 3840 && (language !== 'zh-CN' || theme !== 'dark')) continue;
          const height = width === 390 ? 844 : width === 3840 ? 1958 : 1080;
          const label = [width, language, theme].join('-');
          const context = await browser.newContext({
            viewport: { width, height }, locale: language, timezoneId: 'America/Los_Angeles',
            reducedMotion: 'reduce', serviceWorkers: 'block',
          });
          try {
            await context.addInitScript(({ language, theme }) => {
              localStorage.setItem('sq-lang', language);
              localStorage.setItem('pt-theme', theme);
            }, { language, theme });
            const scenario = await fictionalRoutes(context, fixture.url, language);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            if (holdingsFiltersOnly) {
              await page.goto(fixture.url + '/holdings?accountId=real');
              await page.evaluate(() => document.fonts.ready);
              await verifyHoldingsFilters(page, language, label);
              assert.deepEqual(errors, [], label + ' raised a browser error');
              results.push({ width, height, language, theme });
              continue;
            }
            await page.goto(fixture.url + (realOnly ? '/' : '/?accountIds=' + paperA));
            await page.evaluate(() => document.fonts.ready);
            await page.locator('.portfolio-chart svg').first().waitFor();
            await page.getByText(title, { exact: true }).waitFor();
            const metrics = await geometry(page);
            checkGeometry(metrics);
            await page.screenshot({ path: path.join(output, label + '-overview.png'), animations: 'disabled' });
            if (realOnly) await verifyRealOnly(page, language, label);
            else {
              await page.getByText(language === 'zh-CN' ? '我的账户' : 'My accounts', { exact: true }).scrollIntoViewIfNeeded();
              if ((width === 1440 || width === 390) && theme === 'light') await verifyJourneys(page, fixture.url, scenario, language, label);
            }
            if (width === 390) {
              await page.getByRole('button', { name: language === 'en' ? 'Open navigation' : '打开导航', exact: true }).click();
              const opened = await geometry(page);
              assert.ok(opened.logo.loaded && opened.brandLink.x >= opened.brand.x - 1 && opened.brandLink.right <= opened.brand.right + 1);
            }
            assert.deepEqual(errors, [], label + ' raised a browser error');
            results.push({ width, height, language, theme, metrics });
          } finally {
            await context.close();
          }
        }
      }
    }
    fs.writeFileSync(path.join(output, 'geometry.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ scenarios: results.length, passed: true }));
  } finally {
    try { await browser?.close(); }
    finally { await new Promise(resolve => fixture.server.close(resolve)); }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
