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
  const properties = page.getByRole('heading', { name: /岗位属性|Role properties/ });
  await organization.waitFor();
  await properties.waitFor();
  await page.getByRole('button', { name: /保存草稿|Save draft/, exact: true }).waitFor();
  await page.getByRole('button', { name: /核对并发布版本|Review and publish version/ }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: /团队工作区页面|Team workspace panels/ }).count(), 0);
  assert.equal(await page.getByText(/容器宽度|Container width|Explicit model identifier/).count(), 0);
  await page.getByRole('combobox', { name: /指派已有股友|Assign an existing friend/ }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: /执行连接|Executor connection/ }).isVisible(), false);
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

async function verifyMobileEditing(page, url, tag) {
  await page.getByRole('button', { name: /^(画布|Canvas)$/ }).tap();
  await page.locator('.team-canvas').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('view'), 'canvas');
  await page.getByRole('button', { name: /^(列表|List)$/ }).tap();
  await page.getByRole('button', { name: /^财报专家 ·/ }).tap();
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
    page.getByRole('button', { name: /^(保存草稿|Save draft)$/ }).tap(),
  ]);
  const config = write.postDataJSON().config;
  assert.ok(hasScope(config, '并行汇报电子回归'));
  assert.ok(hasScope(config, '关键财务风险'));
  await page.getByRole('button', { name: /^(保存草稿|Save draft)$/ }).waitFor();
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
  const { server, url } = await start({ port: 0, dist: path.join(ROOT, 'dist/client') });
  let browser;
  const results = [];
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    browser = await chromium.launch();
    for (const viewport of VIEWPORTS) {
      const mobile = viewport.width < 700;
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height },
        hasTouch: mobile, colorScheme: viewport.dark ? 'dark' : 'light' });
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
