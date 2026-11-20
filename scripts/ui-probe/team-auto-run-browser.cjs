'use strict';

// Real Chromium against built client assets and in-memory fictional routes only.
// No server application imports, database, upstream calls or real provider work.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('./fixture-server.cjs');

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const output = path.resolve(option('--output', 'output/playwright/team-auto-run'));
const dist = path.resolve(option('--dist', 'dist/client'));
const teamId = 'aaaaaa00-0000-4000-8000-000000000001';
const accountId = 'bbbbbb00-0000-4000-8000-000000000001';
const versionId = 'dddddd00-0000-4000-8000-000000000001';
const fixed = '2026-11-17T08:00:00Z';
const copy = value => JSON.parse(JSON.stringify(value));

async function installRoutes(context, origin, base, seedBase) {
  const requests = [];
  const state = { ready: false, created: false, accounts: [], seed: null };
  const readyConfig = copy(base.draft.config);
  const config = copy(readyConfig);
  config.roles = config.roles.map(role => ({ ...role, participation: 'placeholder', agentId: undefined, agentVersionId: undefined, executor: null }));
  const version = { id: versionId, teamId, version: 1, semanticRevision: 1, semanticHash: 'f'.repeat(64), config, displaySnapshot: base.display, createdAt: fixed };
  const detail = { ...base, display: copy(base.display), id: teamId, name: base.display.name, currentVersion: 1, currentVersionId: versionId, publishedVersion: version,
    semanticRevision: 1, layoutRevision: 1, displayRevision: 1, bindingRevision: 0, scopeRevision: 0, hasDraft: false,
    roleCount: config.roles.length, departmentCount: config.departments.length, connectionCount: 0, runningCommissionCount: 0,
    accountId: null, binding: null, draft: { semanticRevision: 1, baseVersionId: versionId, config },
    cost: { confirmed: { amount: '0', currency: 'USD' }, reserved: { amount: '0', currency: 'USD' }, estimatedMaximum: { amount: '0', currency: 'USD' }, externalUsageUnknown: false, unknownAttemptIds: [] } };
  const current = () => {
    if (!state.ready) return detail;
    const binding = { id: 'fixture-binding', teamId, accountId, teamVersionId: versionId, state: 'active', bindingRevision: 1 };
    return { ...detail, binding, accountId, bindingRevision: 1, connectionCount: readyConfig.roles.length,
      publishedVersion: { ...version, config: readyConfig }, draft: { ...detail.draft, config: readyConfig } };
  };
  const preview = result => ({ previewId: 'fixture-preview', previewHash: 'e'.repeat(64), expiresAt: '2099-01-01T00:00:00Z', result, warnings: [], guards: {}, compilerVersion: 'fictional' });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const p = url.pathname, method = request.method(), body = request.postDataJSON();
    requests.push({ method, path: p, body });
    const answer = json => route.fulfill({ json });
    if (p === '/api/teams' && method === 'GET') return answer({ items: [current()], nextCursor: null, capabilities: { workspaceEnabled: true, researchEnabled: true } });
    if (p === '/api/ai-investment/accounts' && method === 'GET') return answer(state.accounts);
    if (p === '/api/ai-investment/preview' && method === 'POST') {
      state.seed = { ...copy(seedBase), previewId: 'fixture-seed', previewHash: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00Z', needsInput: [],
        seed: { ...copy(seedBase.seed), positions: [{ sourceHoldingId: 1, ticker: 'DEMO', shares: '100', market: 'US', currency: 'USD' }],
          cash: body.virtualCash.map(row => ({ currency: row.currency, total: String(row.amount), available: String(row.amount) })) } };
      return answer(state.seed);
    }
    if (p === '/api/teams' && method === 'POST') {
      state.created = true; detail.name = body.name; detail.display.name = body.name; detail.currentVersionId = null; detail.publishedVersion = null;
      return answer(current());
    }
    if (p === `/api/teams/${teamId}` && method === 'GET') return answer(current());
    if (p === `/api/teams/${teamId}/publish-preview`) return answer(preview({}));
    if (p === `/api/teams/${teamId}/publish`) {
      detail.currentVersionId = versionId; detail.publishedVersion = version;
      return answer({ team: current(), version });
    }
    if (p === '/api/ai-investment/accounts' && method === 'POST') {
      assert.equal(body.previewId, 'fixture-seed');
      state.accounts = [{ id: accountId, name: 'Fictional independent paper account', status: 'paused', policyRevision: 1, strategyCount: 0, revision: 1 }];
      return answer({ accountId, revision: 1 });
    }
    if (p.endsWith('/companion') && method === 'PATCH') return answer({ revision: 1 });
    if (p === `/api/teams/${teamId}/binding-preview`) return answer(preview({ inflightCommissions: [], impact: {} }));
    if (p === `/api/teams/${teamId}/binding` && method === 'POST') {
      detail.accountId = accountId; detail.bindingRevision = 1;
      detail.binding = { id: 'fixture-binding', teamId, accountId, teamVersionId: versionId, state: 'active' };
      return answer({ team: current(), binding: detail.binding });
    }
    if (p === `/api/teams/${teamId}/run-agreement/fills` && method === 'GET') return answer([]);
    if (p === `/api/teams/${teamId}/run-agreement/research` && method === 'GET') return answer({ report: null, visibilityLimited: false });
    if (p === `/api/teams/${teamId}/run-agreement` && method === 'GET') return answer({ agreement: null, recentCycles: [] });
    if (p === `/api/teams/${teamId}/run-agreement/preview` && method === 'POST') {
      return answer(preview({ configuration: body, accountId, members: [{ label: 'Snapshot analyst' }, { label: 'Snapshot reviewer' }] }));
    }
    if (method !== 'GET') return route.fulfill({ status: 405, json: { error: { code: 'FICTIONAL_WRITE_NOT_ALLOWED', message: method + ' ' + p } } });
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  return { state, requests };
}

async function metrics(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const rect = dialog?.getBoundingClientRect();
    return { horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      dialog: rect ? { x: rect.x, right: rect.right, height: rect.height, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight, overflowY: getComputedStyle(dialog).overflowY } : null };
  });
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const fixture = await start({ dist, port: 0 });
  const base = await (await fetch(`${fixture.url}/api/teams/${teamId}`)).json();
  const seedBase = await (await fetch(`${fixture.url}/api/ai-investment/preview`, { method: 'POST', body: '{}' })).json();
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: 'en', serviceWorkers: 'block', reducedMotion: 'reduce' });
      try {
        await context.addInitScript(() => { localStorage.setItem('sq-lang', 'en'); localStorage.setItem('pt-theme', 'dark'); });
        const f = await installRoutes(context, fixture.url, base, seedBase);
        const page = await context.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        const captures = [];
        const shot = async suffix => {
          const file = `${width}-${suffix}.png`;
          await page.screenshot({ path: path.join(output, file), animations: 'disabled' });
          const geometry = await metrics(page);
          assert.ok(geometry.horizontalOverflow <= 1, `${width}: horizontal overflow ${geometry.horizontalOverflow}`);
          if (geometry.dialog) {
            assert.ok(geometry.dialog.x >= -1 && geometry.dialog.right <= width + 1, `${width}: dialog overflows viewport`);
            if (geometry.dialog.scrollHeight > geometry.dialog.clientHeight + 1) assert.ok(['auto', 'scroll'].includes(geometry.dialog.overflowY), `${width}: tall dialog cannot scroll`);
          }
          captures.push({ file, geometry });
        };
        await page.goto(`${fixture.url}/teams`, { waitUntil: 'networkidle' });
        if (!await page.getByRole('button', { name: 'New team', exact: true }).count()) {
          await page.screenshot({ path: path.join(output, `${width}-creation-render-error.png`) });
          throw new Error('Creation page did not render: ' + JSON.stringify({ url: page.url(), errors, text: await page.locator('body').innerText() }));
        }
        await page.getByRole('button', { name: 'New team', exact: true }).click();
        await page.getByRole('dialog').waitFor();
        await page.getByRole('button', { name: 'Blank organization', exact: true }).click();
        await page.getByLabel('Team name', { exact: true }).fill('Fictional automatic team');
        await page.getByRole('button', { name: 'Next', exact: true }).click();
        for (const currency of ['CNY', 'USD', 'HKD']) assert.equal(await page.getByLabel(`${currency} virtual capital`, { exact: true }).inputValue(), '10000');
        await page.getByLabel('CNY virtual capital', { exact: true }).fill('12500');
        await page.getByLabel('HKD virtual capital', { exact: true }).scrollIntoViewIfNeeded();
        await shot('create-cash');
        await page.getByRole('button', { name: 'Preview positions and virtual capital', exact: true }).click();
        await page.getByText('DEMO', { exact: true }).waitFor();
        assert.equal(await page.getByRole('cell', { name: '100', exact: true }).count(), 1);
        const seedRequest = f.requests.find(item => item.path === '/api/ai-investment/preview' && item.method === 'POST');
        assert.deepEqual(seedRequest.body.virtualCash, [{ currency: 'CNY', amount: 12500 }, { currency: 'USD', amount: 10000 }, { currency: 'HKD', amount: 10000 }]);
        assert.equal(f.requests.filter(item => item.method === 'POST' && ['/api/teams', '/api/ai-investment/accounts'].includes(item.path)).length, 0);
        assert.equal(await page.getByRole('button', { name: 'Create team and independent paper account', exact: true }).isDisabled(), true);
        await page.getByText('DEMO', { exact: true }).scrollIntoViewIfNeeded();
        await shot('seed-review');
        await page.getByRole('dialog').getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Create team and independent paper account', exact: true }).click();
        await page.waitForURL(`**/teams/${teamId}?panel=overview`);
        await page.getByRole('heading', { name: 'Assign the required seats', exact: true }).waitFor();
        assert.equal(f.requests.filter(item => item.path === '/api/teams' && item.method === 'POST').length, 1);
        assert.equal(f.requests.filter(item => item.path === '/api/ai-investment/accounts' && item.method === 'POST').length, 1);
        await shot('created-readiness');

        assert.deepEqual(errors, []);
        await context.close();
        results.push({ width, phase: 'creation', captures, errors, requests: f.requests });
      } catch (error) {
        await context.close(); throw error;
      }

      const context2 = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: 'en', serviceWorkers: 'block', reducedMotion: 'reduce' });
      try {
        await context2.addInitScript(() => { localStorage.setItem('sq-lang', 'en'); localStorage.setItem('pt-theme', 'dark'); });
        const f = await installRoutes(context2, fixture.url, base, seedBase);
        const page = await context2.newPage(); const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${fixture.url}/teams/${teamId}?panel=overview`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Link paper account', exact: true }).click();
        await page.getByRole('dialog', { name: 'Link a simulation account' }).waitFor();
        await page.getByRole('button', { name: 'Close', exact: true }).first().click();
        await page.getByRole('button', { name: 'Configure members', exact: true }).click();
        await page.waitForURL('**panel=organization**');
        f.state.ready = true;
        f.state.accounts = [{ id: accountId, name: 'Ready fictional paper', policyRevision: 1, strategyCount: 0, status: 'paused' }];
        await page.goto(`${fixture.url}/teams/${teamId}?panel=overview`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Set up automatic runs', exact: true }).click();
        assert.equal(await page.getByRole('checkbox', { name: 'No research amount cap', exact: true }).isChecked(), true);
        assert.equal(await page.getByRole('checkbox', { name: 'Research once at startup', exact: true }).isChecked(), true);
        assert.equal(await page.getByRole('checkbox', { name: 'Confirm reviewed run rules', exact: true }).count(), 0);
        await page.getByRole('button', { name: 'Preview run rules', exact: true }).click();
        await page.getByText('Snapshot analyst · Snapshot reviewer', { exact: false }).waitFor();
        const runPreview = f.requests.find(item => item.path.endsWith('/run-agreement/preview'));
        assert.equal(runPreview.body.initialRun, 'immediate');
        assert.equal(runPreview.body.budget.perRun.ceiling.amount, null);
        assert.equal(runPreview.body.budget.daily.calls, null);
        assert.equal(runPreview.body.budget.monthly.calls, null);
        assert.ok(runPreview.body.budget.perRun.callLimit >= 8);
        assert.equal(await page.getByRole('button', { name: 'Confirm and start', exact: true }).isDisabled(), true);
        await page.getByRole('checkbox', { name: 'Confirm reviewed run rules', exact: true }).check();
        assert.equal(await page.getByRole('button', { name: 'Confirm and start', exact: true }).isEnabled(), true);
        await page.getByRole('checkbox', { name: 'Confirm reviewed run rules', exact: true }).scrollIntoViewIfNeeded();
        const file = `${width}-run-review.png`;
        await page.screenshot({ path: path.join(output, file), animations: 'disabled' });
        const geometry = await metrics(page); assert.ok(geometry.horizontalOverflow <= 1);
        assert.equal(f.requests.filter(item => /run-agreement\/(confirm|start)$/.test(item.path)).length, 0);
        assert.deepEqual(errors, []);
        results.push({ width, phase: 'overview-and-run-review', file, geometry, errors, requests: f.requests });
      } finally { await context2.close(); }
    }
    fs.writeFileSync(path.join(output, 'team-auto-run-browser.json'), JSON.stringify({ fictional: true, capturedAt: new Date().toISOString(), results }, null, 2));
    console.log(JSON.stringify({ passed: true, viewports: [1440, 390], output }, null, 2));
  } finally { await browser.close(); fixture.server.closeAllConnections(); await new Promise(resolve => fixture.server.close(resolve)); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
