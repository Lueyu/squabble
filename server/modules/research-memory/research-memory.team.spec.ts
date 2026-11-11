import assert from 'node:assert/strict';
import { test } from 'node:test';
import { teamScopedMemoryVisible } from './research-memory.team';
import { commonTeamGrantIds } from '../../database/team-member-sources';
test('shared team recall intersects frozen recipients and cannot launder restricted lineage or move accounts', () => {
  const x = { kind: 'document_version' as const, id: 'X', revision: '1', availability: 'available' as const };
  const output = { kind: 'report_version' as const, id: 'R', revision: '2', availability: 'available' as const };
  const grantX = { id: 'grant-X', sourceKind: x.kind, sourceId: x.id, sourceRevision: x.revision };
  const grantR = { id: 'grant-R', sourceKind: output.kind, sourceId: output.id, sourceRevision: output.revision };
  const context = { teamId: 'A', accountId: 'account-A' };
  const source = { teamId: 'A', accountId: 'account-A' };
  assert.deepEqual([...commonTeamGrantIds([{ sourceGrantIds: ['grant-X'] }, { sourceGrantIds: [] }])], []);
  assert.equal(teamScopedMemoryVisible(source, context, output, [x], []), false);
  assert.equal(teamScopedMemoryVisible(source, context, output, [x], [grantX]), true);
  assert.equal(teamScopedMemoryVisible({ ...source, accountId: 'account-old' }, context, output, [], []), false);
  assert.equal(teamScopedMemoryVisible({ ...source, teamId: 'B' }, context, output, [], []), false);
  assert.equal(teamScopedMemoryVisible({ ...source, teamId: 'B', accountId: 'other' }, context, output, [x], [grantR]), true);
});
