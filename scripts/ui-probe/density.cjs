'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('./fixture-server.cjs');

// Render the real compiled client against fictional HTTP data. No personal
// service, model, database or browser zoom setting is changed by this check.
async function run(options = {}) {
  const output = path.resolve('output/playwright/ui-density');
  fs.mkdirSync(output, { recursive: true });
  const fixture = await start({ port: 0, dist: options.dist });
  let browser;
  const results = [];
  const cases = [
    [1366, 768, 'zh-CN'], [1366, 768, 'en'],
    [1440, 780, 'zh-CN'], [1440, 780, 'en'],
    [1440, 900, 'zh-CN'], [1920, 1080, 'en'],
    [1024, 768, 'en'], [390, 844, 'zh-CN'], [390, 844, 'en'],
  ];
  try {
    browser = await chromium.launch();
    for (const [width, height, language] of cases) {
      const context = await browser.newContext({
        viewport: { width, height }, locale: language, reducedMotion: 'reduce',
      });
      await context.addInitScript(lang => localStorage.setItem('sq-lang', lang), language);
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== fixture.url) return route.abort();
        if (url.pathname === '/api/teams') return route.fulfill({ json: {
          items: [{ id: 'density-team', name: 'Fictional ready team', status: 'active', accountId: null }],
          total: 1, capabilities: { workspaceEnabled: true, researchEnabled: true },
        } });
        if (url.pathname === '/api/teams/density-team/run-agreement') {
          return route.fulfill({ json: { agreement: { state: 'running' }, recentCycles: [] } });
        }
        return route.continue();
      });
      try {
        for (const route of ['/', '/research']) {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          page.on('response', response => {
            if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) {
              errors.push('HTTP ' + response.status() + ' ' + new URL(response.url()).pathname);
            }
          });
          await page.goto(fixture.url + route, { waitUntil: 'networkidle' });
          await page.evaluate(() => document.fonts.ready);
          const metrics = await page.evaluate(() => {
            const box = selector => {
              const element = document.querySelector(selector);
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              return { y: rect.y, bottom: rect.bottom, height: rect.height,
                overflow: element.scrollHeight - element.clientHeight };
            };
            return { main: box('.app-content'), chart: box('.portfolio-chart'),
              messages: box('.research-room-messages'), composer: box('.research-composer'),
              horizontal: document.documentElement.scrollWidth - innerWidth };
          });
          assert.deepEqual(errors, [], 'Client and fixture requests must complete');
          assert.ok(metrics.main, 'Actual workspace must render');
          assert.ok(metrics.horizontal <= 2, 'No document horizontal overflow');
          if (route === '/' && width >= 1366) {
            assert.ok(metrics.chart && metrics.chart.height >= 220, 'Keep the chart readable');
            assert.ok(metrics.chart.bottom <= metrics.main.bottom + 2,
              `Overview chart fits first viewport (${width}x${height} ${language}): ${JSON.stringify({ chart: metrics.chart, main: metrics.main })}`);
          }
          if (route === '/research') {
            assert.ok(metrics.messages && metrics.composer, 'Conversation and composer must render');
            assert.ok(metrics.main.overflow <= 2, 'Research has no second outer scroll');
            assert.ok(metrics.composer.bottom <= metrics.main.bottom + 2, 'Composer stays visible');
            if (width >= 1024) assert.ok(metrics.messages.overflow <= 2, 'Empty conversation needs no scroll');
            await page.locator('.research-room-messages').evaluate(element => {
              const history = document.createElement('div');
              history.textContent = 'Fictional history for overflow testing. '.repeat(1000);
              element.appendChild(history);
            });
            const stress = await page.evaluate(() => {
              const main = document.querySelector('.app-content');
              const messages = document.querySelector('.research-room-messages');
              const composer = document.querySelector('.research-composer');
              return { main: main.scrollHeight - main.clientHeight,
                messages: messages.scrollHeight - messages.clientHeight,
                bottom: composer.getBoundingClientRect().bottom, limit: main.getBoundingClientRect().bottom };
            });
            assert.ok(stress.messages > 0 && stress.main <= 2, 'Long history scrolls only inside messages');
            assert.ok(stress.bottom <= stress.limit + 2, 'Long history cannot push composer out');
          }
          results.push({ route, width, height, language, metrics });
          await page.screenshot({ path: path.join(output,
            `${route === '/' ? 'overview' : 'research'}-${width}-${height}-${language}.png`), animations: 'disabled' });
          await page.close();
        }
      } finally { await context.close(); }
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ scenarios: results.length, passed: true }));
  } finally {
    try { await browser?.close(); }
    finally { await new Promise(resolve => fixture.server.close(resolve)); }
  }
}

module.exports = { run };
if (require.main === module) {
  const args = process.argv.slice(2);
  run({ dist: args.includes('--dist') ? args[args.indexOf('--dist') + 1] : undefined })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
