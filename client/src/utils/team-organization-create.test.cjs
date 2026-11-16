const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

const f = fixture();
f.state.randomUUID = require('node:crypto').randomUUID;
const { nextTeamCreateIntent, TEAM_CREATE_KEY_PATTERN } = f.load('features/teams/team-create-intent.ts');

test('a pending creation reuses the exact original key so retries cannot create a second team', () => {
  const first = nextTeamCreateIntent({ name: '研究组' }, null, 'pending');
  const retry = nextTeamCreateIntent({ name: '研究组' }, first, 'pending');
  assert.equal(retry.key, first.key, 'retry after an unknown outcome must reuse the same request key');
  assert.equal(retry.digest, first.digest);
});

test('changing the form before any confirmation produces a fresh key for a fresh draft', () => {
  const first = nextTeamCreateIntent({ name: '研究组' }, null, 'pending');
  const changed = nextTeamCreateIntent({ name: '投研组' }, first, 'pending');
  assert.notEqual(changed.key, first.key);
  assert.notEqual(changed.digest, first.digest);
});

test('a confirmed creation clears the intent, so the next create is a brand new team', () => {
  const first = nextTeamCreateIntent({ name: '研究组' }, null, 'pending');
  const after = nextTeamCreateIntent({ name: '研究组' }, first, 'confirmed');
  assert.equal(after, null, 'confirmation must release the pending intent');
  const fresh = nextTeamCreateIntent({ name: '研究组' }, null, 'pending');
  assert.notEqual(fresh.key, first.key);
});

test('composite create keys stay inside the strict account-friendly alphabet', () => {
  const first = nextTeamCreateIntent({ name: '团队A' }, null, 'pending');
  assert.match(first.key, TEAM_CREATE_KEY_PATTERN, 'key must satisfy ^[a-zA-Z0-9_-]{8,128}$');
  assert.ok(first.key.length >= 8 && first.key.length <= 128);
});

test('a changed form while a request is still pending reuses the previous key only for the same digest', () => {
  const first = nextTeamCreateIntent({ templateId: 'classic', name: '经典' }, null, 'pending');
  const second = nextTeamCreateIntent({ templateId: 'classic', name: '经典' }, first, 'pending');
  const third = nextTeamCreateIntent({ templateId: 'classic', name: '经典二' }, first, 'pending');
  assert.equal(second.key, first.key);
  assert.notEqual(third.key, first.key);
});
