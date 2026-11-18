const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { apiKey, companionReply, endpoint, ticker } = require('./providers.cjs');

const fictionalPassword = 'Fictional-acceptance-password-22';
const modelName = 'Acceptance model API';
const localAgentId = 'companion-codex';
const importFile = {
  name: 'fictional-holdings.csv', mimeType: 'text/csv',
  buffer: Buffer.from('Ticker,Shares,AvgCost,Company\n' + ticker + ',4,71,Acceptance sample\n'),
};

function api(sandbox, credential) {
  return async (path, { method = 'GET', body, status } = {}) => {
    assert.ok(path.startsWith('/api/') && !path.includes('\\'));
    const token = typeof credential === 'string' ? credential : credential?.accessToken;
    const response = await fetch(sandbox.origin + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Lang': 'en' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (status) assert.equal(response.status, status, method + ' ' + path);
    else assert.ok(response.ok, method + ' ' + path + ' returned ' + response.status + ' ' +
      (data.error?.message ?? data.message ?? data.error?.code ?? data.code ?? ''));
    return data;
  };
}

function responseFor(page, path, method = 'POST') {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === path &&
    response.request().method() === method);
  void pending.catch(() => {});
  return pending;
}

async function accepted(response) {
  const data = await response.json();
  assert.ok(response.ok(), new URL(response.url()).pathname +
    ' returned ' + response.status() + ' ' + (data.error?.message ?? data.message ?? data.error?.code ?? data.code ?? ''));
  return data;
}

async function openContext(browser, sandbox, output, options) {
  const { language = 'en', theme = 'light', width = 1440, name, session } = options;
  const viewport = { width, height: width === 390 ? 844 : 1000 };
  const context = await browser.newContext({ locale: language, colorScheme: theme, viewport,
    serviceWorkers: 'block', reducedMotion: 'reduce', recordVideo: { dir: join(output, 'video') } });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === sandbox.origin
      ? route.continue() : route.abort('blockedbyclient'));
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.addInitScript(({ language, theme, session }) => {
      localStorage.setItem('sq-lang', language);
      localStorage.setItem('pt-theme', theme);
      if (session) {
        localStorage.setItem('sq-at', session.accessToken);
        localStorage.setItem('sq-rt', session.refreshToken);
      }
    }, { language, theme, session });
    const page = await context.newPage();
    page.setDefaultTimeout(14_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const video = page.video();
    const visit = path => page.goto(sandbox.origin + path, { waitUntil: 'domcontentloaded' });
    const capture = async (state) => {
      await page.evaluate(() => document.fonts.ready);
      const path = name + '-' + state + '.png';
      await page.screenshot({ path: join(output, path), animations: 'disabled' });
      const width = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(width <= 1, path + ' overflows the viewport by ' + width + 'px');
      return path;
    };
    const close = async () => {
      await context.close();
      await video.saveAs(join(output, name + '.webm'));
      await video.delete();
    };
    return { page, visit, capture, close, pageErrors };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function register(work, username) {
  const { page, visit } = work;
  await visit('/register');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(fictionalPassword);
  await page.getByLabel('Confirm Password', { exact: true }).fill(fictionalPassword);
  const response = responseFor(page, '/api/auth/register');
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  const session = await accepted(await response);
  await page.getByRole('button', { name: "I've saved my code", exact: true }).click();
  await page.waitForURL('**/');
  return session;
}

async function signIn(work, username) {
  const { page, visit } = work;
  await visit('/login');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(fictionalPassword);
  const response = responseFor(page, '/api/auth/login');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  const session = await accepted(await response);
  await page.waitForURL('**/');
  return session;
}

async function importHoldings(work, legacyUi) {
  const { page, visit, capture } = work;
  if (legacyUi) await visit('/import?accountId=real');
  else await page.getByRole('link', { name: 'Import my holdings', exact: true }).click();
  await page.getByRole('button', { name: 'CSV File', exact: true }).click();
  await page.locator('input[type=file][accept=".csv,text/csv"]').setInputFiles(importFile);
  await page.getByRole('cell', { name: ticker, exact: true }).waitFor();
  const shot = await capture('import-review');
  await page.getByRole('button', { name: 'Save holdings', exact: true }).click();
  if (legacyUi) await page.getByText(/Your holdings are saved/iu).waitFor();
  else await page.getByRole('link', { name: 'Connect a research service', exact: true }).click();
  return shot;
}

async function modelSetup(work, providers, legacyUi) {
  const { page, visit, capture } = work;
  if (legacyUi) await visit('/settings/models');
  else await page.getByRole('link', { name: 'Model API', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Connection name').fill(modelName);
  await dialog.getByLabel('API base URL').fill(endpoint + '/v1');
  await dialog.getByLabel('Fast model ID').fill('acceptance-model');
  await dialog.getByLabel('Deep model ID').fill('acceptance-model');
  await dialog.getByLabel('API key', { exact: true }).fill(apiKey);
  const saved = responseFor(page, '/api/settings/model-connections');
  await dialog.getByRole('button', { name: 'Save connection', exact: true }).click();
  const connection = await accepted(await saved);
  const probePath = '/api/settings/model-connections/' + connection.id + '/test';
  const connectionCard = page.locator('div.min-w-0.rounded-xl').filter({ has: page.getByText(modelName, { exact: true }) });
  const test = connectionCard.getByRole('button', { name: 'Test connection', exact: true });
  providers.rejectModel = true;
  try {
    const rejected = responseFor(page, probePath);
    await test.click();
    assert.equal((await accepted(await rejected)).ok, false);
    await test.waitFor();
    await capture('model-rejected');
  } finally { providers.rejectModel = false; }
  const retried = responseFor(page, probePath);
  await test.click();
  assert.equal((await accepted(await retried)).ok, true);
  if (legacyUi) await page.getByText('The model connection is working.', { exact: true }).waitFor();
  else await page.getByRole('heading', { name: 'Research service connected', exact: true }).waitFor();
  return { connection, screenshot: await capture('model-connected') };
}

async function companionSetup(work, sandbox, ownerApi, legacyUi) {
  const { page, visit, capture } = work;
  const connect = '/api/settings/local-agents/' + localAgentId + '/connect';
  await ownerApi(connect, { method: 'POST', status: 400 });
  if (legacyUi) await visit('/settings#local-agents');
  await page.waitForURL(url => url.pathname === '/settings/agents');
  const pairing = responseFor(page, '/api/settings/local-agents/pairing');
  await page.getByRole('button', { name: 'Pair desktop app', exact: true }).click();
  const { code } = await accepted(await pairing);
  const { token } = await api(sandbox)('/api/local-agent-companion/pair', {
    method: 'POST', body: { code, name: 'Fictional acceptance companion' },
  });
  const send = api(sandbox, token);
  const agents = [{ provider: 'codex', state: 'ready', version: 'fixture-1.0', researchTools: { mode: 'mcp', reason: 'supported' } }];
  const poll = (updates = []) => send('/api/local-agent-companion/poll', {
    method: 'POST', body: { agents, updates },
  });
  await poll();
  const connection = responseFor(page, connect);
  await page.getByRole('article', { name: 'Codex', exact: true }).getByRole('button', { name: 'Connect · Codex', exact: true }).click();
  await accepted(await connection);
  const { items } = await ownerApi('/api/settings/local-agents');
  assert.equal(items.find(item => item.id === localAgentId)?.available, true);
  if (!legacyUi) await page.getByRole('heading', { name: 'Research service connected', exact: true }).waitFor();
  const ids = new Set();
  return { screenshot: await capture('companion-connected'), ids,
    async beat() {
      let updates = [];
      for (let turn = 0; turn < 4; turn++) {
        const { commands } = await poll(updates);
        updates = commands.map(command => {
          assert.equal(command.kind, 'run');
          assert.equal(command.provider, 'codex');
          assert.ok(!ids.has(command.id), 'A command was dispatched twice');
          ids.add(command.id);
          return { id: command.id, state: 'completed', text: companionReply(command.prompt), usageTokens: 42 };
        });
        if (!updates.length) return;
      }
      await poll(updates);
    },
  };
}

async function createTeam(work, sandbox, ownerApi, executor, name, legacyUi) {
  const { TEAM_TEMPLATES } = require('../../dist/shared/team-templates.js');
  const template = TEAM_TEMPLATES[0];
  const templateIds = [...new Set(template.staffing.map(seat => seat.recommendedTemplateId))];
  for (const templateId of templateIds) {
    await ownerApi('/api/agent-roster', {
      method: 'POST', body: { requestKey: randomUUID(), templateId, executor,
        instructions: 'Read the frozen fictional portfolio and cite the assigned evidence.',
        preferences: { language: 'en' }, allowedToolIds: [], allowedSources: [] },
    });
  }
  const { items: friends } = await ownerApi('/api/agent-roster');
  assert.equal(friends.length, templateIds.length, 'The roster exists before team creation');
  const { page, visit, capture } = work;
  if (legacyUi) {
    await visit('/teams');
    await page.getByRole('button', { name: 'New team', exact: true }).click();
  } else {
    await page.getByRole('link', { name: 'Set up a team simulation', exact: true }).click();
    await page.waitForURL('**/teams?guided=1');
  }
  const dialog = legacyUi ? page.getByRole('dialog') : page.locator('main');
  await dialog.getByLabel(legacyUi ? 'Team name *' : 'Team name', { exact: true }).fill(name);
  if (!legacyUi) await dialog.getByLabel('Organization starting point', { exact: true }).selectOption(template.id);
  await dialog.getByLabel('CNY virtual capital', { exact: true }).fill('1000');
  await dialog.getByLabel('HKD virtual capital', { exact: true }).fill('500');
  await dialog.getByRole('button', { name: 'Preview positions and virtual capital', exact: true }).click();
  await dialog.getByText(ticker, { exact: true }).waitFor();
  const seedShot = await capture('seed-review');
  const confirm = dialog.getByRole('button', { name: 'Create team and independent paper account', exact: true });
  assert.equal(await confirm.isDisabled(), true);
  await dialog.getByRole('checkbox').check();
  const created = responseFor(page, '/api/teams');
  await confirm.click();
  const { id } = await accepted(await created);
  await page.waitForURL(url => url.pathname === '/teams/' + id);
  let detail = await ownerApi('/api/teams/' + id);
  if (!detail.publishedVersion.config.roles.some(role => role.agentId)) {
    await page.getByRole('button', { name: 'Apply suggested friends', exact: true }).click();
    await page.getByRole('button', { name: 'Save and review publication', exact: true }).click();
    const publication = page.getByRole('dialog');
    await publication.getByRole('button', { name: 'Check configuration', exact: true }).click();
    await publication.getByRole('checkbox').check();
    await publication.getByRole('button', { name: 'Publish version', exact: true }).click();
    await publication.waitFor({ state: 'hidden' });
    detail = await ownerApi('/api/teams/' + id);
  }
  assert.ok(detail.accountId);
  const roleAgentIds = detail.publishedVersion.config.roles.filter(role => role.participation === 'enabled').map(role => role.agentId);
  assert.ok(roleAgentIds.length >= 2 && roleAgentIds.every(id => friends.some(friend => friend.id === id)));
  assert.equal((await ownerApi('/api/agent-roster')).items.length, friends.length, 'Team creation did not duplicate friends');
  const [account] = await sandbox.sql`select owner, name from paper_accounts where id = ${detail.accountId}`;
  assert.ok(account);
  return { id, accountId: detail.accountId, accountName: account.name, seedShot, roleAgentIds };
}

async function startTeam(work, ownerApi, team, { loseResponse = false, heartbeat, legacyUi } = {}) {
  const { page, capture } = work;
  const runPath = '/api/teams/' + team.id + '/run-agreement';
  const org = page.getByRole('navigation', { name: 'Team workspace panels', exact: true }).getByRole('button', { name: 'Configure team', exact: true });
  await org.click();
  await page.waitForURL('**panel=organization**');
  await page.getByRole('button', { name: 'Save draft', exact: true }).waitFor();
  const configShot = await capture('configuration');
  await page.getByRole('navigation', { name: 'Team workspace panels', exact: true }).getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Set up automatic runs', exact: true }).click();
  await page.getByLabel('Main market').selectOption('US');
  await heartbeat?.();
  await page.getByRole('button', { name: 'Preview run rules', exact: true }).click();
  const start = page.getByRole('button', { name: 'Confirm and start', exact: true });
  await start.waitFor();
  const consent = page.getByRole('checkbox', { name: 'Confirm reviewed run rules', exact: true });
  assert.equal(await consent.isChecked(), false);
  assert.equal(await start.isDisabled(), true);
  assert.equal((await ownerApi(runPath)).agreement, null);
  await consent.scrollIntoViewIfNeeded();
  const consentShot = await capture('consent');
  await consent.press('Space');
  assert.equal(await consent.isChecked(), true);
  await consent.press('Space');
  assert.equal(await start.isDisabled(), true);
  await consent.press('Space');

  await heartbeat?.();
  let retryEvidence;
  if (loseResponse) {
    const startUrl = '**' + runPath + '/start';
    const payloads = [];
    const lost = Promise.withResolvers();
    await page.route(startUrl, async route => {
      try {
        payloads.push(route.request().postDataJSON());
        if (payloads.length !== 1) return await route.continue();
        const receipt = await accepted(await route.fetch());
        await route.abort('failed');
        lost.resolve(receipt);
      } catch (error) { lost.reject(error); }
    });
    await start.press('Enter');
    const first = await lost.promise;
    assert.equal(first.state, 'running');
    const outcome = page.getByRole('alert').filter({ hasText: /Cannot reach the model service|unknown result|outcome unknown|startup is incomplete|check the result/iu });
    await outcome.waitFor();
    const displayedFeedback = await outcome.innerText();
    await capture('startup-unknown');
    if (!legacyUi) await page.reload();
    const retry = legacyUi ? start : page.getByRole('button', { name: 'Check this startup', exact: true });
    await retry.press('Enter');
    await page.getByRole('button', { name: /^Pause (team|run)$/u }).waitFor();
    await retry.waitFor({ state: 'detached' });
    await page.unroute(startUrl);
    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads[1], payloads[0]);
    retryEvidence = { agreementId: first.id, revision: first.revision, requestKey: payloads[0].requestKey, displayedFeedback };
  } else {
    await start.press('Enter');
    await page.getByRole('button', { name: /^Pause (team|run)$/u }).waitFor();
  }
  const status = await ownerApi(runPath);
  assert.equal(status.agreement.state, 'running');
  assert.equal(status.agreement.accountId, team.accountId);
  assert.deepEqual(status.recentCycles, [], 'Startup does not fabricate a report or fill');
  if (retryEvidence) assert.equal(status.agreement.revision, retryEvidence.revision);
  return { runPath, configShot, consentShot, waitingShot: await capture('waiting'), retryEvidence };
}

async function waitForResearch(sandbox, ownerApi, runPath, companion) {
  await sandbox.runs.runOnce();
  const stop = performance.now() + 50_000;
  let status;
  while (performance.now() < stop) {
    await companion?.beat();
    await sandbox.runs.runOnce();
    status = await ownerApi(runPath);
    const cycle = status.recentCycles[0];
    if (cycle && ['observed', 'applied', 'blocked', 'uncertain'].includes(cycle.state)) return cycle;
    await delay(450);
  }
  assert.fail('Timed out waiting for the real team research receipt: ' + JSON.stringify(status?.recentCycles));
}

async function observeLedger(work, team, { state, now, fill }, { requireRunEvidence, application, ownerApi }) {
  const { page, visit, capture } = work;
  await page.clock.setFixedTime(now);
  await visit('/?accountIds=' + team.accountId);
  await page.getByRole('heading', { name: 'Investment overview', exact: true }).waitFor();
  await page.getByText(team.accountName, { exact: true }).first().waitFor();
  const screenshots = [await capture(state === 'gap' ? 'overview-gap' : 'overview')];
  if (state === 'gap') return screenshots;
  await visit('/holdings?accountId=' + team.accountId);
  const selector = page.getByRole('combobox', { name: 'Switch asset account', exact: true });
  await selector.press('Enter');
  await page.getByRole('option', { name: 'Real portfolio', exact: true }).press('Enter');
  await page.waitForURL('**/holdings?accountId=real');
  await selector.press('Enter');
  await page.getByRole('option', { name: new RegExp(team.accountName, 'u') }).press('Enter');
  await page.waitForURL('**/holdings?accountId=' + team.accountId);
  screenshots.push(await capture('account-switch'));


  if (requireRunEvidence) {
    const fillsPath = '/api/teams/' + team.id + '/run-agreement/fills';
    const rows = await ownerApi(fillsPath);
    if (application) {
      assert.deepEqual(rows.map(row => ({
        id: row.id, accountId: row.accountId, orderId: row.orderId, ticker: row.ticker,
        side: row.side, quantity: Number(row.quantity), price: Number(row.price), at: row.createdAt,
      })), [{
        id: fill.id, accountId: team.accountId, orderId: fill.order_id, ticker,
        side: fill.side, quantity: fill.quantity, price: Number(fill.price), at: fill.created_at.toISOString(),
      }]);
    } else {
      assert.deepEqual(rows, [], 'TeamRun fills exclude the independent rule trade');
    }

    const fills = page.getByRole('region', { name: 'Paper fills', exact: true });
    if (application) {
      const outage = '**' + fillsPath;
      await page.route(outage, route => route.abort('failed'));
      try {
        await visit('/teams/' + team.id + '?panel=overview');
        await fills.getByText('Fills are temporarily unavailable', { exact: true }).waitFor();
        await page.getByRole('region', { name: 'Recent research', exact: true })
          .getByRole('link', { name: 'Read full report', exact: true }).waitFor();
        screenshots.push(await capture('fills-read-error'));
      } finally {
        await page.unroute(outage);
      }
      await fills.getByRole('button', { name: 'Retry', exact: true }).click();
      const ledger = fills.getByRole('link', { name: 'View trade ledger', exact: true });
      await ledger.waitFor();
      const target = new URL(await ledger.getAttribute('href'), page.url());
      assert.equal(target.searchParams.get('accountId'), team.accountId);
      assert.equal(target.searchParams.get('tradeId'), fill.id);
      await fills.getByRole('link', { name: new RegExp(ticker, 'u') }).waitFor();
      screenshots.push(await capture('team-fills'));
      await ledger.click();
      await page.locator('#asset-trade-' + fill.id).getByText(new RegExp(ticker, 'u')).waitFor();
    } else {
      await visit('/teams/' + team.id + '?panel=overview');
      await fills.getByText('No paper fills yet', { exact: true }).waitFor();
      assert.equal(await fills.getByText(new RegExp(ticker, 'u')).count(), 0);
      screenshots.push(await capture('unattributed-fill-absent'));
    }
  }
  await visit('/transactions?accountId=' + team.accountId + '&tradeId=' + fill.id);
  await page.locator('#asset-trade-' + fill.id).getByText(new RegExp(ticker, 'u')).waitFor();
  screenshots.push(await capture('ledger'));
  return screenshots;
}

async function inspectNarrow(browser, sandbox, output, result) {
  const { team, session, reportPath } = result;
  const work = await openContext(browser, sandbox, output, {
    name: 'zh-390', language: 'zh-CN', theme: 'dark', width: 390, session,
  });
  const { page, visit, capture } = work;
  const shots = {};
  try {
    await visit('/?accountIds=' + team.accountId);
    await page.getByRole('heading', { name: '投资总览', exact: true }).waitFor();
    assert.equal(await page.locator('html').evaluate(html => html.classList.contains('dark')), true);
    shots.overview = await capture('overview');
    await visit('/holdings?accountId=' + team.accountId);
    await page.getByRole('combobox', { name: '切换资产账户', exact: true }).waitFor();
    shots.holdings = await capture('holdings');
    await visit('/teams/' + team.id + '?panel=overview');
    await page.getByRole('heading', { name: '已暂停', exact: true }).waitFor();
    shots.run = await capture('run');
    await page.getByRole('button', { name: '配置团队', exact: true }).click();
    await page.waitForURL('**panel=organization**');
    await page.getByRole('button', { name: '添加岗位', exact: true }).waitFor();
    shots.config = await capture('configuration');

    const visitEntry = async (path) => {
      const link = page.getByRole('navigation', { name: '快捷导航' }).locator('a[href="' + path + '"]');
      await link.press('Enter');
      await page.waitForURL('**' + path);
      await page.locator('main').waitFor();
    };
    await visit('/settings#local-agents');
    await page.waitForURL(url => url.pathname === '/settings/agents');
    shots.settings = await capture('settings');
    await visitEntry('/research');
    shots.research = await capture('research-entry');
    await visitEntry('/friends');
    shots.friends = await capture('friends-entry');
    const reportId = reportPath.split('/').at(-1);
    await visit('/?reportId=' + reportId + '#history');
    await page.waitForURL('**/analysis/reports/' + reportId + '#history');
    await page.getByText(/Acceptance research read the frozen portfolio/u).first().waitFor();
    shots.report = await capture('historical-report');
    assert.deepEqual(work.pageErrors, []);
    return shots;
  } finally { await work.close(); }
}

module.exports = { api, companionSetup, createTeam, fictionalPassword, importHoldings, inspectNarrow, localAgentId,
  modelSetup, observeLedger, openContext, register, signIn, startTeam, waitForResearch };
