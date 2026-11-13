'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('DOM probe distinguishes genuine scroll from hidden local clipping and finds small controls', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  await page.setContent(`<style>body{margin:0} #clip{width:390px;overflow:hidden} #clip button{margin-left:340px;width:100px;height:30px} #scroll{width:200px;overflow-x:auto} #scroll table{width:800px} #tiny{width:16px;height:16px;padding:0;border:0} #wrap{width:70px;height:24px;white-space:normal;overflow:hidden}</style>
    <div id="clip"><button id="clipped">Archived</button></div>
    <div id="scroll"><table><tr><td><button>Intentional table scroll</button></td></tr></table></div>
    <button id="tiny" aria-label="Close">x</button><button id="wrap">Multiple words must wrap here</button>`);
  const { inspectDOM } = require('./dom-probe.cjs');
  const findings = await page.evaluate(inspectDOM, {});
  assert.ok(findings.some(item => item.code === 'H_OVERFLOW' && item.selector === '#clipped'));
  assert.ok(findings.some(item => item.code === 'TAP_TARGET' && item.selector === '#tiny' && item.metric.actual === 16));
  assert.ok(findings.some(item => item.code === 'BTN_WRAP' && item.selector === '#wrap'));
  assert.ok(!findings.some(item => item.code === 'H_OVERFLOW' && item.selector.includes('table')));
  assert.ok(!findings.some(item => item.code === 'H_OVERFLOW' && item.selector === 'html'));
  for (const finding of findings) {
    assert.equal(typeof finding.rect.w, 'number');
    assert.equal(typeof finding.styles.display, 'string');
  }
});

test('explicit normal multiline text that fits is allowed; clipped or nowrap lines are not', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
  await page.setContent(`<style>button{width:100px;line-height:20px;padding:8px;white-space:normal} #natural{height:auto} #clipped{height:24px;overflow:hidden} #nowrap{white-space:nowrap}</style>
  <button id="natural">Share only this note with the selected team</button>
  <button id="clipped">Share only this note with the selected team</button>
  <button id="nowrap">First line<br>Second line</button>`);
  const { inspectDOM } = require('./dom-probe.cjs');
  const findings = await page.evaluate(inspectDOM, {});
  assert.ok(!findings.some(item => item.code === 'BTN_WRAP' && item.selector === '#natural'));
  assert.ok(findings.some(item => item.code === 'BTN_WRAP' && item.selector === '#clipped'));
  assert.ok(findings.some(item => item.code === 'BTN_WRAP' && item.selector === '#nowrap'));
});

test('alignment only inspects declared sibling card targets in the same row', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
  await page.setContent(`<style>.grid{display:flex} article{width:200px;height:200px} #a .actions{margin-top:20px} #b .actions{margin-top:40px} aside{margin-top:50px}</style>
  <section class="grid"><article id="a"><div class="actions"><button>One</button></div></article><article id="b"><div class="actions"><button>Two</button></div></article></section><aside>Different nested content is not an alignment contract.</aside>`);
  const { inspectDOM } = require('./dom-probe.cjs');
  const empty = await page.evaluate(inspectDOM, {});
  assert.ok(!empty.some(item => item.code.startsWith('MISALIGN')));
  const findings = await page.evaluate(inspectDOM, { alignmentRules: [{ groupSelector: '.grid > article', targetSelector: '.actions', edge: 'top', code: 'MISALIGN_TOP', tolerance: 2 }] });
  const alignment = findings.filter(item => item.code === 'MISALIGN_TOP');
  assert.equal(alignment.length, 1);
  assert.equal(alignment[0].metric.actual, 20);
  assert.match(alignment[0].selector, /#b/);
});

test('clickable labels supply hit bounds while standalone checkboxes and card overflow remain visible', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
  await page.setContent(`<style>button{padding:0;border:0;width:16px;height:16px} label{display:flex;width:200px;height:40px} article{width:220px} #share{width:300px;height:32px}</style>
  <label><button id="wrapped" role="checkbox">x</button>Large wrapping label</label>
  <label for="associated">Large associated label</label><input id="associated" type="checkbox" style="width:16px;height:16px">
  <button id="standalone" role="checkbox">x</button><article><button id="share">Share only this note with the selected team</button></article>`);
  const { inspectDOM } = require('./dom-probe.cjs');
  const findings = await page.evaluate(inspectDOM, {});
  assert.ok(!findings.some(item => item.code === 'TAP_TARGET' && ['#wrapped', '#associated'].includes(item.selector)));
  assert.ok(findings.some(item => item.code === 'TAP_TARGET' && item.selector === '#standalone'));
  assert.ok(findings.some(item => item.code === 'H_OVERFLOW' && item.selector === '#share'));
});

test('closed native details hide controls while open details controls are measured', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
  await page.setContent(`<style>button{width:16px;height:16px;padding:0;border:0}</style>
    <details><summary>Closed options</summary><button id="closed">x</button></details>
    <details open><summary>Open options</summary><button id="open">x</button></details>`);
  const { inspectDOM } = require('./dom-probe.cjs');
  const findings = await page.evaluate(inspectDOM, {});
  assert.ok(!findings.some(item => item.selector === '#closed'));
  assert.ok(findings.some(item => item.code === 'TAP_TARGET' && item.selector === '#open'));
});
