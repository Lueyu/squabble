'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('./fixture-server.cjs');

const real = '/holdings?accountId=real&fixture=return&sort=marketValue&direction=desc&markets=US%2CHK%2CCN#positions';
const paperId = '00000000-0000-4000-8000-000000000001';
const dist = path.resolve(process.argv[2] ?? path.join(__dirname, '../../dist/client'));

async function check(browser, origin, { holdings, ready = false, existingState }) {
  const context = await browser.newContext({ locale: 'en-US' });
  try {
    await context.addInitScript(() => localStorage.setItem('sq-lang', 'en'));
    const runReads = new Set();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort('blockedbyclient');
      switch (url.pathname) {
        case '/api/portfolio/holdings':
          return holdings ? route.continue() : route.fulfill({ json: { items: [], total: 0 } });
        case '/api/ai-investment/accounts':
          return route.fulfill({ json: [{ id: paperId, name: 'Probe simulation', status: 'paused' }] });
        case '/api/teams': {
          const later = url.searchParams.has('cursor');
          const items = existingState ? [{ id: later ? 'existing' : 'draft', status: 'active' }] : [];
          return route.fulfill({ json: { items, nextCursor: existingState && !later ? 'next' : null } });
        }
        case '/api/teams/draft/run-agreement':
        case '/api/teams/existing/run-agreement': {
          const id = url.pathname.split('/')[3];
          runReads.add(id);
          return route.fulfill({ json: {
            agreement: id === 'existing' ? { state: existingState } : null,
            recentCycles: [],
          } });
        }
        case '/api/research-execution/readiness':
          return route.fulfill({ json: { items: [] } });
        case '/api/settings/model-connections':
          return route.fulfill({ json: { items: ready ? [{
            id: 'probe', name: 'Probe AI', available: true, testState: 'passed', testedAt: '2026-11-18T00:00:00Z',
          }] : [] } });
        default:
          return route.continue();
      }
    });

    const setup = page.getByRole('region', { name: 'From your holdings to team runs' });
    const activeStep = setup.locator('[aria-current=step]');
    await page.goto(origin + real);
    const importLink = page.locator('main a[href^="/import?"]');
    const accountSelector = page.getByRole('combobox', { name: 'Switch asset account' });
    await accountSelector.click();
    await page.getByRole('option', { name: 'Probe simulation', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await importLink.first().waitFor();

    if (existingState === 'running') {
      await page.waitForLoadState('networkidle');
      assert.deepEqual([...runReads].sort(), ['draft', 'existing']);
      assert.equal(await setup.count(), 0);
      return;
    }

    await activeStep.waitFor();
    assert.equal(await importLink.count(), 1);
    if (!holdings) {
      assert.match(await activeStep.innerText(), /Import holdings/);
      await importLink.click();
      await page.waitForURL('**/import?accountId=real&onboarding=1');
      assert.equal(await page.evaluate(() => history.state.usr.returnTo), real);
      return;
    }
    if (existingState === 'paused') {
      const resume = setup.getByRole('link', { name: 'Review and resume team' });
      assert.equal(await resume.getAttribute('href'), '/teams/existing?panel=overview&onboarding=1');
      return;
    }
    if (ready) {
      assert.match(await activeStep.innerText(), /Start a team/);
      const create = setup.getByRole('link', { name: 'Set up a team simulation' });
      assert.equal(await create.getAttribute('href'), '/teams?guided=1');
      return;
    }

    assert.match(await activeStep.innerText(), /Connect AI/);
    await setup.getByRole('link', { name: 'Connect a research service' }).click();
    await page.waitForURL('**/settings/agents?onboarding=1');
    assert.equal(await page.evaluate(() => history.state.usr.returnTo), real);
    await page.goBack();
    await page.waitForURL(origin + real);
    await page.getByRole('heading', { name: 'My real portfolio', exact: true }).waitFor();
    await setup.waitFor().catch(async error => {
      throw new Error('Setup is unavailable after returning to the real ledger: ' + await page.locator('main').innerText(), { cause: error });
    });

    for (const target of [
      '/holdings?accountId=' + paperId, '/transactions?accountId=real', '/transactions?accountId=' + paperId, '/',
    ]) {
      await page.goto(origin + target);
      await page.waitForLoadState('networkidle');
      assert.equal(await setup.count(), 0, target);
    }
  } finally {
    await context.close();
  }
}

async function main() {
  const fixture = await start({ dist, port: 0 });
  try {
    const browser = await chromium.launch();
    try {
      for (const scenario of [
        { holdings: false },
        { holdings: true },
        { holdings: true, ready: true },
        { holdings: true, existingState: 'paused' },
        { holdings: true, existingState: 'running' },
      ]) await check(browser, fixture.url, scenario);
      console.log('Holdings setup browser probe passed (empty, connect AI, team setup, paused, ongoing).');
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise(resolve => fixture.server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
