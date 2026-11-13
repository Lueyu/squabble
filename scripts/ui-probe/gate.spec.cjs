'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

function sample(findings = []) {
  return {
    schemaVersion: 1, status: 'complete', matrixHash: 'matrix', tokenHash: 'token',
    probeHash: 'probe', expectedScenarios: ['friends|default|390', 'paper|default|390'],
    scenarios: [
      { id: 'friends|default|390', route: '/friends', state: 'default', viewport: 390, status: 'complete' },
      { id: 'paper|default|390', route: '/paper', state: 'default', viewport: 390, status: 'complete' },
    ], findings,
  };
}
const finding = (code, selector, sev = 'P1') => ({ code, selector, sev, route: '/friends', state: 'default', viewport: 390,
  rect: { x: 0, y: 0, w: 30, h: 16 }, metric: { actual: 16, expected: 24, unit: 'px' },
  styles: { display: 'block' }, sourceHint: null, shot: 'shots/fake.png' });
function run(before, after, extra = {}) {
  const { evaluateGate } = require('./gate.cjs');
  return evaluateGate(before, after, { expectedMatrixHash: 'matrix', expectedTokenHash: 'token', expectedProbeHash: 'probe', minGain: 1, ...extra });
}

test('gate accepts an actual decrease with no new P0 or P1 identities', () => {
  assert.equal(run(sample([finding('TAP_TARGET', '#a'), finding('BTN_WRAP', '#b')]), sample([finding('TAP_TARGET', '#a')])).pass, true);
});
test('same score with a replacement P1 cannot pass', () => {
  const result = run(sample([finding('TAP_TARGET', '#a')]), sample([finding('TAP_TARGET', '#b')]));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes('NEW_P1'));
  assert.ok(result.reasons.includes('NO_NET_GAIN'));
});
test('new P0 cannot hide behind a larger total score improvement', () => {
  const before = sample(Array.from({ length: 12 }, (_, i) => finding('TAP_TARGET', '#x' + i)));
  const result = run(before, sample([finding('H_OVERFLOW', 'html', 'P0')]));
  assert.ok(result.reasons.includes('NEW_P0'));
});
test('missing, failed, duplicated or changed scenarios cannot pass', () => {
  const before = sample([finding('TAP_TARGET', '#a')]);
  for (const change of [
    after => after.scenarios.pop(),
    after => { after.scenarios[0].status = 'failed'; },
    after => { after.scenarios[1].id = after.scenarios[0].id; },
    after => { after.matrixHash = 'narrower'; },
    after => { after.expectedScenarios = ['friends|default|390']; },
  ]) {
    const after = sample();
    change(after);
    assert.equal(run(before, after).pass, false);
  }
});
test('tampering both snapshot token hashes still fails against current source fingerprint', () => {
  const before = sample([finding('TAP_TARGET', '#a')]);
  const after = sample();
  before.tokenHash = after.tokenHash = 'forged';
  assert.ok(run(before, after).reasons.includes('TOKEN_SOURCE_CHANGED'));
  assert.equal(run(before, after, { expectedTokenHash: 'different actual source' }).pass, false);
});
test('changing detector fingerprint cannot silently reduce findings', () => {
  const before = sample([finding('TAP_TARGET', '#a')]);
  const after = sample();
  after.probeHash = 'weaker probe';
  assert.equal(run(before, after).pass, false);
});
test('P1 to P0 and P2 to P1 severity escalations are new high-priority findings', () => {
  const many = Array.from({ length: 20 }, (_, i) => finding('TAP_TARGET', '#removed' + i));
  for (const [oldSeverity, newSeverity, reason] of [['P1', 'P0', 'NEW_P0'], ['P2', 'P1', 'NEW_P1']]) {
    const result = run(sample([...many, finding('H_OVERFLOW', '#same', oldSeverity)]), sample([finding('H_OVERFLOW', '#same', newSeverity)]));
    assert.ok(result.reasons.includes(reason));
  }
});
test('a different browser, operating system or font environment cannot claim improvement', () => {
  for (const environment of [{ chromium: 'new version' }, { platform: 'different os' }, { fonts: ['missing'] }]) {
    const before = sample([finding('TAP_TARGET', '#a')]);
    const after = sample();
    before.environment = { chromium: 'old version', platform: 'win32', fonts: ['Arial'] };
    after.environment = { ...before.environment, ...environment };
    assert.ok(run(before, after).reasons.includes('ENVIRONMENT_CHANGED'));
  }
});
test('invalid severity or missing geometry cannot create a false score improvement', () => {
  for (const corrupt of [item => { item.sev = 'P3'; }, item => { item.metric.actual = NaN; }, item => { delete item.rect; }]) {
    const before = sample([finding('TAP_TARGET', '#a')]);
    const bad = finding('TAP_TARGET', '#a');
    corrupt(bad);
    const result = run(before, sample([bad]));
    assert.ok(result.reasons.includes('INVALID_FINDING'));
  }
});
test('a finding for a missing scenario or duplicate evidence cannot pass', () => {
  const before = sample([finding('TAP_TARGET', '#a'), finding('TAP_TARGET', '#b')]);
  const bad = finding('TAP_TARGET', '#a');
  bad.state = 'unscanned';
  assert.ok(run(before, sample([bad])).reasons.includes('INVALID_FINDING'));
  assert.ok(run(sample([...before.findings, before.findings[0]]), sample()).reasons.includes('INVALID_FINDING'));
});
