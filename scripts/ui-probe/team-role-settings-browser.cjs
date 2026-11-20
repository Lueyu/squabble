const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { start } = require('./fixture-server.cjs');

async function main() {
  const fixture = await start({ port: 0 });
  try {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(() => localStorage.setItem('sq-lang', 'en'));
      const page = await context.newPage();
      const api = '55555555-5555-4555-8555-555555555555';
      const paired = 'paired-codex';
      const teamId = 'aaaaaa00-0000-4000-8000-000000000001';
      const teamPath = '/api/teams/' + teamId;
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== fixture.url) return route.abort();
        if (url.pathname === '/api/settings/model-connections') return route.fulfill({ json: { items: [{
          id: api, name: 'Fixture API', available: true, slowModel: 'slow-fixture', fastModel: 'fast-fixture',
        }] } });
        if (url.pathname === '/api/settings/local-agents') return route.fulfill({ json: { items: [{
          id: paired, name: 'Fixture paired Codex', available: true, connected: true, researchTools: { mode: 'mcp', reason: 'supported' },
        }] } });
        if (url.pathname === '/api/agent-roster') {
          const response = await route.fetch();
          const data = await response.json();
          return route.fulfill({ response, json: { ...data, items: data.items.map(agent => ({ ...agent, origin: 'builtin' })) } });
        }
        return route.continue();
      });
      const original = await (await fetch(fixture.url + teamPath)).json();
      await page.goto(fixture.url + '/teams/' + teamId + '?panel=organization&view=list');
      const settings = page.getByRole('complementary', { name: 'Role settings' });
      const runtime = settings.getByRole('combobox', { name: 'Runtime connection' });
      await runtime.waitFor();
      await settings.getByText('Built-in friend · read-only').waitFor();
      await runtime.click();
      await page.getByRole('option', { name: 'Fixture API · API' }).click();
      assert.match(await runtime.innerText(), /Fixture API/);
      await runtime.click();
      await page.getByRole('option', { name: 'Fixture paired Codex · Local assistant' }).click();
      await settings.getByText('More properties', { exact: true }).click();
      await settings.getByRole('textbox', { name: 'Additional instructions for this role' }).fill('One seat only');
      const saved = page.waitForResponse(response => response.url().endsWith(teamPath + '/draft'));
      await settings.getByRole('button', { name: 'Save role draft' }).click();
      const response = await saved;
      assert.equal(response.ok(), true);
      const roles = response.request().postDataJSON().config.roles;
      const edited = roles.filter(role => role.workingInstructions);
      assert.equal(edited.length, 1);
      assert.equal(edited[0].workingInstructions, 'One seat only');
      assert.deepEqual(edited[0].executor, { executionMode: 'local', localAgentId: paired, settings: {} });
      assert.equal(edited[0].participation, 'enabled');
      assert.deepEqual(roles.filter(role => role.id !== edited[0].id), original.draft.config.roles.filter(role => role.id !== edited[0].id));
      await page.reload();
      await runtime.waitFor();
      assert.match(await runtime.innerText(), /Fixture paired Codex/);
      await page.goto(fixture.url + '/friends');
      const builtin = page.getByRole('article').filter({ hasText: 'Built-in friend · read-only' }).first();
      await builtin.getByRole('link', { name: 'Chat' }).waitFor();
      assert.equal(await builtin.getByRole('button', { name: 'Details and edit' }).count(), 0);
      await builtin.getByText('Version and data scope', { exact: true }).click();
      assert.equal(await builtin.getByRole('button', { name: 'Archive agent' }).count(), 0);
      console.log('Role settings and protected roster browser probe passed.');
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
