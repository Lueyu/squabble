const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./simple-test-loader.cjs');

test('sign-out clears only team recovery drafts and team creation input', () => {
  const { clearTeamDraftStorage } = fixture().load('features/teams/team-draft-storage.ts');
  const values = new Map([
    ['squabble.team-draft.team-a', 'private role instructions'],
    ['squabble.team-draft.team-b', 'another private draft'],
    ['squabble.team-create', 'private creation input'],
    ['squabble.team-guided-create.owner-a.draft', 'private guided fields'],
    ['squabble.team-guided-create.owner-b.progress', 'private creation receipt'],
    ['squabble.team-guided-create.owner-a.ended.receipt', 'private ended receipt'],
    ['squabble.team-draft-preference', 'preserved preference'],
    ['squabble.team-create-help', 'preserved help state'],
    ['squabble.team-guided-create-help', 'preserved guided help'],
    ['squabble.interview-composer.other', 'unrelated workspace draft'],
    ['navigation-visits', 'unrelated navigation state'],
  ]);
  const storage = { get length() { return values.size; }, key(index) { return [...values.keys()][index] ?? null; }, removeItem(key) { values.delete(key); } };
  clearTeamDraftStorage(storage);
  assert.deepEqual([...values.keys()], ['squabble.team-draft-preference', 'squabble.team-create-help', 'squabble.team-guided-create-help', 'squabble.interview-composer.other', 'navigation-visits']);
  const layout = fs.readFileSync(path.resolve(__dirname, '../components/Layout.tsx'), 'utf8');
  assert.match(layout, /clearTeamDraftStorage\(window\.sessionStorage\)/, 'the actual sign-out handler invokes the scoped cleanup');
});
