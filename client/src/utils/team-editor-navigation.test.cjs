const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

test('explicit canvas wins over narrow default and survives query serialization', () => {
  const { teamEditorView, withTeamEditorView } = fixture().load('features/teams/team-editor-navigation.ts');
  assert.equal(teamEditorView(new URLSearchParams('panel=organization'), 390), 'list');
  assert.equal(teamEditorView(new URLSearchParams('panel=organization&view=unknown'), 390), 'list');
  const next = withTeamEditorView(new URLSearchParams('panel=organization'), 'canvas');
  assert.equal(teamEditorView(new URLSearchParams(next.toString()), 390), 'canvas');
  assert.equal(next.get('panel'), 'organization');
});

test('old relations links and their canonical organization URLs both open relationship actions', () => {
  const { opensTeamRelations } = fixture().load('features/teams/team-editor-navigation.ts');
  assert.equal(opensTeamRelations(new URLSearchParams('panel=relations&view=list')), true);
  assert.equal(opensTeamRelations(new URLSearchParams('panel=organization&relations=1')), true);
  assert.equal(opensTeamRelations(new URLSearchParams('panel=organization&view=list')), false);
  assert.equal(opensTeamRelations(new URLSearchParams('panel=versions&relations=1')), false);
});

test('repair shows the exact relation or all parallel reporting edges involved in a cycle', () => {
  const { teamIssueDestination } = fixture().load('features/teams/team-editor-navigation.ts');
  const relations = [
    { id: 'scope-1', kind: 'reports_to', fromRoleId: 'a', toRoleId: 'b' },
    { id: 'scope-2', kind: 'reports_to', fromRoleId: 'a', toRoleId: 'b' },
    { id: 'reversed', kind: 'reports_to', fromRoleId: 'b', toRoleId: 'a' },
    { id: 'collaboration', kind: 'reviews', fromRoleId: 'a', toRoleId: 'b' },
    { id: 'outside-cycle', kind: 'reports_to', fromRoleId: 'a', toRoleId: 'c' },
  ];
  const route = (code, objectIds) => JSON.parse(JSON.stringify(teamIssueDestination({ code, objectIds, message: '' }, relations)));
  assert.equal(route('ROLE_CONFIGURATION', ['a']), null);
  assert.equal(route('MISSING_DEPARTMENT', ['d']), null);
  assert.deepEqual(route('MISSING_SCOPE', ['scope-2']), { kind: 'edit', id: 'scope-2' });
  assert.deepEqual(route('REPORTING_CYCLE', ['a', 'b']), { kind: 'issues', ids: ['scope-1', 'scope-2', 'reversed'] });
});
