'use strict';

// Fictional browser probe for the team organization config page. Talks only to
// the local fixture server (no upstream transport), never to a real instance.
// Captures screenshots at the acceptance viewports and asserts the three-column
// canvas, the mode toolbar and the absence of horizontal overflow.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./fixture-server.cjs');

const TEAM_ID = 'aaaaaa00-0000-4000-8000-000000000001';
const EVIDENCE = path.resolve(__dirname, '../../docs/team-organization-redesign/evidence');
const VIEWPORTS = [
  { width: 1440, height: 1080, label: '1440x1080', dark: false },
  { width: 1440, height: 1080, label: '1440x1080-dark', dark: true },
  { width: 1440, height: 900, label: '1440x900', dark: false },
  { width: 1366, height: 768, label: '1366x768', dark: false },
  { width: 1280, height: 800, label: '1280x800', dark: false },
  { width: 1024, height: 768, label: '1024x768', dark: false },
  { width: 390, height: 844, label: '390x844', dark: false },
  { width: 1920, height: 1080, label: '1920x1080-dark', dark: true },
];

async function main() {
  const { server, url } = await start({ port: 0, dist: path.resolve(__dirname, '../../dist/client') });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  const results = [];
  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    await page.addInitScript(({dark}) => { localStorage.setItem('pt-theme', dark ? 'dark' : 'light'); localStorage.setItem('sq-lang', 'zh-CN'); }, {dark: viewport.dark});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${url}/teams/${TEAM_ID}?panel=organization`, { waitUntil: 'networkidle', timeout: 60000 }).catch(error => errors.push('goto: ' + error.message));
    try {
      await page.waitForSelector('.team-editor-three', { timeout: 60000 });
      await page.waitForSelector('.team-editor-toolbar', { timeout: 60000 }).catch(() => undefined);
      await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length > 0 || !!document.querySelector('.team-outline'), undefined, { timeout: 60000 });
    } catch (error) {
      errors.push('render: ' + error.message);
    }
    const metrics = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      canvasHeight: (document.querySelector('.team-canvas')?.getBoundingClientRect().height) ?? null,
      columns: getComputedStyle(document.querySelector('.team-editor-three') ?? document.body).gridTemplateColumns,
      canvasNodes: document.querySelectorAll('.react-flow__node').length,
      hasSidebar: !!document.querySelector('.team-editor-sidebar'),
      hasInspector: !!document.querySelector('.team-inspector'),
      hasToolbar: !!document.querySelector('.team-editor-toolbar'),
      panelTabs: [...document.querySelectorAll('.team-panel-tab, [class*="panel-tab"]')].map(node => node.textContent?.trim()).filter(Boolean),
      hasReportButton: /发布团队版本|Publish team version/.test(document.body.innerText),
      hasSaveButton: /保存草稿|Save draft/.test(document.body.innerText),
      outlineHeight: document.querySelector('.team-outline-items')?.getBoundingClientRect().height ?? 0,
      headingHeight: document.querySelector('.team-editor-header h1')?.getBoundingClientRect().height ?? 0,
      hasOutline: !!document.querySelector('.team-outline'),
      outlineItems: document.querySelectorAll('.team-outline [data-outline-role], .team-outline button').length,
    }));
    // Exercise the actual responsive editor, not only the presence of containers.
    try {
      if (viewport.width < 700) {
        await page.getByRole('button', { name: /自由画布视图|Free canvas view/ }).click();
        await page.waitForSelector('.team-canvas');
        if (!new URL(page.url()).searchParams.get('view')?.includes('canvas')) throw new Error('canvas preference not persisted');
        await page.getByRole('button', { name: /组织列表视图|Organization list view/ }).click();
        await page.locator('.team-outline-label').filter({ hasText: /财报专家/ }).click();
        await page.waitForSelector('[role="dialog"] .team-inspector');
        await page.locator('[role="dialog"] input').first().fill('手机修改岗位');
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        if (!await page.getByText('手机修改岗位', { exact: true }).isVisible()) throw new Error('mobile property edit did not update list');
      } else {
        const background = await page.locator('.team-canvas').evaluate(e => getComputedStyle(e).backgroundColor);
        if (!background) throw new Error('missing canvas background');
        await page.getByRole('button', { name: /新增汇报|Add reporting/ }).click();
        await page.waitForSelector('[role="dialog"] [role="combobox"]');
        await page.getByRole('button', { name: /取消|Cancel/, exact: true }).click();
      }
    } catch (error) { errors.push('interaction: ' + error.message); }
    const file = `team-org-${viewport.label}.png`;
    await page.screenshot({ path: path.join(EVIDENCE, file), fullPage: false });
    const problems = [];
    if (metrics.outlineHeight < 60) problems.push('outline has no usable scrolling height');
    if (viewport.width < 700 && metrics.headingHeight > 60) problems.push('mobile heading wraps into a narrow column');
    if (metrics.overflowX > 1) problems.push(`horizontal overflow ${metrics.overflowX}px`);
    if (!metrics.hasSaveButton) problems.push('save button missing');
    if (!metrics.hasReportButton) problems.push('publish button missing');
    if (viewport.width >= 960) {
      if (!metrics.hasSidebar) problems.push('sidebar missing');
      if (viewport.width >= 1600 && !metrics.hasInspector) problems.push('inspector missing');
      if (!metrics.hasToolbar) problems.push('toolbar missing');
      if (metrics.canvasNodes < 3) problems.push(`only ${metrics.canvasNodes} canvas nodes`);
    } else {
      if (!metrics.hasOutline) problems.push('mobile outline/list view missing');
      if (metrics.outlineItems < 3) problems.push(`only ${metrics.outlineItems} outline entries`);
      if (metrics.canvasNodes > 0) problems.push('mobile unexpectedly rendered the canvas');
    }
    if (errors.length) problems.push('page errors: ' + errors.join(' | ').slice(0, 300));
    results.push({ label: viewport.label, file, metrics, problems });
    if (problems.length) failures.push({ label: viewport.label, problems });
    await page.close();
  }
  const report = { fixtureUrl: url, capturedAt: new Date().toISOString(), viewports: VIEWPORTS.length, results, failures };
  const reportPath = path.join(EVIDENCE, 'team-organization-browser.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
  console.log(JSON.stringify({ results: results.map(item => ({ label: item.label, file: item.file, problems: item.problems })), failures }, null, 2));
  if (failures.length) {
    console.error('PROBE FAILED: ' + failures.map(item => item.label + ': ' + item.problems.join('; ')).join('\n'));
    process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
