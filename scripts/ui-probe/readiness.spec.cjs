'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('a rendered crash fallback fails even when a generic main element exists', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const { assertPageReady } = require('./probe.cjs');
  await page.setContent('<main>Application shell</main><h1>Something went wrong</h1><p>Cannot read properties of undefined</p>');
  await assert.rejects(async () => assertPageReady(page, { readySelector: 'main' }), /Application crash boundary/);
  await page.setContent('<main><input id="asset-account-selector"></main>');
  await assertPageReady(page, { readySelector: '#asset-account-selector' });
});
