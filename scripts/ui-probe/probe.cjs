'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { inspectDOM } = require('./dom-probe.cjs');
const { ROOT, matrixInfo, sourceTokenFingerprint, detectorFingerprint } = require('./fingerprints.cjs');

const FIXED_TIME = '2026-11-13T01:00:00.000Z';
const pretty = value => JSON.stringify(value, null, 2) + '\n';

async function assertPageReady(page, scenario) {
  const crash = page.getByRole('heading', { name: /^(Something went wrong|页面出了点问题)$/ });
  if (await crash.count()) throw new Error('Application crash boundary rendered: ' + await crash.first().textContent());
  await page.locator(scenario.readySelector).first().waitFor({ state: 'visible' });
  if (scenario.expectedCount && await page.locator(scenario.readySelector).count() !== scenario.expectedCount) {
    throw new Error('Fictional content count does not match the frozen scenario.');
  }
}

async function applyAction(page, scenario) {
  if (scenario.action === 'agent-editor') {
    await page.getByRole('button', { name: /^(Add agent|添加股友)$/ }).click();
    await page.getByRole('dialog').waitFor();
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog && Number(getComputedStyle(dialog).opacity) === 1;
    });
  }
  if (scenario.action === 'memory-expanded') {
    await page.locator('article').first().getByRole('button', { name: /^(Memory|记忆)$/ }).click();
    await page.locator('article').first().getByText('Fictional note: preserve source boundaries and review assumptions.').waitFor();
  }
  if (scenario.action === 'external-status') {
    await page.locator('article').first().locator('summary').click();
    await page.getByText(/Structured delivery unverified/).waitFor();
  }
  if (/^guided-step[23]$/.test(scenario.action || '')) {
    await page.getByRole('button', { name: /^(Next: choose agents|下一步：确认股友)$/ }).click();
    await page.getByRole('heading', { name: /^(Choose from your agents|从我的股友中选择成员)$/ }).waitFor();
    if (scenario.action === 'guided-step3') {
      await page.getByRole('button', { name: /^(Next: review startup|下一步：核对启动规则)$/ }).click();
      await page.getByRole('heading', { name: /^(Review once, then start|最后核对一次，然后启动)$/ }).waitFor();
    }
  }
}

async function installFictionalState(context, scenario, origin) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort('blockedbyclient');
    if (request.method() === 'GET' && /^\/api\/agent-roster\/[^/]+\/memories$/.test(url.pathname)) return route.fulfill({
      json: { items: [{ id: '55555555-5555-4555-8555-555555555555', content: 'Fictional note: preserve source boundaries and review assumptions.', origin: 'user_note', scope: { kind: 'personal' }, sourceRefs: [], createdAt: FIXED_TIME }] },
    });
    if (request.method() === 'GET' && scenario.fixture === 'external' && url.pathname === '/api/a2a-agents') return route.fulfill({
      json: { items: [{ id: '66666666-6666-4666-8666-666666666666', name: 'Fictional external friend', status: 'ready', revision: 1, capabilities: { structuredOutputVerified: false } }] },
    });
    if (request.method() === 'GET' && scenario.fixture && url.pathname === '/api/agent-roster') {
      const response = await route.fetch();
      const data = await response.json();
      if (scenario.fixture === 'longtext') data.items = data.items.map((item, index) => ({
        ...item, name: 'Fictional International Research Friend ' + (index + 1),
        specialty: 'ÄÖÜ ß æøå 中文混排 ٠١٢٣ — Verify every material assumption',
        description: index % 2 ? 'Short fictional description.' : 'A longer fictional description checks multilingual wrapping, evidence boundaries, independent conclusions and uncertain information. LongUnbrokenReferenceXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      }));
      if (scenario.fixture === 'external') data.items[0].currentVersion.config.executor = { executionMode: 'a2a', connectionId: '66666666-6666-4666-8666-666666666666' };
      return route.fulfill({ response, json: data });
    }
    return route.continue();
  });
}

async function run(options = {}) {
  const origin = new URL(options.baseUrl || 'http://127.0.0.1:4173').origin;
  const health = await (await fetch(origin + '/__fixture__/health')).json();
  if (!health.fixture || !health.fictional) throw new Error('UI probe requires the fictional fixture server; real application backends are not scanned.');
  const info = matrixInfo();
  const tokens = sourceTokenFingerprint();
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, '.ui/tokens.lock.json'), 'utf8'));
  if (tokens.hash !== lock.hash) throw new Error('Frozen design-token source fingerprint changed. Do not regenerate the lock to bypass this check.');
  const capture = options.capture || 'before';
  if (!['before', 'after'].includes(capture)) throw new Error('--capture must be before or after. Approved baseline creation is intentionally unsupported.');
  const output = path.resolve(options.output || path.join(ROOT, 'output/playwright/ui-audit'));
  if (path.basename(output).toLowerCase() === 'baseline.json') throw new Error('An approved baseline cannot be created by this script.');
  fs.mkdirSync(path.join(output, 'shots'), { recursive: true });
  const selected = info.scenarios.filter(item => (!options.route || item.route === options.route)
    && (!options.viewport || item.viewport.width === Number(options.viewport)) && (!options.state || item.name === options.state));
  if (!selected.length) throw new Error('The requested filter is not in the frozen matrix.');
  const snapshot = {
    schemaVersion: 1, capture, approvedBaseline: false, status: 'running',
    matrixHash: info.hash, tokenHash: tokens.hash, probeHash: detectorFingerprint(),
    environment: { playwright: require('playwright/package.json').version, platform: process.platform,
      osRelease: os.release(), arch: process.arch, node: process.version, ...info.matrix.browser },
    expectedScenarios: info.scenarios.map(item => item.id), scenarios: [], findings: [],
  };
  const save = () => {
    fs.writeFileSync(path.join(output, capture + '.json'), pretty(snapshot));
    fs.writeFileSync(path.join(output, 'findings.json'), pretty(snapshot.findings));
  };
  const browser = await chromium.launch({ headless: true });
  snapshot.environment.chromium = browser.version();
  try {
    for (const scenario of selected) {
      const context = await browser.newContext({ viewport: scenario.viewport, locale: scenario.language,
        ...Object.fromEntries(Object.entries(info.matrix.browser).filter(([key]) => key !== 'name')) });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', error => errors.push('JS: ' + error.message));
      page.on('response', response => {
        if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) errors.push('HTTP ' + response.status() + ' ' + new URL(response.url()).pathname);
      });
      const result = { id: scenario.id, route: scenario.route, state: scenario.name, viewport: scenario.viewport.width, status: 'running' };
      try {
        await installFictionalState(context, scenario, origin);
        await context.addInitScript(({ language, fixedTime }) => {
          localStorage.setItem('sq-lang', language);
          localStorage.setItem('sq-theme', 'light');
          const NativeDate = Date;
          const time = new NativeDate(fixedTime).valueOf();
          window.Date = class extends NativeDate {
            constructor(...args) { super(...(args.length ? args : [time])); }
            static now() { return time; }
          };
        }, { language: scenario.language, fixedTime: FIXED_TIME });
        const response = await page.goto(origin + scenario.route, { waitUntil: 'networkidle' });
        if (!response || !response.ok()) throw new Error('Page response missing or unsuccessful.');
        await assertPageReady(page, scenario);
        await applyAction(page, scenario);
        await page.evaluate(() => document.fonts.ready);
        if (!snapshot.environment.userAgent) Object.assign(snapshot.environment, await page.evaluate(() => ({
          userAgent: navigator.userAgent,
          bodyFontFamily: getComputedStyle(document.body).fontFamily,
          fonts: ['Arial', 'Inter', 'Microsoft YaHei', 'sans-serif'].map(font => ({
            font, available: document.fonts.check('16px "' + font + '"'),
          })),
        })));
        await page.screenshot({ path: path.join(output, 'shots', capture + '-' + scenario.id.replace(/[^A-Za-z0-9_-]/g, '_') + '.png'), fullPage: true, animations: 'disabled' });
        await assertPageReady(page, scenario);
        if (errors.length) throw new Error([...new Set(errors)].join('; '));
        const shot = 'shots/' + capture + '-' + scenario.id.replace(/[^A-Za-z0-9_-]/g, '_') + '.png';
        const findings = await page.evaluate(inspectDOM, { sourceHint: scenario.sourceHint, alignmentRules: scenario.alignmentRules || [] });
        snapshot.findings.push(...findings.filter(item => !options.only || item.code === options.only).map(item => ({
          ...item, route: scenario.route, state: scenario.name, viewport: scenario.viewport.width, shot,
        })));
        result.status = 'complete';
        result.shot = shot;
        result.findings = findings.length;
      } catch (error) {
        result.status = 'failed';
        result.error = error.message;
      } finally {
        snapshot.scenarios.push(result);
        await context.close();
        save();
      }
      console.log('[' + snapshot.scenarios.length + '/' + selected.length + '] ' + result.id + ' ' + result.status + (result.error ? ': ' + result.error : ''));
    }
  } finally {
    await browser.close();
  }
  snapshot.status = selected.length === info.scenarios.length && !options.only && snapshot.scenarios.every(item => item.status === 'complete') ? 'complete' : 'incomplete';
  save();
  console.log(pretty({ status: snapshot.status, snapshot: path.join(output, capture + '.json'), scenarios: snapshot.scenarios.length, findings: snapshot.findings.length, approvedBaseline: false }).trim());
  return snapshot;
}

module.exports = { run, applyAction, assertPageReady };
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  run({ baseUrl: get('--base-url'), output: get('--output'), capture: get('--capture'), route: get('--route'), viewport: get('--viewport'), state: get('--state'), only: get('--only') })
    .then(snapshot => { process.exitCode = snapshot.status === 'complete' && !snapshot.findings.some(item => item.sev === 'P0') ? 0 : 1; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
