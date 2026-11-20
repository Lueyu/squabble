'use strict';

const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('./fixture-server.cjs');

const ROOT = path.resolve(__dirname, '../..');
const EVIDENCE = path.join(ROOT, 'dist/ui-probe/settings-navigation');

async function assertDesktopRail(page, rail) {
  const [primary, secondary, content] = await Promise.all([
    page.locator('.app-sidebar').boundingBox(),
    rail.boundingBox(),
    page.locator('.settings-content').boundingBox(),
  ]);
  assert.ok(primary && secondary && content, 'Both navigation levels and the settings form are visible');
  assert.ok(Math.abs(primary.x + primary.width - secondary.x) <= 2, 'Settings navigation touches the right edge of primary navigation');
  assert.ok(secondary.x + secondary.width <= content.x + 1, 'The form occupies the next column');
  assert.equal(await rail.evaluate(el => Boolean(el.closest('.app-sidebar, .settings-content'))), false);
  return { x: secondary.x, width: secondary.width };
}

async function exercise(page, url, mobile) {
  const pathName = pathname => url + pathname;
  const scope = page.locator(mobile ? '.settings-navigation-page' : '.settings-navigation-rail');
  const agent = scope.getByRole('link', { name: mobile ? '本地 Agent' : 'Local Agent', exact: true });
  const model = scope.getByRole('link', { name: mobile ? '模型 API' : 'Model API', exact: true });
  const picker = scope.getByRole('button', { name: /设置类别/ });
  async function openCategories() {
    if (mobile && await picker.getAttribute('aria-expanded') !== 'true') await picker.tap();
  }
  const record = { connects: 0, saves: 0, probes: 0 };
  const connections = [];
  const local = { id: 'fixture-codex', provider: 'codex', name: 'Codex CLI', available: false, busy: false,
    connected: false, source: 'companion', state: 'ready' };

  await page.route('**/api/experience/preferences', route => route.fulfill({ json: { enabled: true, defaultMembers: [] } }));
  await page.route(/\/api\/settings\/local-agents\/(status|fixture-codex\/connect)$/, async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { mode: 'companion', items: [local], companion: { name: 'Fixture host', connected: true } } });
    } else {
      assert.equal(route.request().method(), 'POST');
      record.connects++;
      local.connected = true;
      local.available = true;
      await route.fulfill({ json: { ok: true } });
    }
  });

  await page.route(/\/api\/settings\/model-connections(?:\/[^?]+)?$/, async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ json: { items: connections } });
    } else if (request.url().endsWith('/test')) {
      assert.equal(request.method(), 'POST');
      record.probes++;
      assert.equal(request.postDataJSON().language, mobile ? 'zh-CN' : 'en');
      await route.fulfill({ json: { ok: true, message: 'Fixture test receipt' } });
    } else {
      assert.equal(request.method(), 'POST');
      record.saves++;
      const { name, baseUrl, fastModel, slowModel, apiKey } = request.postDataJSON();
      assert.deepEqual({ name, baseUrl, fastModel, slowModel, apiKey }, {
        name: 'Fixture connection', baseUrl: 'https://service.invalid/v1',
        fastModel: 'fixture-fast', slowModel: 'fixture-deep', apiKey: 'fixture-only',
      });
      const saved = { id: 'fixture-connection', name, baseUrl, fastModel, slowModel,
        hasApiKey: true, available: true, maskedApiKey: '••••fixture' };
      connections.push(saved);
      await route.fulfill({ json: saved });
    }
  });

  await page.goto(pathName('/settings?from=probe#local-agents'), { waitUntil: 'domcontentloaded' });
  await page.waitForURL('**/settings/agents?from=probe#local-agents');
  assert.equal(await page.locator('.app-user-block .sr-only').textContent(), mobile ? '本地工作区' : 'Local workspace');
  assert.equal(await page.locator('.app-logout').count(), 0);
  await openCategories();
  assert.equal(await agent.getAttribute('aria-current'), 'page');
  assert.equal(await page.locator(mobile ? '.settings-navigation-rail' : '.settings-navigation-page').isVisible(), false);
  assert.equal(await page.locator('.settings-navigation a[href="/settings/security"]').count(), 0);
  const initialRail = mobile ? null : await assertDesktopRail(page, scope);
  if (mobile) {
    await picker.focus();
    await page.keyboard.press('Escape');
    assert.equal(await picker.getAttribute('aria-expanded'), 'false');
  }
  const host = page.locator('#local-agents');
  await host.getByRole('heading', { name: 'Codex CLI' }).waitFor();
  await page.screenshot({ animations: 'disabled', path: path.join(EVIDENCE, mobile ? 'local-mobile.png' : 'local-desktop.png') });
  const connect = host.getByRole('button', { name: /^(连接|Connect).*Codex CLI/ });
  if (mobile) await connect.tap();
  else await connect.click();
  await host.getByRole('button', { name: /^(断开|Disconnect).*Codex CLI/ }).waitFor();
  assert.equal(record.connects, 1);
  await page.screenshot({ animations: 'disabled', path: path.join(EVIDENCE, mobile ? 'connected-mobile.png' : 'connected-desktop.png') });

  await openCategories();
  if (mobile) await model.tap();
  else {
    await model.focus();
    await page.keyboard.press('Enter');
  }
  await page.waitForURL('**/settings/models?from=probe');
  await scope.locator('a[href^="/settings/models"][aria-current="page"]').waitFor({ state: 'attached' });
  if (mobile) assert.equal(await picker.getAttribute('aria-expanded'), 'false');
  else assert.deepEqual(await assertDesktopRail(page, scope), initialRail);
  await page.locator('#settings-page-title:focus').waitFor();
  const modelPanel = page.locator('#model-connections');
  await modelPanel.getByRole('button', { name: /添加连接|Add connection/ }).click();
  const editor = page.getByRole('dialog');
  await editor.locator('#connection-name').fill('Fixture connection');
  await editor.locator('#connection-baseUrl').fill('https://service.invalid/v1');
  await editor.locator('#connection-fastModel').fill('fixture-fast');
  await editor.locator('#connection-slowModel').fill('fixture-deep');
  await editor.locator('#connection-apiKey').fill('fixture-only');
  await page.screenshot({ animations: 'disabled', path: path.join(EVIDENCE, mobile ? 'model-form-mobile.png' : 'model-form-desktop.png') });
  await editor.getByRole('button', { name: /^(保存连接|Save connection)$/ }).click();
  await modelPanel.getByText('Fixture connection', { exact: true }).waitFor();
  assert.equal(record.saves, 1);
  assert.equal(record.probes, 0);
  await modelPanel.getByRole('button', { name: /^(测试连接|Test connection)$/ }).click();
  await modelPanel.getByText('Fixture test receipt', { exact: true }).waitFor();
  assert.equal(record.probes, 1);

  await openCategories();
  const budget = scope.getByRole('link', { name: /用量与预算|Usage & budget/ });
  await budget.click();
  await page.waitForURL('**/settings/budget');
  await scope.locator('a[href="/settings/budget"][aria-current="page"]').waitFor({ state: 'attached' });
  if (mobile) assert.match(await picker.innerText(), /用量与预算/);
  else assert.deepEqual(await assertDesktopRail(page, scope), initialRail);
  await page.getByRole('button', { name: /返回上一页|Go back/, exact: true }).click();
  await page.waitForURL('**/settings/models?from=probe');
  await page.goBack();
  await page.waitForURL('**/settings/agents?from=probe#local-agents');
  await scope.locator('a[href^="/settings/agents"][aria-current="page"]').waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

  await page.goto(pathName('/settings/security?from=bookmark#saved'), { waitUntil: 'domcontentloaded' });
  await page.waitForURL('**/settings/models?from=bookmark#saved');
  await scope.locator('a[href^="/settings/models"][aria-current="page"]').waitFor({ state: 'attached' });
  if (mobile) assert.equal(await picker.getAttribute('aria-expanded'), 'false');
  else assert.deepEqual(await assertDesktopRail(page, scope), initialRail);
  assert.equal(await page.locator('#current-password').count(), 0);
  await page.goBack();
  await page.waitForURL('**/settings/agents?from=probe#local-agents');

  await page.route('**/api/auth/mode', route => route.fulfill({ json: { mode: 'account' } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 'fixture-user', username: 'fixture', displayName: 'Fixture user' } }));
  await page.evaluate(() => localStorage.setItem('sq-at', 'fixture-session'));
  await page.goto(pathName('/settings/agents'));
  await openCategories();
  await scope.locator('a[href="/settings/security"]').click();
  await page.waitForURL('**/settings/security');
  await page.locator('#current-password').waitFor();
  await page.reload();
  await page.locator('#current-password').waitFor();
  assert.equal(await scope.locator('a[href="/settings/security"]').getAttribute('aria-current'), 'page');
  await page.locator('.app-user-block[title="Fixture user"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('.app-logout').count(), 1);
}

async function main() {
  const { server, url } = await start({ port: 0, dist: path.join(ROOT, 'dist/client') });
  let browser;
  try {
    await mkdir(EVIDENCE, { recursive: true });
    browser = await chromium.launch();
    for (const mobile of [false, true]) {
      const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        hasTouch: mobile, colorScheme: mobile ? 'dark' : 'light' });
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(12000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(mobile => {
        localStorage.setItem('pt-theme', mobile ? 'dark' : 'light');
        localStorage.setItem('sq-lang', mobile ? 'zh-CN' : 'en');
      }, mobile);
      try {
        await exercise(page, url, mobile);
        assert.deepEqual(errors, []);
        console.log(`Settings navigation and forms passed at ${mobile ? '390' : '1280'}px`);
      } catch (error) {
        await page.screenshot({ animations: 'disabled', path: path.join(EVIDENCE, mobile ? 'failure-mobile.png' : 'failure-desktop.png') });
        throw error;
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
