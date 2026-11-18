'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./fixture-server.cjs');

const TEAM_ID = 'aaaaaa00-0000-4000-8000-000000000001';
const TEAM_PATH = '/teams/' + TEAM_ID;
const ROOT = path.resolve(__dirname, '../..');
const EVIDENCE = path.join(ROOT, 'dist/ui-probe/team-organization');
const VIEWPORTS = [
  { width: 1440, height: 1080, label: '1440x1080', lang: 'zh-CN' },
  { width: 1440, height: 1080, label: '1440x1080-dark', lang: 'zh-CN', dark: true },
  { width: 1440, height: 900, label: '1440x900', lang: 'en' },
  { width: 1366, height: 768, label: '1366x768', lang: 'zh-CN' },
  { width: 1280, height: 800, label: '1280x800', lang: 'en' },
  { width: 1024, height: 768, label: '1024x768', lang: 'en' },
  { width: 390, height: 844, label: '390x844', lang: 'zh-CN' },
  { width: 390, height: 844, label: '390x844-dark', lang: 'en', dark: true },
  { width: 1920, height: 1080, label: '1920x1080-dark', lang: 'en', dark: true },
];
const relationTrigger = page => page.getByRole('button', { name: /汇报与协作 ·|Reporting and collaboration ·/ });
const dialog = page => page.getByRole('dialog');
const scope = page => dialog(page).getByRole('textbox', { name: /责任范围|Responsibility scope/ });
const apply = page => dialog(page).getByRole('button', { name: /应用到草稿|Apply to draft/ });
const relationWithScope = (page, value) => dialog(page).getByRole('button', { name: new RegExp(value) });
const hasScope = (config, value) => config.relations.some(relation => relation.responsibilityScope === value);

async function openOrganization(page, url, suffix = '?panel=organization') {
  await page.goto(url + TEAM_PATH + suffix, { waitUntil: 'domcontentloaded' });
  await page.locator('.team-organization-heading h1').filter({ hasText: /配置经典投研团队|Configure 经典投研团队/ }).waitFor();
}

async function verifyLayout(page, mobile) {
  const organization = page.getByRole('heading', { name: /团队组织|Team organization/ });
  const properties = page.getByRole('heading', { name: /岗位设置|Role settings/ });
  await organization.waitFor();
  await properties.waitFor();
  await page.getByRole('button', { name: /^(保存岗位草稿|Save role draft)$/ }).waitFor();
  await page.getByRole('button', { name: /核对并发布版本|Review and publish version/ }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: /团队工作区页面|Team workspace panels/ }).count(), 0);
  assert.equal(await page.getByText(/容器宽度|Container width|Explicit model identifier/).filter({ visible: true }).count(), 0, 'advanced controls start closed');
  await page.getByText(/^(更换已指派股友|Replace assigned friend)$/).waitFor();
  await page.getByRole('combobox', { name: /运行连接|Runtime connection/ }).waitFor();
  const grid = await organization.evaluate(element => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    columns: getComputedStyle(element.closest('.team-organization-grid')).gridTemplateColumns.split(' ').length,
  }));
  assert.ok(grid.width <= grid.viewport + 1, 'no horizontal overflow');
  assert.equal(grid.columns, mobile ? 1 : 2);
  if (mobile) {
    await page.getByRole('region', { name: /组织列表|Organization list/ }).waitFor();
    assert.equal(await page.locator('.react-flow__node').count(), 0);
  } else {
    await page.locator('.react-flow__node').nth(3).waitFor();
    assert.ok(await page.locator('.react-flow__edge').count() >= 3);
  }
}

async function verifyCanvasKeyboard(page, tag) {
  const edge = page.getByRole('button', { name: /关键财务风险/ });
  await edge.focus();
  await edge.press('Enter');
  await dialog(page).getByRole('heading', { name: /编辑汇报与协作|Edit relation/ }).waitFor();
  assert.equal(await scope(page).inputValue(), '关键财务风险');
  await page.screenshot({ animations: 'disabled', path: path.join(EVIDENCE, `relation-${tag}.png`) });
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.matches('.react-flow__edge'));
}

async function verifyCanvasControls(page) {
  const zoom = page.getByRole('button', { name: /恢复100%缩放|Reset zoom to 100%/ });
  const fit = page.getByRole('button', { name: /适应画布|Fit canvas/ });
  const canvas = page.locator('.team-canvas');
  const role = name => canvas.locator('.react-flow__node-teamRole').filter({ has: page.getByText(name, { exact: true }) });
  const reports = ['关键财务风险', '口径依据'].map(label =>
    canvas.getByRole('button', { name: new RegExp(label) }).locator('.react-flow__edge-path'));
  await Promise.all(reports.map(path => path.waitFor({ state: 'attached' })));
  assert.notEqual(await reports[0].getAttribute('d'), await reports[1].getAttribute('d'), 'each manager has its own line');

  await zoom.click();
  await page.waitForFunction(() => document.querySelector('.team-zoom-tools button:nth-child(2)')?.textContent === '100%');
  await page.getByRole('button', { name: /^放大$|^Zoom in$/ }).click();
  await page.waitForFunction(() => parseInt(document.querySelector('.team-zoom-tools button:nth-child(2)')?.textContent, 10) > 100);
  await page.getByRole('button', { name: /^缩小$|^Zoom out$/ }).click();
  await page.waitForFunction(() => document.querySelector('.team-zoom-tools button:nth-child(2)')?.textContent === '100%');
  await fit.click();
  await page.waitForFunction(() => parseInt(document.querySelector('.team-zoom-tools button:nth-child(2)')?.textContent, 10) < 100);

  const analyst = role('财报专家');
  await analyst.locator('[data-persona]').waitFor();
  const origin = new URL(page.url()).origin;
  const detail = await (await page.request.get(origin + '/api/teams/' + TEAM_ID)).json();
  const roster = await (await page.request.get(origin + '/api/agent-roster')).json();
  const analystId = Object.keys(detail.display.roleLabels).find(id => detail.display.roleLabels[id] === '财报专家');
  const binding = detail.draft.config.roles.find(item => item.id === analystId);
  const friend = roster.items.find(item => item.id === binding.agentId);
  assert.equal(await analyst.locator('[data-persona]').getAttribute('data-persona'), friend.avatar);
  assert.equal(await analyst.locator('.team-role-identity p').textContent(), friend.name);
  await analyst.click();
  await page.locator('.team-canvas-footer').getByRole('button', { name: /岗位设置|Role settings/ }).click();
  await page.waitForFunction(() => document.activeElement?.matches('.team-inspector h2'));
  assert.equal(await page.getByRole('textbox', { name: /岗位名称|Role name/ }).inputValue(), '财报专家');

  const viewport = canvas.locator('.react-flow__viewport');
  const beforePan = await viewport.evaluate(element => element.style.transform);
  const bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + 12, bounds.y + 16);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 55, bounds.y + 43, { steps: 6 });
  await page.mouse.up();
  assert.notEqual(await viewport.evaluate(element => element.style.transform), beforePan);

  const beforeWheel = await zoom.textContent();
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(before => document.querySelector('.team-zoom-tools button:nth-child(2)')?.textContent !== before, beforeWheel);

  await page.getByText(/^(组织工具|Organization tools)$/).click();
  await page.getByRole('button', { name: /^(自动布局|Auto layout)$/ }).click();
  await fit.click();
  await page.waitForFunction(() => {
    const box = id => {
      const node = document.querySelector(`.react-flow__node[data-id="c0000000-0000-4000-8000-00000000000${id}"]`);
      return node && getComputedStyle(node).visibility === 'visible' ? node.getBoundingClientRect() : null;
    };
    const analyst = box(2), lead = box(1), manager = box(3);
    const canvas = document.querySelector('.team-canvas')?.getBoundingClientRect();
    return analyst && lead && manager && canvas
      && analyst.top >= lead.bottom && analyst.top >= manager.bottom
      && [analyst, lead, manager, box(4)].every(node => node
        && node.top >= canvas.top && node.bottom <= canvas.bottom && node.left >= canvas.left && node.right <= canvas.right);
  });
  await page.screenshot({ animations: 'disabled', path: path.join(EVIDENCE, 'team-org-multiple-managers.png') });
}

async function verifyParallelRelations(page, url) {
  await page.route(url + '/api/teams/' + TEAM_ID, async route => {
    const response = await route.fetch();
    const body = await response.json();
    const original = body.draft.config.relations.find(edge => edge.responsibilityScope === '口径依据');
    body.draft.config.relations.push(
      { ...original, id: 'c0000000-0000-4000-8000-000000000201', kind: 'delegates_to', responsibilityScope: '平行委托' },
      { ...original, id: 'c0000000-0000-4000-8000-000000000202', kind: 'reviews', responsibilityScope: '反向复核',
        fromRoleId: original.toRoleId, toRoleId: original.fromRoleId },
    );
    await route.fulfill({ response, json: body });
  });
  await openOrganization(page, url);
  await page.getByText(/^(组织工具|Organization tools)$/).click();
  await page.getByRole('combobox', { name: /显示关系|Visible relations/ }).click();
  await page.getByRole('option', { name: /^(全部关系|All relations)$/ }).click();
  const edges = page.locator('.team-canvas').getByRole('button', { name: /口径依据|平行委托|反向复核/ });
  const paths = edges.locator('.react-flow__edge-path');
  await paths.nth(2).waitFor();
  const routes = await paths.evaluateAll(elements => elements.map(path => {
    const length = path.getTotalLength();
    const from = path.getPointAtLength(0);
    const to = path.getPointAtLength(length);
    const middle = path.getPointAtLength(length / 2);
    const markerId = path.getAttribute('marker-end')?.match(/^url\(['"]?#(.+?)['"]?\)$/)?.[1];
    const marker = markerId ? document.getElementById(markerId) : null;
    return { name: path.closest('.react-flow__edge').getAttribute('aria-label'), arrow: marker?.tagName === 'marker',
      from: from.x, to: to.x, middle: middle.y };
  }));
  assert.equal(routes.length, 3);
  assert.equal(routes.filter(route => !route.arrow).map(route => route.name).join(', '), '', 'each rendered route ends with a target arrow');
  assert.ok(routes.every(route => route.name.includes('反向复核') ? route.from > route.to : route.from < route.to));
  const lanes = routes.map(route => route.middle).sort((a, b) => a - b);
  assert.ok(lanes[1] - lanes[0] >= 10 && lanes[2] - lanes[1] >= 10, 'same-row routes have visibly separated lanes');
  const canvas = page.locator('.team-canvas');
  for (const name of ['口径依据', '平行委托', '反向复核']) {
    await canvas.scrollIntoViewIfNeeded();
    const path = canvas.getByRole('button', { name: new RegExp(name) }).locator('.react-flow__edge-path');
    const { x, y } = await path.evaluate(element => {
      const middle = element.getPointAtLength(element.getTotalLength() / 2);
      const point = middle.matrixTransform(element.getScreenCTM());
      return { x: point.x, y: point.y };
    });
    await page.mouse.click(x, y);
    await dialog(page).waitFor();
    assert.equal(await scope(page).inputValue(), name);
    await page.keyboard.press('Escape');
    await dialog(page).waitFor({ state: 'hidden' });
  }
  await canvas.screenshot({ animations: 'disabled', path: path.join(EVIDENCE, 'team-org-parallel-relations.png') });
}

async function verifyMobileEditing(page, url, tag) {
  await page.getByRole('button', { name: /^(画布|Canvas)$/ }).tap();
  await page.locator('.team-canvas').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('view'), 'canvas');
  await page.getByRole('button', { name: /^(列表|List)$/ }).tap();
  await page.getByRole('button', { name: /^财报专家 ·/ }).tap();
  await page.locator('.team-canvas-footer').getByRole('button', { name: /岗位设置|Role settings/ }).tap();
  await page.waitForFunction(() => document.activeElement?.matches('.team-inspector h2'));
  const name = page.getByRole('textbox', { name: /岗位名称|Role name/ });
  await name.fill('手机修改岗位');
  assert.equal(await page.getByRole('button', { name: /^手机修改岗位 ·/ }).isVisible(), true);

  const related = relationTrigger(page);
  await related.tap();
  await relationWithScope(page, '关键财务风险').tap();
  await page.screenshot({ animations: 'disabled', path: path.join(EVIDENCE, `relation-${tag}.png`) });
  await dialog(page).getByRole('button', { name: /反转关系方向|Reverse relation/ }).tap();
  assert.match(await dialog(page).getByRole('combobox', { name: /起点岗位|From role/ }).innerText(), /投资负责人/);
  await dialog(page).getByRole('button', { name: /^(取消|Cancel)$/ }).tap();
  await page.waitForFunction(() => document.activeElement?.matches('.team-inspector-relations'));

  await page.getByRole('button', { name: /^(新增关系|Add relation)$/ }).tap();
  assert.equal(await apply(page).isEnabled(), false, 'reporting requires a scope');
  assert.match(await dialog(page).getByRole('combobox', { name: /起点岗位|From role/ }).innerText(), /手机修改岗位/);
  await scope(page).fill('关键财务风险');
  await apply(page).tap();
  const duplicate = page.getByRole('button', { name: /关系与责任范围重复|This relation and responsibility scope already exist/ });
  await duplicate.tap();
  assert.equal(await scope(page).inputValue(), '关键财务风险');
  await scope(page).fill('并行汇报电子回归');
  await apply(page).tap();

  await related.tap();
  await relationWithScope(page, '并行汇报电子回归').tap();
  await dialog(page).getByRole('button', { name: /删除关系|Delete relation/ }).tap();
  await page.getByRole('button', { name: /^(撤销|Undo)$/ }).tap();
  await related.tap();
  await relationWithScope(page, '并行汇报电子回归').waitFor();
  await relationWithScope(page, '关键财务风险').waitFor();
  await dialog(page).getByRole('button', { name: /^(关闭|Close)$/ }).tap();

  const [write] = await Promise.all([
    page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).pathname.endsWith(TEAM_PATH + '/draft')),
    page.getByRole('button', { name: /^(保存岗位草稿|Save role draft)$/ }).tap(),
  ]);
  const config = write.postDataJSON().config;
  assert.ok(hasScope(config, '并行汇报电子回归'));
  assert.ok(hasScope(config, '关键财务风险'));
  await page.getByRole('button', { name: /^(保存岗位草稿|Save role draft)$/ }).waitFor();
  await page.getByRole('button', { name: /核对并发布版本|Review and publish version/ }).tap();
  await dialog(page).getByRole('heading', { name: /检查并发布配置|Review and publish configuration/ }).waitFor();
  const [review] = await Promise.all([
    page.waitForResponse(response => response.ok() && new URL(response.url()).pathname.endsWith(TEAM_PATH + '/publish-preview')),
    dialog(page).getByRole('button', { name: /重新检查|Check configuration/ }).tap(),
  ]);
  assert.ok(hasScope((await review.json()).result.config, '并行汇报电子回归'));
  assert.equal(await dialog(page).getByRole('button', { name: /发布配置版本|Publish version/ }).isEnabled(), false);
  await dialog(page).getByRole('button', { name: /返回修改|Back to editing/ }).tap();
  await page.getByRole('button', { name: /版本历史与变更|Version history and changes/ }).tap();
  await page.getByRole('heading', { name: /不可变发布版本|Immutable published versions/ }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('panel'), 'versions');

  await openOrganization(page, url, '?panel=relations&view=list');
  await dialog(page).getByRole('heading', { name: /^(汇报与协作|Reporting and collaboration)$/ }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('panel'), 'organization');
  assert.equal(new URL(page.url()).searchParams.get('view'), 'list');
  await relationWithScope(page, '并行汇报电子回归').waitFor();
  await dialog(page).getByRole('button', { name: /^(关闭|Close)$/ }).tap();
  assert.equal(new URL(page.url()).searchParams.has('relations'), false);
}

async function verifyArchived(page, url) {
  await page.route(`**/api${TEAM_PATH}`, async route => {
    const response = await route.fetch();
    const team = await response.json();
    await route.fulfill({ response, json: { ...team, status: 'archived' } });
  });
  await openOrganization(page, url, '?panel=relations');
  await relationWithScope(page, '关键财务风险').click();
  await dialog(page).getByRole('heading', { name: /查看汇报与协作|View relation/ }).waitFor();
  assert.equal(await scope(page).inputValue(), '关键财务风险');
  assert.equal(await scope(page).getAttribute('readonly'), '');
  assert.equal(await dialog(page).getByRole('combobox', { name: /起点岗位|From role/ }).isEnabled(), false);
  assert.equal(await apply(page).count(), 0);
  await dialog(page).getByRole('button', { name: /^(关闭|Close)$/ }).click();
  assert.equal(await page.getByRole('button', { name: /^(新增关系|Add relation)$/ }).count(), 0);
  await page.getByRole('button', { name: /版本历史与变更|Version history and changes/ }).click();
  await page.getByRole('heading', { name: /不可变发布版本|Immutable published versions/ }).waitFor();
}

async function main() {
  const { server, url } = await start({ port: 0, dist: process.env.TEAM_ORGANIZATION_CLIENT_DIST ?? path.join(ROOT, 'dist/client') });
  let browser;
  const results = [];
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    browser = await chromium.launch();
    for (const viewport of VIEWPORTS) {
      const mobile = viewport.width < 700;
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height },
        hasTouch: mobile, colorScheme: viewport.dark ? 'dark' : 'light' });
      await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
      page.setDefaultTimeout(8000);
      const problems = [];
      page.on('pageerror', error => problems.push(error.message));
      await page.addInitScript(({ dark, lang }) => {
        localStorage.setItem('pt-theme', dark ? 'dark' : 'light');
        localStorage.setItem('sq-lang', lang);
      }, { dark: viewport.dark, lang: viewport.lang });
      try {
        await openOrganization(page, url);
        await verifyLayout(page, mobile);
        await page.screenshot({ animations: 'disabled', path: path.join(EVIDENCE, `team-org-${viewport.label}.png`) });
        if (viewport.label === '1440x1080') {
          await verifyCanvasControls(page);
          await verifyParallelRelations(page, url);
        }
        if (viewport.label === '1440x1080-dark') await verifyCanvasKeyboard(page, viewport.label);
        if (viewport.label === '390x844') await verifyMobileEditing(page, url, viewport.label);
        if (viewport.label === '390x844-dark') await verifyArchived(page, url);
      } catch (error) {
        problems.push(error.message);
        await page.screenshot({ animations: 'disabled', path: path.join(EVIDENCE, `failure-${viewport.label}.png`) });
      } finally {
        await page.close();
      }
      results.push({ viewport: viewport.label, problems });
    }
    fs.writeFileSync(path.join(EVIDENCE, 'team-organization-browser.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    assert.ok(results.every(result => !result.problems.length), 'organization browser acceptance');
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
