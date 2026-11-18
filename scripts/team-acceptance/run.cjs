const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { chromium } = require('playwright');
const { startSandbox } = require('./sandbox.cjs');
const { api, companionSetup, createTeam, fictionalPassword, importHoldings, inspectNarrow, localAgentId,
  modelSetup, observeLedger, openContext, register, signIn, startTeam, waitForResearch } = require('./browser.cjs');
const { ticker } = require('./providers.cjs');
const { verifyLedger } = require('./ledger.cjs');

async function assertHoldings(sql, owner, accountId) {
  const owned = await sql`select ticker, shares::int from holdings where owner = ${owner}`;
  assert.deepEqual(owned.map(row => ({ ...row })), [{ ticker, shares: 4 }]);
  if (!accountId) return;
  const positions = await sql`select ticker, shares::int from paper_positions where owner = ${owner} and account_id = ${accountId}`;
  assert.deepEqual(positions.map(row => ({ ...row })), [{ ticker, shares: 4 }]);
  const cash = await sql`select currency, available::int from simulation_cash where owner = ${owner} and account_id = ${accountId}`;
  assert.deepEqual(Object.fromEntries(cash.map(row => [row.currency, row.available])), { CNY: 1000, USD: 10000, HKD: 500 });
}

async function researchReceipt(sandbox, ownerApi, owner, team, cycle, automatic) {
  assert.equal(cycle.state, automatic ? 'applied' : 'observed', JSON.stringify(cycle));
  assert.ok(cycle.commissionId && cycle.reportVersionId && cycle.decisionId);
  const [link] = await sandbox.sql`
    select c.session_id, l.attempt_id, l.work_key, r.owner, r.content, d.event, d.basis_json as basis
    from team_commissions c join team_research_links l on l.commission_id = c.id
    join research_document_versions r on r.id::text = l.target_id
    join team_decisions d on d.id = ${cycle.decisionId} and d.commission_id = c.id and d.account_id = c.account_id
    where c.id = ${cycle.commissionId} and c.account_id = ${team.accountId}
      and l.kind = 'report_version' and l.target_id = ${cycle.reportVersionId}`;
  assert.equal(link.owner, owner);
  assert.ok(link.attempt_id && link.work_key);
  assert.equal(link.event, automatic ? 'adopt' : 'observe');
  assert.equal(link.basis.reportVersionId, cycle.reportVersionId);
  assert.equal(link.basis.acceptedAttemptId, link.attempt_id);
  assert.match(link.content, /Acceptance research read the frozen portfolio/u);
  const reportPath = '/api/research-documents/versions/' + cycle.reportVersionId;
  const report = await ownerApi(reportPath);
  assert.equal(report.version.id, cycle.reportVersionId);
  if (automatic) {
    assert.ok(cycle.strategyId && cycle.policyRevision);
    assert.ok(report.version.sections.some(section => section.id === 'execution-strategy'));
    assert.equal(report.version.snapshot.executionPlan.readiness, 'ready');
  }
  const fills = await sandbox.sql`select id from paper_trades where owner = ${owner} and account_id = ${team.accountId}`;
  assert.deepEqual([...fills], [], 'An observation creates no fill');
  return { ...cycle, reportPath, sessionId: link.session_id, acceptedAttemptId: link.attempt_id, workKey: link.work_key };
}

async function pauseTeam(work, ownerApi, team, runPath) {
  await work.page.getByRole('button', { name: /^Pause (team|run)$/u }).click();
  const confirmation = work.page.getByRole('button', { name: 'Confirm pause', exact: true });
  if (await confirmation.isVisible()) await confirmation.click();
  await work.page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  const paused = await ownerApi(runPath);
  assert.equal(paused.agreement.accountId, team.accountId);
  assert.equal(paused.agreement.state, 'paused');
  return paused;
}

async function runJourney(browser, sandbox, output, mode, evidence, suite) {
  const model = mode === 'model';
  const username = 'acceptance-' + mode;
  const automatic = model && suite.automatic;
  sandbox.providers.proposeExecution = automatic;
  const { legacyUi } = suite;
  if (!model) {
    await api(sandbox)('/api/auth/register', {
      method: 'POST', body: { username, password: fictionalPassword, displayName: 'Existing acceptance user' },
    });
  }
  const work = await openContext(browser, sandbox, output, { name: mode, width: model ? 1440 : 390, theme: model ? 'light' : 'dark' });
  const { page, visit, capture } = work;
  const stage = label => {
    evidence.step = label;
    console.log(mode + ' · ' + label);
  };
  try {
    stage(model ? 'register' : 'sign in to existing account');
    const session = await (model ? register : signIn)(work, username);
    const owner = session.user.id;
    const ownerApi = api(sandbox, session);
    assert.equal((await ownerApi('/api/auth/me')).id, owner);
    stage('import holdings');
    evidence.importShot = await importHoldings(work, legacyUi);
    await assertHoldings(sandbox.sql, owner);
    stage('verify execution connection');
    const connection = model ? await modelSetup(work, sandbox.providers, legacyUi) : await companionSetup(work, sandbox, ownerApi, legacyUi);
    const executor = model ? { executionMode: 'model', connectionId: connection.connection.id, model: 'fast' }
      : { executionMode: 'local', localAgentId };
    evidence.connectionShot = connection.screenshot;
    evidence.defaultInputLimit = (await ownerApi('/api/llm-budget')).maxInputTokens;
    const heartbeat = model ? undefined : () => connection.beat();
    stage(legacyUi ? 'create team from saved friends' : 'verify built-in staffing and publish team role edit');
    const team = await createTeam(work, sandbox, ownerApi, executor, 'Acceptance ' + mode, legacyUi, heartbeat);
    evidence.team = team;
    await assertHoldings(sandbox.sql, owner, team.accountId);
    stage('review and start');
    const run = await startTeam(work, ownerApi, team, { legacyUi, loseResponse: model, heartbeat });
    evidence.startup = run;
    stage('settle research');
    const cycle = await waitForResearch(sandbox, ownerApi, run.runPath, model ? undefined : connection);
    evidence.cycle = cycle;
    if (cycle.commissionId) {
      const detail = await ownerApi('/api/teams/' + team.id + '/commissions/' + cycle.commissionId);
      if (team.editedSeat) {
        const member = detail.members.find(item => item.roleId === team.editedSeat.id);
        assert.equal(member?.responsibility, team.editedSeat.responsibility, 'Commission froze the published role edit');
      }
      evidence.commission = { state: detail.state, lastError: detail.lastError, tasks: detail.tasks.map(task => ({
        key: task.key, state: task.state, reason: task.reason, attempts: task.attempts.map(attempt => ({
          id: attempt.id, state: attempt.state, kind: attempt.kind, error: attempt.error, dispatched: attempt.dispatched,
          requestTokens: attempt.memory?.requestTokens, requestBudgetTokens: attempt.memory?.requestBudgetTokens,
        })),
      })) };
    }
    evidence.research = await researchReceipt(sandbox, ownerApi, owner, team, cycle, automatic);
    if (!model) {
      assert.ok(connection.ids.size > 0, 'The paired companion executed the saved team work');
      evidence.companionCommandIds = [...connection.ids];
    }
    await visit('/teams/' + team.id + '?panel=overview');
    await page.getByRole('button', { name: /^Pause (team|run)$/u }).waitFor();
    if (!legacyUi) {
      const { report } = await ownerApi(run.runPath + '/research');
      assert.equal(report?.versionId, cycle.reportVersionId);
      assert.equal(report?.commissionId, cycle.commissionId);
      assert.equal(report?.source, 'automatic');
      if (automatic) assert.equal(report.applied?.revision, cycle.policyRevision);
      else assert.equal(report.applied, null);
      const reportLink = page.getByRole('region', { name: 'Recent research', exact: true })
        .getByRole('link', { name: 'Read full report', exact: true });
      await reportLink.waitFor();
      assert.equal(await reportLink.getAttribute('href'), '/analysis/reports/' + cycle.reportVersionId);
    }
    evidence.researchShot = await capture('research-receipt');
    if (automatic || !model) {
      stage(automatic ? 'execute approved team decision and verify attribution' : 'execute independent rule and verify it is absent from team fills');
      const application = automatic ? evidence.research : undefined;
      const observe = summary => observeLedger(work, team, summary, { requireRunEvidence: !legacyUi, application, ownerApi });
      const refreshSession = async () => {
        const refreshed = await api(sandbox)('/api/auth/refresh', {
          method: 'POST', body: { refreshToken: session.refreshToken },
        });
        assert.equal(refreshed.user.id, owner);
        Object.assign(session, refreshed);
        await page.evaluate(({ accessToken, refreshToken }) => {
          localStorage.setItem('sq-at', accessToken);
          localStorage.setItem('sq-rt', refreshToken);
        }, { accessToken: session.accessToken, refreshToken: session.refreshToken });
      };
      evidence.ledger = {};
      await verifyLedger(sandbox, ownerApi, owner, team, observe, application, evidence.ledger, refreshSession);
      await page.clock.setFixedTime(new Date());
      await visit('/teams/' + team.id + '?panel=overview');
    }
    stage('pause');
    const paused = await pauseTeam(work, ownerApi, team, run.runPath);
    const [account] = await sandbox.sql`select bot_enabled from paper_accounts where id = ${team.accountId}`;
    assert.equal(account.bot_enabled, false, 'Pause stops simulated execution');
    await sandbox.runs.runOnce();
    assert.equal((await ownerApi(run.runPath)).recentCycles.length, paused.recentCycles.length);
    evidence.pauseShot = await capture('paused');
    assert.deepEqual(work.pageErrors, []);
    return { session, team, run, reportPath: evidence.research.reportPath };
  } catch (error) {
    await page.screenshot({ path: join(output, mode + '-failure.png'), animations: 'disabled' }).catch(() => {});
    try {
      writeFileSync(join(output, mode + '-failure.txt'), await page.locator('body').ariaSnapshot({ timeout: 1500 }));
    } catch { /* Preserve the failure from the test step. */ }
    throw error;
  } finally {
    await work.close();
  }
}

async function main() {
  const [mode, extra] = process.argv.slice(2);
  assert.ok(extra === undefined && [undefined, '--baseline', '--legacy-ui'].includes(mode),
    'Usage: npm run test:team-acceptance [-- --baseline|--legacy-ui]');
  const suite = { legacyUi: mode !== undefined, automatic: mode !== '--baseline' };
  const output = resolve('output/playwright/team-acceptance',
    new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-') + '-' + randomUUID().slice(0, 8));
  mkdirSync(output, { recursive: true });
  const evidence = { status: 'running', suite, runs: {}, modelCalls: [] };
  console.log('Evidence directory ' + output);
  let sandbox;
  let browser;
  try {
    sandbox = await startSandbox(process.env.SQU_ACCEPTANCE_DATABASE_URL, output);
    evidence.modelCalls = sandbox.providers.calls;
    await sandbox.sql`insert into fx_rates (base, quote, rate, rate_date) values
      ('CNY', 'USD', '0.14', current_date - 1), ('HKD', 'USD', '0.125', current_date - 1)`;
    browser = await chromium.launch();
    const results = {};
    const failures = [];
    for (const mode of ['model', 'local']) {
      const record = evidence.runs[mode] = {};
      try { results[mode] = await runJourney(browser, sandbox, output, mode, record, suite); }
      catch (error) {
        record.error = error.stack;
        failures.push(error);
        console.error(mode + ' failed at ' + record.step + ' · ' + error.message);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Acceptance journeys failed');
    const { model, local } = results;
    const localApi = api(sandbox, local.session.accessToken);
    const modelApi = api(sandbox, model.session.accessToken);
    await localApi(model.reportPath, { status: 404 });
    await modelApi(local.reportPath, { status: 404 });
    await modelApi('/api/ai-investment/accounts/' + local.team.accountId + '/assets', { status: 404 });
    await localApi('/api/ai-investment/accounts/' + model.team.accountId + '/assets', { status: 404 });
    if (!suite.legacyUi) {
      await localApi(model.run.runPath + '/fills', { status: 404 });
      await modelApi(local.run.runPath + '/research', { status: 404 });
    }
    assert.ok(evidence.modelCalls.some(call => call.rejected));
    assert.ok(evidence.modelCalls.some(call => call.task === 'summary' && !call.rejected));
    if (suite.automatic) assert.ok(evidence.modelCalls.some(call => call.executionPlan === 'price_lte'));
    evidence.historicalOwnership = 'Both report versions remain readable by their owners after pause and return 404 to the other user';
    await modelApi(model.reportPath);
    await localApi(local.reportPath);
    evidence.narrow = await inspectNarrow(browser, sandbox, output, local);
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error.stack;
    throw error;
  } finally {
    try { await browser?.close(); } finally {
      try { await sandbox?.close(); } finally {
        writeFileSync(join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
      }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
