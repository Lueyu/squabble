'use strict';

// Real browser geometry against a local build and fictional HTTP state only.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('./fixture-server.cjs');

const args = process.argv.slice(2);
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const dist = path.resolve(value('--dist', path.join(__dirname, '../../dist/client')));
const output = path.resolve(value('--output', 'output/playwright/overview-polish/geometry'));
const widths = args.includes('--width') ? [Number(value('--width'))] : [1440, 1920, 2560, 390, 3840];
const accountId = 'fictional-overview-account';
const teamId = 'fictional-overview-team';

async function fictionalRoutes(context, origin, language) {
  const teamName = language === 'en'
    ? 'Fictional cash-flow research team with a deliberately long name that wraps naturally inside an account card'
    : '虚构现金流研究团队：用于核对长团队名称自然换行后的卡片和底部操作对齐';
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/teams') {
      return route.fulfill({ json: {
        items: [{ id: teamId, name: teamName, status: 'active', accountId,
          binding: { state: 'active' }, runningCommissionCount: 0 }],
        total: 1, nextCursor: null, capabilities: { workspaceEnabled: true, researchEnabled: true },
      } });
    }
    if (url.pathname === `/api/teams/${teamId}/run-agreement`) {
      return route.fulfill({ json: { agreement: { state: 'running' }, recentCycles: [] } });
    }
    if (url.pathname === '/api/ai-investment/accounts') {
      return route.fulfill({ json: [{ id: accountId, name: 'Fictional simulation', companionId: 'value', status: 'paused' }] });
    }
    if (url.pathname === '/api/ai-investment/comparison' || url.pathname === '/api/portfolio-history') {
      const response = await route.fetch();
      const data = await response.json();
      data.series.push({ ...data.series[0], accountId, name: 'Fictional simulation',
        kind: 'simulation', status: 'paused', colorIndex: 1 });
      return route.fulfill({ json: data });
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => socket.close());
}

async function geometry(page) {
  return page.evaluate(() => {
    const box = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        right: rect.right, bottom: rect.bottom };
    };
    const grid = document.querySelector('.portfolio-account-grid');
    const brand = document.querySelector('.app-brand');
    const mark = brand.querySelector('.squabble-mascot img');
    return {
      tabs: box(document.querySelector('.workspace-section-tabs')),
      page: box(document.querySelector('.portfolio-page')),
      cards: [...grid.children].map(element => ({
        wrapper: box(element), card: box(element.querySelector('.portfolio-account-card')),
        footer: box(element.querySelector('.portfolio-account-card-footer')),
        secondary: [...element.querySelectorAll(':scope > a')]
          .filter(link => !link.classList.contains('portfolio-account-card'))
          .map(link => ({ ...box(link), href: link.getAttribute('href') })),
      })),
      grid: box(grid), next: box(document.querySelector('.portfolio-next-steps')),
      logo: mark ? { ...box(mark), src: mark.getAttribute('src'), loaded: mark.complete && mark.naturalWidth > 0 } : null,
      brand: box(brand), brandLink: box(brand.querySelector('a')),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
}

function violations(metrics, errors) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  check(Math.abs(metrics.tabs.x - metrics.page.x) <= 1, 'tabs and overview left boundaries differ');
  check(Math.abs(metrics.tabs.right - metrics.page.right) <= 1, 'tabs and overview right boundaries differ');
  check(metrics.cards.length === 2, 'fictional real and team-bound simulation cards are missing');
  for (let index = 1; index < metrics.cards.length; index++) {
    const previous = metrics.cards[index - 1];
    const current = metrics.cards[index];
    if (Math.abs(previous.wrapper.y - current.wrapper.y) > 1) continue;
    check(Math.abs(previous.card.bottom - current.card.bottom) <= 1, 'same-row account card bottoms differ');
    check(Math.abs(previous.footer.y - current.footer.y) <= 1, 'same-row account footers differ');
  }
  const secondary = metrics.cards.flatMap(card => card.secondary);
  check(secondary.length === 1 && secondary[0].href === `/teams/${teamId}`, 'actual team link is missing or replaced');
  check(secondary.length === 1 && secondary[0].height >= 24, 'team link hit target is too short');
  check(metrics.next.y - metrics.grid.bottom >= 16, 'following cards touch the account grid');
  check(Boolean(metrics.logo?.loaded), 'existing brand logo is missing');
  if (metrics.logo) {
    check(['/logo.svg', '/logo-pixel.svg'].includes(metrics.logo.src), 'brand does not reuse an existing logo');
    check(metrics.logo.width >= 24 && metrics.logo.width <= 45, 'brand mark is outside the established compact scale');
  }
  check(metrics.brandLink.right <= metrics.brand.right + 1, 'brand overflows its sidebar');
  check(!metrics.horizontalOverflow, 'page has horizontal overflow');
  check(errors.length === 0, 'page raised JavaScript errors');
  return failures;
}

(async () => {
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
          const context = await browser.newContext({ viewport: { width, height },
            locale: language, reducedMotion: 'reduce', serviceWorkers: 'block' });
          try {
            await context.addInitScript(({ language, theme }) => {
              localStorage.setItem('sq-lang', language);
              localStorage.setItem('pt-theme', theme);
            }, { language, theme });
            await fictionalRoutes(context, fixture.url, language);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(fixture.url, { waitUntil: 'networkidle' });
            await page.evaluate(() => document.fonts.ready);
            await page.locator('.portfolio-account-card').first().waitFor();
            const metrics = await geometry(page);
            const failures = violations(metrics, errors);
            const label = `${width}-${language}-${theme}`;
            await page.screenshot({ path: path.join(output, label + '-overview.png'), animations: 'disabled' });
            await page.locator('.portfolio-account-section').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(output, label + '-cards.png'), animations: 'disabled' });
            if (width === 390) {
              await page.getByRole('button', { name: language === 'en' ? 'Open navigation' : '打开导航', exact: true }).click();
              const opened = await geometry(page);
              metrics.mobileBrand = { logo: opened.logo, brand: opened.brand, link: opened.brandLink };
              if (!opened.logo?.loaded || opened.brandLink.x < opened.brand.x - 1 ||
                  opened.brandLink.right > opened.brand.right + 1) {
                failures.push('opened mobile navigation brand is missing or overflows');
              }
              await page.screenshot({ path: path.join(output, label + '-navigation.png'), animations: 'disabled' });
            }
            results.push({ width, height, language, theme, metrics, failures, errors });
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    try { await browser?.close(); }
    finally { await new Promise(resolve => fixture.server.close(resolve)); }
  }
  fs.writeFileSync(path.join(output, 'geometry.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ width, language, theme, failures }) => ({ width, language, theme, failures })), null, 2));
  if (results.some(result => result.failures.length)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
