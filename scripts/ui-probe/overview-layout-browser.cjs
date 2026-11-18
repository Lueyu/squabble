'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('./fixture-server.cjs');

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const dist = path.resolve(option('--dist', path.join(__dirname, '../../dist/client')));
const output = path.resolve(option('--output', 'output/playwright/overview-accounts'));
const widths = args.includes('--width') ? [Number(option('--width'))] : [1440, 1920, 2560, 390, 3840];
const [paperA, paperB, pendingPaper] = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
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
  const accounts = [paperA, paperB, pendingPaper].map((id, index) => ({
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
  const seen = [];
  const imports = [];
  const assets = accountId => ({
    accountId,
    positions: [{ id: accountId, ticker: accountId === paperA ? 'PAPERA' : 'PAPERB', shares: '4', avgCost: null,
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
    if (pathname === '/api/ai-investment/accounts') return route.fulfill({ json: accounts });
    if (pathname.startsWith('/api/ai-investment/accounts/') && pathname.endsWith('/assets')) {
      return route.fulfill({ json: assets(pathname.split('/')[4]) });
    }
    if (pathname === '/api/teams') return route.fulfill({ json: {
      items: [{ id: 'fictional-overview-team', name: 'Fictional team', accountId: paperA, binding: { state: 'active' }, status: 'active' }],
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
      const series = [{ id: 'real', name: 'Real portfolio', status: 'real', createdAt: null }, ...accounts].map((account, index) => {
        const points = [real, a, b, waiting][index].filter(item => item.timestamp >= from);
        const latest = points.at(-1);
        return {
          accountId: account.id, name: account.name, kind: index === 0 ? 'real' : 'simulation', status: account.status,
          createdAt: account.createdAt, firstIncludedAt: [null, first, outside, null][index], colorIndex: index - 1,
          valuationAsOf: latest.equityUsd === null ? null : latest.timestamp,
          equityUsd: latest.equityUsd, returnPct: latest.returnPct, returnFrom: points[0].timestamp,
          strategyCount: 0, points, gaps: points.flatMap(item => item.gaps),
        };
      });
      return route.fulfill({ json: { currency: 'USD', period, from, to, granularity: 'observations',
        methodology: 'saved_valuations_no_external_flows', series } });
    }
    if (pathname === '/api/portfolio-history') {
      if (url.searchParams.get('period') === '1D') return route.fulfill({ status: 503, json: {} });
      const date = '2026-11-13';
      const quote = { date, valueUsd: 9875, knownValueUsd: 9875, coveredPositions: 1, totalPositions: 1,
        priceAsOf: [{ ticker: 'FICT', date, source: 'fictional-close' }], fxAsOf: [], gaps: [] };
      return route.fulfill({ json: { refreshing: false, series: [{ accountId: 'real', points: [quote], gaps: [],
        coverage: { completePoints: 1, totalPoints: 1, coveredPositions: 1, totalPositions: 1 } }] } });
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
    if (pathname === '/api/import/commit' && route.request().method() === 'POST') {
      imports.push(route.request().postDataJSON());
      return route.fulfill({ json: { receiptId: 'fictional-import', created: 1, updated: 0, skipped: 0, failed: [] } });
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  return { accounts, seen, imports };
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
  const real = page.getByRole('region', { name: realName });
  await real.getByRole('button').first().waitFor();
  assert.equal(new URL(page.url()).search, '?accountId=real', 'opening the real account must not navigate a second time to write default filters');
  await page.screenshot({ path: path.join(output, label + '-real-holdings.png'), animations: 'disabled' });
  assert.equal(scenario.seen.some(url => url.pathname === '/api/multi-agent/runs' && url.searchParams.get('status') === 'awaiting_human'), false);
  const filters = page.locator('details').filter({ has: page.getByText(word('筛选与管理持仓', 'Filter and manage holdings'), { exact: true }) });
  await filters.locator('summary').press('Enter');
  const search = filters.getByRole('textbox');
  await search.pressSequentially('unmatched-ticker');
  await page.waitForURL(url => url.searchParams.get('q') === 'unmatched-ticker');
  assert.equal(await real.getByRole('button').count(), 0);
  await search.fill('');
  await real.getByRole('button').first().waitFor();
  assert.equal(new URL(page.url()).search, '?accountId=real');
  await filters.locator('summary').press('Enter');

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

  async function selectAccount(name) {
    const accountSwitcher = page.getByRole('navigation', { name: word('切换资产账户', 'Switch asset account') });
    const link = accountSwitcher.getByRole('link', { name, exact: true });
    const selector = page.getByRole('combobox', { name: word('切换资产账户', 'Switch asset account') });
    await link.or(selector).first().waitFor();
    if (await selector.isVisible()) {
      await selector.press('Enter');
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
  assert.equal(scenario.imports.length, 1);
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
            await page.goto(fixture.url + '/?accountIds=' + paperA);
            await page.evaluate(() => document.fonts.ready);
            await page.locator('.portfolio-chart svg').first().waitFor();
            await page.getByText(title, { exact: true }).waitFor();
            const metrics = await geometry(page);
            checkGeometry(metrics);
            await page.screenshot({ path: path.join(output, label + '-overview.png'), animations: 'disabled' });
            await page.getByText(language === 'zh-CN' ? '我的账户' : 'My accounts', { exact: true }).scrollIntoViewIfNeeded();
            if ((width === 1440 || width === 390) && theme === 'light') await verifyJourneys(page, fixture.url, scenario, language, label);
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
