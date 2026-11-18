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
  if (legacyUi) {
    await visit('/import?accountId=real');
    await page.getByRole('button', { name: 'CSV File', exact: true }).click();
  } else {
    await page.getByRole('link', { name: 'View holdings · My real portfolio', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/holdings' && url.searchParams.get('accountId') === 'real');
    const activeStep = page.getByRole('list', { name: 'Setup progress', exact: true })
      .locator('[aria-current=step]').filter({ hasText: 'Import holdings' });
    await activeStep.waitFor();
    const importLink = page.getByRole('main').getByRole('link', { name: 'Import holdings', exact: true });
    const target = new URL(await importLink.getAttribute('href'), page.url());
    assert.equal(target.pathname, '/import');
    assert.equal(target.searchParams.get('accountId'), 'real');
    assert.equal(target.searchParams.get('onboarding'), '1');
    await capture('holdings-before-import');
    await importLink.click();
    await page.waitForURL(target.href);
    await page.getByRole('heading', { name: 'Import my holdings', exact: true }).waitFor();
    await activeStep.waitFor();
  }
  await page.locator('input[type=file][accept=".csv,text/csv"]').setInputFiles(importFile);
  await page.getByText(ticker, { exact: true }).waitFor();
  const shot = await capture('import-review');
  await page.getByRole('button', { name: 'Save holdings', exact: true }).click();
  if (legacyUi) await page.getByText(/Your holdings are saved/iu).waitFor();
  else await page.getByRole('link', { name: 'Connect a research service', exact: true }).click();
  return shot;
}

async function modelSetup(work, providers, legacyUi) {
  const { page, visit, capture } = work;
  if (legacyUi) await visit('/settings/models');
  else await page.getByRole('link', { name: 'Model API', exact: true }).filter({ visible: true }).first().click();
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

async function createTeam(work, sandbox, ownerApi, executor, name, legacyUi, heartbeat) {
  const { TEAM_TEMPLATES } = require('../../dist/shared/team-templates.js');
  const template = TEAM_TEMPLATES[0];
  let friends;
  if (legacyUi) {
    const templateIds = [...new Set(template.staffing.map(seat => seat.recommendedTemplateId))];
    for (const templateId of templateIds) {
      await ownerApi('/api/agent-roster', {
        method: 'POST', body: { requestKey: randomUUID(), templateId, executor,
          instructions: 'Read the frozen fictional portfolio and cite the assigned evidence.',
          preferences: { language: 'en' }, allowedToolIds: [], allowedSources: [] },
      });
    }
    friends = (await ownerApi('/api/agent-roster')).items;
    assert.equal(friends.length, templateIds.length, 'The roster exists before team creation');
  }
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
  if (!legacyUi) {
    await dialog.getByRole('button', { name: template.name.en, exact: true }).click();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await dialog.getByLabel('CNY virtual capital', { exact: true }).fill('1000');
  await dialog.getByLabel('HKD virtual capital', { exact: true }).fill('500');
  await dialog.getByRole('button', { name: 'Preview positions and virtual capital', exact: true }).click();
  if (!legacyUi) await dialog.getByText('View positions in the snapshot', { exact: true }).press('Enter');
  await dialog.getByText(ticker, { exact: true }).waitFor();
  const seedShot = await capture('seed-review');
  const confirm = dialog.getByRole('button', { name: 'Create team and independent paper account', exact: true });
  assert.equal(await confirm.isDisabled(), true);
  await dialog.getByRole('checkbox').check();
  const created = responseFor(page, '/api/teams');
  await confirm.click();
  const creation = await accepted(await created);
  const { id } = creation;
  await page.waitForURL(url => url.pathname === '/teams/' + id);
  let detail = await ownerApi('/api/teams/' + id);
  if (!legacyUi) {
    friends = (await ownerApi('/api/agent-roster')).items;
    for (const config of [creation.draft.config, detail.publishedVersion.config]) {
      assert.equal(config.roles.length, template.staffing.length);
      for (const slot of template.staffing) {
        const source = template.config.roles.find(role => role.id === slot.roleId);
        const seats = config.roles.filter(role => role.responsibility === source.responsibility);
        assert.equal(seats.length, 1, source.responsibility);
        const [seat] = seats;
        const prototype = friends.find(friend => friend.id === seat.agentId);
        assert.ok(prototype, 'Missing assigned friend for ' + source.responsibility);
        assert.equal(prototype.currentVersion.config.origin, 'builtin');
        assert.equal(prototype.currentVersion.config.templateId, slot.recommendedTemplateId);
        assert.equal(seat.agentVersionId, prototype.currentVersion.id);
      }
    }
  }
  if (!legacyUi) {
    const unavailable = detail.publishedVersion.config.roles.filter(role => role.participation !== 'enabled' || !role.executor);
    assert.deepEqual(unavailable.map(role => ({
      role: detail.display.roleLabels[role.id], agentId: role.agentId,
      participation: role.participation, executor: role.executor,
    })), [], 'Published fixed-template seats must be runnable before authorization');
    const connectionKey = executor.executionMode === 'local' ? 'localAgentId' : 'connectionId';
    for (const role of detail.publishedVersion.config.roles) {
      assert.equal(role.executor.executionMode, executor.executionMode, 'Published role executor mode');
      assert.equal(role.executor[connectionKey], executor[connectionKey], 'Published role uses the verified connection');
    }
  }
  let editedSeat;
  if (!legacyUi) {
    const seat = detail.publishedVersion.config.roles[0];
    const label = detail.display.roleLabels[seat.id];
    const layout = page.getByRole('group', { name: 'Organization view', exact: true });
    if (new URL(page.url()).searchParams.get('panel') !== 'organization') {
      await visit('/teams/' + id + '?panel=organization');
    }
    await layout.getByRole('button', { name: 'List', exact: true }).click();
    const outline = page.getByRole('region', { name: 'Organization list', exact: true });
    const search = outline.getByRole('textbox', { name: 'Find roles or departments' });
    if (await search.isVisible()) await search.fill(label);
    const friendName = friends.find(friend => friend.id === seat.agentId).name;
    await outline.getByRole('button', { name: label + ' · ' + friendName + ' · ' }).click();
    editedSeat = { id: seat.id, responsibility: seat.responsibility + ' Verify fictional acceptance holdings.' };
    await page.getByRole('textbox', { name: 'Role responsibility', exact: true }).fill(editedSeat.responsibility);
    await heartbeat?.();
    await page.getByRole('button', { name: 'Review and publish version', exact: true }).click();
  }
  if (legacyUi && !detail.publishedVersion.config.roles.some(role => role.agentId)) {
    await page.getByRole('button', { name: 'Apply suggested friends', exact: true }).click();
    await page.getByRole('button', { name: 'Save and review publication', exact: true }).click();
  }
  if (editedSeat || (legacyUi && !detail.publishedVersion.config.roles.some(role => role.agentId))) {
    const publication = page.getByRole('dialog');
    await publication.getByRole('button', { name: 'Check configuration', exact: true }).click();
    await publication.getByRole('checkbox').check();
    await publication.getByRole('button', { name: 'Publish version', exact: true }).click();
    await publication.waitFor({ state: 'hidden' });
    detail = await ownerApi('/api/teams/' + id);
  }
  if (editedSeat) {
    assert.equal(detail.publishedVersion.config.roles.find(role => role.id === editedSeat.id)?.responsibility, editedSeat.responsibility);
    const after = (await ownerApi('/api/agent-roster')).items;
    for (const friend of friends) {
      assert.deepEqual(after.find(item => item.id === friend.id)?.currentVersion, friend.currentVersion,
        'Team publication changed roster prototype ' + friend.id);
    }
  }
  assert.ok(detail.accountId);
  const roleAgentIds = detail.publishedVersion.config.roles.filter(role => role.participation === 'enabled').map(role => role.agentId);
  assert.ok(roleAgentIds.length >= 2 && roleAgentIds.every(id => friends.some(friend => friend.id === id)));
  assert.equal((await ownerApi('/api/agent-roster')).items.length, friends.length, 'Team creation did not duplicate friends');
  const [account] = await sandbox.sql`select owner, name from paper_accounts where id = ${detail.accountId}`;
  assert.ok(account);
  return { id, accountId: detail.accountId, accountName: account.name, seedShot, roleAgentIds, editedSeat };
}

async function startTeam(work, ownerApi, team, { loseResponse = false, heartbeat, legacyUi } = {}) {
  const { page, capture } = work;
  const runPath = '/api/teams/' + team.id + '/run-agreement';
  const org = page.getByRole('button', { name: 'Configure team', exact: true })
    .or(page.getByRole('link', { name: 'Configure team', exact: true })).first();
  if (new URL(page.url()).searchParams.get('panel') !== 'organization') {
    await org.click();
    await page.waitForURL('**panel=organization**');
  }
  await page.getByRole('button', { name: /^Save (role )?draft$/u }).waitFor();
  const configShot = await capture('configuration');
  const back = page.getByRole('link', { name: 'Back to run overview', exact: true });
  if (await back.isVisible()) await back.click();
  else await page.getByRole('navigation', { name: 'Team workspace panels', exact: true })
    .getByRole('button', { name: 'Overview', exact: true }).click();
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
    const outcome = legacyUi
      ? page.getByRole('alert').filter({ hasText: /Cannot reach the model service|unknown result|outcome unknown|startup is incomplete|check the result/iu })
      : page.getByRole('alert').filter({ hasText: /^Startup outcome is unknown\. Use “Check this startup” to verify the original request\.$/u });
    const displayedFeedback = await outcome.innerText();
    if (!legacyUi) {
      assert.equal(await page.getByRole('button', { name: 'Check this startup', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Edit run options', exact: true }).count(), 0);
    }
    assert.equal(payloads.length, 1);
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
  if (!legacyUi) {
    await page.getByText('Waiting for first research', { exact: true }).waitFor();
    await page.getByText('No paper fills yet', { exact: true }).waitFor();
    await page.getByText('No published research yet', { exact: true }).waitFor();
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

async function observeLedger(work, team, { state, now, fill, trade }, { requireRunEvidence, application, ownerApi }) {
  const { page, visit, capture } = work;
  await page.clock.setFixedTime(now);
  await visit('/?accountIds=' + team.accountId);
  await page.getByRole('heading', { name: 'Investment overview', exact: true }).waitFor();
  await page.getByText(team.accountName, { exact: true }).first().waitFor();
  if (requireRunEvidence && state === 'filled') {
    const chart = page.getByRole('region', { name: 'Account performance', exact: true });
    const accountButton = (count) => chart.getByRole('button', { name: 'Select accounts (' + count + ')', exact: true });
    await accountButton(2).press('Enter');
    const choice = page.getByRole('checkbox', { name: team.accountName, exact: true });
    assert.equal(await choice.isChecked(), true);
    await choice.press('Space');
    await accountButton(1).waitFor();
    await choice.press('Space');
    await accountButton(2).waitFor();
    await choice.press('Escape');
    const period = chart.getByRole('group', { name: 'Comparison period', exact: true });
    for (const label of ['Intraday', 'Past week']) {
      const button = period.getByRole('button', { name: label, exact: true });
      await button.press('Enter');
      await button.and(page.locator('button[aria-pressed=true]')).waitFor();
    }
  }
  const screenshots = [await capture(state === 'gap' ? 'overview-gap' : 'overview')];
  if (state === 'gap') return { screenshots };
  await visit('/holdings?accountId=' + team.accountId);
  if (requireRunEvidence) {
    const selector = page.getByRole('navigation', { name: 'Switch asset account', exact: true });
    const real = selector.getByRole('link', { name: 'My real portfolio', exact: true });
    await real.press('Enter');
    await page.waitForURL(url => url.pathname === '/holdings' && url.searchParams.get('accountId') === 'real');
    await page.getByRole('heading', { name: 'My real portfolio', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Position details', exact: true }).getByRole('rowheader', { name: 'Acceptance sample · ' + ticker, exact: true }).waitFor();
    const accountPicker = page.getByRole('combobox', { name: 'Switch asset account', exact: true });
    assert.equal(await accountPicker.innerText(), 'My real portfolio');
    await accountPicker.press('Enter');
    await page.getByRole('option', { name: team.accountName, exact: true }).press('Enter');
    const paper = selector.getByRole('link', { name: team.accountName, exact: true });
    await page.waitForURL(url => url.pathname === '/holdings' && url.searchParams.get('accountId') === team.accountId);
    await paper.and(page.locator('a[aria-current=page]')).waitFor();
  } else {
    const selector = page.getByRole('combobox', { name: 'Switch asset account', exact: true });
    await selector.press('Enter');
    await page.getByRole('option', { name: 'Real portfolio', exact: true }).press('Enter');
    await page.waitForURL(url => url.pathname === '/holdings' && url.searchParams.get('accountId') === 'real');
    await selector.press('Enter');
    await page.getByRole('option', { name: new RegExp(team.accountName, 'u') }).press('Enter');
    await page.waitForURL(url => url.pathname === '/holdings' && url.searchParams.get('accountId') === team.accountId);
  }
  screenshots.push(await capture('account-switch'));

  let teamRunFills;
  const filledAt = fill.filled_at.toISOString();
  if (requireRunEvidence) {
    assert.equal(trade.filledAt, filledAt, 'Account assets expose the matched order fill time');
    const fillsPath = '/api/teams/' + team.id + '/run-agreement/fills';
    teamRunFills = await ownerApi(fillsPath);
    if (application) {
      assert.deepEqual(teamRunFills.map(row => ({
        id: row.id, accountId: row.accountId, orderId: row.orderId, ticker: row.ticker,
        side: row.side, quantity: Number(row.quantity), price: Number(row.price), filledAt: row.filledAt, createdAt: row.createdAt,
      })), [{
        id: fill.id, accountId: team.accountId, orderId: fill.order_id, ticker,
        side: fill.side, quantity: fill.quantity, price: Number(fill.price), filledAt, createdAt: fill.created_at.toISOString(),
      }]);
    } else {
      assert.deepEqual(teamRunFills, [], 'TeamRun fills exclude the independent rule trade');
    }

    const fills = page.getByRole('region', { name: 'Paper fills', exact: true });
    if (application) {
      const outage = '**' + fillsPath;
      await page.route(outage, route => route.abort('failed'));
      try {
        await visit('/teams/' + team.id + '?panel=overview');
        await fills.getByRole('alert').filter({ hasText: 'Fills are temporarily unavailable' }).waitFor();
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
      const row = fills.getByRole('link', { name: new RegExp(ticker, 'u') });
      await row.getByText('Buy ' + fill.quantity, { exact: true }).waitFor();
      await row.getByText('Fill price ' + fill.price + ' USD', { exact: true }).waitFor();
      const teamTime = await page.evaluate(at => new Intl.DateTimeFormat('en', {
        timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23', timeZoneName: 'short',
      }).format(new Date(at)), filledAt);
      const teamTimestamp = row.locator('time[datetime="' + filledAt + '"]');
      await teamTimestamp.waitFor();
      assert.equal(await teamTimestamp.textContent(), teamTime);
      screenshots.push(await capture('team-fills'));
      await ledger.click();
      await page.waitForURL(target.href);
    } else {
      await visit('/teams/' + team.id + '?panel=overview');
      await fills.getByText('No paper fills yet', { exact: true }).waitFor();
      assert.equal(await fills.getByText(new RegExp(ticker, 'u')).count(), 0);
      screenshots.push(await capture('unattributed-fill-absent'));
    }
  }
  if (!requireRunEvidence || !application) {
    await visit('/transactions?accountId=' + team.accountId + '&tradeId=' + fill.id);
  }
  const ledgerRow = page.locator('[data-account-id="' + team.accountId + '"] #asset-trade-' + fill.id);
  await ledgerRow.getByText(new RegExp(ticker, 'u')).waitFor();
  if (requireRunEvidence) {
    const ledgerTime = await page.evaluate(at => new Date(at).toLocaleString('en'), filledAt);
    const ledgerTimestamp = ledgerRow.locator('time[datetime="' + filledAt + '"]');
    await ledgerTimestamp.waitFor();
    assert.equal(await ledgerTimestamp.textContent(), ledgerTime);
  }
  screenshots.push(await capture('ledger'));
  return { screenshots, teamRunFills };
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
    await page.getByRole('navigation', { name: '切换资产账户', exact: true })
      .or(page.getByRole('combobox', { name: '切换资产账户', exact: true })).waitFor();
    shots.holdings = await capture('holdings');
    await visit('/teams/' + team.id + '?panel=overview');
    await page.getByRole('heading', { name: /^(已暂停|自动研究和模拟交易已暂停)$/u }).waitFor();
    shots.run = await capture('run');
    await page.getByRole('button', { name: '配置团队', exact: true }).click();
    await page.waitForURL('**panel=organization**');
    await page.getByRole('heading', { name: '团队组织', exact: true })
      .or(page.getByRole('button', { name: /^(添加|新增)岗位$/u })).first().waitFor();
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
