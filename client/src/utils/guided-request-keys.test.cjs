const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

const f = fixture();
const { GUIDED_REQUEST_KEY_SEPARATOR, guidedRequestKey } = f.load('features/teams/guided-request-keys.ts');

// The investment module's requestKey schema (investment-policy.rules.ts) rejects ':' and
// anything outside [a-zA-Z0-9_-] with "Please check the supplied investment details.".
const strictInvestmentKey = /^[a-zA-Z0-9_-]{8,128}$/u;

test('composite keys join with a schema-safe separator', () => {
  assert.equal(GUIDED_REQUEST_KEY_SEPARATOR, '--');
  assert.equal(guidedRequestKey('flow', 'team'), 'flow--team');
  assert.equal(guidedRequestKey('flow', 'seed', 'step'), 'flow--seed--step');
  assert.equal(guidedRequestKey('flow', 'publish', 2), 'flow--publish--2');
  assert.equal(guidedRequestKey('flow', 'team', ''), 'flow--team');
});

test('every guided step key satisfies the strict investment request-key contract', () => {
  const uuid = () => crypto.randomUUID();
  const keys = [
    guidedRequestKey(uuid(), 'team'),
    guidedRequestKey(uuid(), 'draft'),
    guidedRequestKey(uuid(), 'display'),
    guidedRequestKey(uuid(), 'publish-preview', 2),
    guidedRequestKey(uuid(), 'publish', 2),
    guidedRequestKey(uuid(), 'account', 1),
    guidedRequestKey(uuid(), 'binding-preview', 2),
    guidedRequestKey(uuid(), 'binding', 2),
    guidedRequestKey(uuid(), 'agreement-preview', 2),
    guidedRequestKey(uuid(), 'agreement', 2),
    guidedRequestKey(uuid(), 'start', 2),
    guidedRequestKey(uuid(), 'seed', 1),
    guidedRequestKey(uuid(), 'seed', uuid()),
  ];
  assert.equal(keys.length, 13);
  for (const key of keys) {
    assert.ok(!key.includes(':'), `colon leaked into guided request key: ${key}`);
    assert.match(key, strictInvestmentKey);
    assert.ok(key.length <= 128);
  }
});
