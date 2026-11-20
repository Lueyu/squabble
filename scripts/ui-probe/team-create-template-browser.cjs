'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { start } = require('./fixture-server.cjs');

const evidence = path.resolve(__dirname, '../../dist/ui-probe/team-create-template');
const teamId = 'aaaaaa00-0000-4000-8000-000000000001';
const versionId = 'aaaaaa00-0000-4000-8000-000000000002';

function isRectilinear(path) {
  let x, y;
  return path.split(/(?=[MLQ])/).every(command => {
    const [nextX, nextY, endX, endY] = command.slice(1).trim().split(/[\s,]+/).map(Number);
    if (command.startsWith('Q')) return x === nextX && x === endX && y === nextY && y === endY;
    const axisAligned = command.startsWith('M') || nextX === x || nextY === y;
    x = nextX;
    y = nextY;
    return axisAligned && Number.isFinite(x) && Number.isFinite(y);
  });
}

async function verifyOrganization(preview, { roles, departments, reports, reviews }) {
  await preview.locator('.react-flow__node-teamRole [data-persona] svg').nth(roles - 1).waitFor();
  assert.equal(await preview.locator('.react-flow__node-teamRole [data-persona] svg').count(), roles);
  assert.equal(await preview.locator('.react-flow__node-teamDepartment').count(), departments);
  const paths = preview.locator('.react-flow__edge-path');
  await paths.nth(reports + reviews - 1).waitFor();
  const edges = await paths.evaluateAll(elements => elements.map(edge => ({
    path: edge.getAttribute('d'),
    dash: getComputedStyle(edge).strokeDasharray,
    arrow: edge.getAttribute('marker-end'),
  })));
  assert.equal(edges.filter(edge => edge.dash === 'none').length, reports);
  assert.equal(edges.filter(edge => edge.dash !== 'none').length, reviews);
  assert.deepEqual(edges.filter(edge => !isRectilinear(edge.path) || !edge.arrow), [], 'line segments and target arrows');
  assert.equal(await preview.getByRole('button').count(), 3, 'preview only offers viewport controls');
}

async function exercise(browser, origin, guided) {
  const context = await browser.newContext({
    viewport: guided ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    locale: guided ? 'zh-CN' : 'en-US',
    isMobile: guided,
    hasTouch: guided,
  });
  try {
    await context.addInitScript(lang => localStorage.setItem('sq-lang', lang), guided ? 'zh-CN' : 'en');
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const seedRequests = [];
    const unexpectedWrites = [];
    const source = !guided && await (await context.request.get(`${origin}/api/teams/${teamId}`)).json();
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (request.method() === 'GET') {
        if (guided && url.pathname === '/api/teams') {
          return route.fulfill({
            json: { items: [], nextCursor: null, capabilities: { workspaceEnabled: true } },
          });
        }
        if (!guided && url.pathname === '/api/teams') {
          const response = await route.fetch();
          const body = await response.json();
          const zero = { amount: '0', currency: 'USD' };
          return route.fulfill({ response, json: { ...body, items: [{
            ...source, name: 'Published fixture team', currentVersionId: versionId, currentVersion: 1,
            roleCount: 4, departmentCount: 2,
            cost: { confirmed: zero, reserved: zero, estimatedMaximum: zero, externalUsageUnknown: false, unknownAttemptIds: [] },
          }] } });
        }
        if (!guided && url.pathname === `/api/teams/${teamId}/versions/${versionId}`) {
          const labels = { ...source.display.roleLabels, [source.draft.config.defaults.leadRoleId]: 'Published fixture lead' };
          return route.fulfill({ json: { id: versionId, teamId, config: source.draft.config,
            displaySnapshot: { ...source.display, roleLabels: labels } } });
        }
        if (guided && url.pathname === '/api/settings/model-connections') {
          return route.fulfill({ json: { items: [{
            id: 'fixture', name: 'Fixture model', available: true, testState: 'passed',
            testedAt: '2026-11-18T00:00:00Z',
          }] } });
        }
        return route.continue();
      }
      if (request.method() === 'POST' && url.pathname === '/api/ai-investment/preview') {
        const body = request.postDataJSON();
        seedRequests.push(body);
        return route.fulfill({ json: {
          previewId: '44444444-4444-4444-8444-444444444444',
          expiresAt: '2099-01-01T00:00:00Z',
          needsInput: [],
          seed: {
            capturedAt: '2026-11-18T00:00:00Z',
            positions: [{ sourceHoldingId: 'fixture', market: 'CN', ticker: '600000', currency: 'CNY', shares: 10 }],
            cash: body.virtualCash.map(({ currency, amount }) => ({ currency, total: String(amount) })),
          },
        } });
      }
      unexpectedWrites.push([request.method(), url.pathname]);
      return route.abort();
    });

    await page.goto(origin + (guided ? '/teams?guided=1' : '/teams'));
    if (!guided) await page.getByRole('button', { name: 'New team', exact: true }).click();
    const scope = guided ? page.locator('main') : page.getByRole('dialog');
    const choices = scope.getByRole('group', { name: guided ? '固定团队模板' : 'Fixed team templates' });
    const staffing = scope.getByRole('region', { name: guided ? '自动配员预览' : 'Automatic staffing preview' });
    const organization = scope.getByRole('region', { name: guided ? '组织结构预览' : 'Organization preview' });
    await choices.waitFor();
    assert.equal(await choices.getByRole('button').count(), 11);
    assert.match(await staffing.innerText(), guided ? /自动指派 4 个岗位/ : /4 seats assigned/);
    assert.equal(await organization.count(), 0);
    await choices.getByRole('button', {
      name: guided ? '细粒度财报尽调组' : 'Fine-grained diligence', exact: true,
    }).click();
    const accounting = staffing.getByRole('listitem').filter({
      hasText: guided ? '财报股友' : 'Financials friend',
    });
    assert.match(await accounting.innerText(), guided ? /口径核对员/ : /Accounting analyst/);
    const cashflow = staffing.getByRole('listitem').filter({ hasText: guided ? '基本面股友' : 'Business fundamentals friend' });
    assert.match(await cashflow.innerText(), guided ? /现金流专家/ : /Cash-flow analyst/);
    const committee = choices.getByRole('button', { name: guided ? '多空辩论投委会' : 'Bull–bear committee' });
    await committee.click();
    assert.equal(await committee.getAttribute('aria-pressed'), 'true');
    assert.match(await staffing.innerText(), guided ? /自动指派 6 个岗位/ : /6 seats assigned/);
    const cards = staffing.getByRole('listitem');
    assert.equal(await cards.count(), 12);
    assert.equal(await staffing.locator('[data-persona] svg').count(), 12);
    assert.deepEqual(await cards.evaluateAll(items => items.map(item => item.dataset.assigned)),
      [...Array(6).fill('true'), ...Array(6).fill('false')]);
    assert.match(await cards.first().innerText(), guided ? /组合经理股友.*投委会主席.*内置原型/s
      : /Portfolio manager friend.*Chair.*Built-in prototype/s);
    assert.match(await cards.last().innerText(), guided ? /本模板未指派/ : /Not assigned in this template/);
    const picker = choices.locator('..');
    const grid = staffing.locator('ul');
    const [left, right] = await Promise.all([picker.boundingBox(), staffing.boundingBox()]);
    assert.ok(left && right);
    assert.ok(guided ? left.y + left.height <= right.y : left.x + left.width <= right.x);
    assert.ok(await grid.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    assert.ok(await scope.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    assert.equal(seedRequests.length, 0);
    await page.screenshot({
      path: path.join(evidence, guided ? 'guided-mobile.png' : 'regular-desktop.png'),
      animations: 'disabled',
    });

    if (!guided) {
      await scope.getByRole('button', { name: 'Copy a configuration', exact: true }).click();
      await scope.getByLabel('Source team and published version').waitFor();
      await staffing.waitFor({ state: 'hidden' });
      await organization.waitFor({ state: 'hidden' });
    }
    await scope.getByRole('button', { name: guided ? '空白组织' : 'Blank organization', exact: true }).click();
    await staffing.waitFor({ state: 'hidden' });
    await organization.waitFor({ state: 'hidden' });
    await scope.getByRole('button', { name: guided ? '选择组织模板' : 'Organization templates', exact: true }).click();
    await staffing.waitFor();
    assert.equal(await committee.getAttribute('aria-pressed'), 'true');

    await scope.getByLabel(guided ? '团队名称' : 'Team name', { exact: true }).fill('Template probe');
    await scope.getByRole('button', { name: guided ? '下一步' : 'Next', exact: true }).click();
    const amount = scope.getByRole('spinbutton', { name: guided ? 'CNY 虚拟本金' : 'CNY virtual capital' });
    assert.equal(await amount.inputValue(), '10000');
    await amount.fill('1250');
    await scope.getByRole('button', { name: guided ? '预览持仓与虚拟本金' : 'Preview positions and virtual capital' }).click();
    const confirm = scope.getByRole('button', {
      name: guided ? '确认创建团队与独立模拟盘' : 'Create team and independent paper account',
    });
    await confirm.waitFor();
    await verifyOrganization(organization, { roles: 6, departments: 3, reports: 5, reviews: 6 });
    assert.match(await organization.innerText(), guided ? /投委会主席\s*组合经理股友/ : /Chair\s*Portfolio manager friend/);
    await scope.getByRole('region', { name: guided ? '核对模拟起点' : 'Review the new paper account seed' }).waitFor();
    const viewportSelector = '.team-create-organization-preview .react-flow__viewport';
    const initialFit = await page.waitForFunction(selector => {
      const transform = document.querySelector(selector)?.style.transform;
      return transform && new DOMMatrixReadOnly(transform).a < 1 ? transform : false;
    }, viewportSelector);
    const beforeZoom = await initialFit.jsonValue();
    const zoomIn = organization.getByRole('button', { name: guided ? '放大' : 'Zoom in' });
    if (guided) await zoomIn.tap();
    else await zoomIn.press('Enter');
    await page.waitForFunction(({ selector, before }) => {
      const transform = document.querySelector(selector)?.style.transform;
      return transform && new DOMMatrixReadOnly(transform).a > new DOMMatrixReadOnly(before).a;
    }, { selector: viewportSelector, before: beforeZoom });
    const fit = organization.getByRole('button', { name: guided ? '适应画布' : 'Fit canvas' });
    await fit.click();
    await page.waitForFunction(({ selector, before }) => document.querySelector(selector)?.style.transform === before,
      { selector: viewportSelector, before: beforeZoom });
    assert.ok(await scope.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await organization.screenshot({
      path: path.join(evidence, guided ? 'organization-mobile.png' : 'organization-desktop.png'),
      animations: 'disabled',
    });
    assert.equal(seedRequests.length, 1);
    assert.equal(seedRequests[0].origin, 'holdings');
    assert.deepEqual(seedRequests[0].virtualCash, [
      { currency: 'CNY', amount: 1250 }, { currency: 'USD', amount: 10000 }, { currency: 'HKD', amount: 10000 },
    ]);
    assert.equal(await confirm.isDisabled(), true);
    await scope.getByRole('checkbox').check();
    assert.equal(await confirm.isEnabled(), true);
    if (!guided) {
      const editTeam = async () => {
        await scope.getByRole('button', { name: 'Edit starting point' }).click();
        await scope.getByRole('button', { name: 'Edit team' }).click();
      };
      const review = async () => {
        await scope.getByRole('button', { name: 'Next', exact: true }).click();
        await scope.getByRole('button', { name: 'Preview positions and virtual capital' }).click();
        await confirm.waitFor();
      };
      await editTeam();
      await scope.getByRole('button', { name: 'Copy a configuration' }).click();
      await scope.getByLabel('Source team and published version').click();
      await page.getByRole('option', { name: 'Published fixture team · v1' }).click();
      await review();
      await verifyOrganization(organization, { roles: 4, departments: 2, reports: 4, reviews: 4 });
      assert.match(await organization.innerText(), /Published fixture lead/);
      await editTeam();
      await scope.getByRole('button', { name: 'Blank organization', exact: true }).click();
      await review();
      assert.equal(await organization.count(), 0);
    }
    assert.deepEqual(unexpectedWrites, []);
  } finally {
    await context.close();
  }
}

async function main() {
  const dist = path.resolve(process.argv[2] ?? path.join(__dirname, '../../dist/client'));
  const fixture = await start({ dist, port: 0 });
  try {
    const browser = await chromium.launch();
    try {
      await exercise(browser, fixture.url, false);
      await exercise(browser, fixture.url, true);
      console.log('Team template browser probe passed (desktop EN, guided mobile ZH, seed confirmation).');
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
