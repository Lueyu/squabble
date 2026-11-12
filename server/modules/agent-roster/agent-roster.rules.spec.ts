import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('five honest editable templates preserve their scope ceiling and native connector identity', async () => {
  assert.ok(existsSync('server/modules/agent-roster/agent-roster.rules.ts'), 'persistent agent capability rules must exist');
  const { AGENT_TEMPLATES, prepareAgent, snapshotMember, assertCeiling } = await import('./agent-roster.rules');
  assert.deepEqual(AGENT_TEMPLATES.map(t => t.id), ['financials', 'valuation', 'bear', 'risk', 'moderator']);
  const agent = prepareAgent({ templateId: 'bear', description: '请核对周期高点和现金流', executor: { executionMode: 'local', localAgentId: 'native-codex' } });
  assert.match(agent.config.instructions, /请核对周期高点和现金流/);
  assert.deepEqual(agent.config.allowedSources, []);
  assert.ok(agent.config.allowedToolIds.includes('get_discussion_context'));
  assert.ok(agent.config.allowedToolIds.includes('get_news'));
  assert.deepEqual(prepareAgent({ executor: { executionMode: 'model', model: 'slow' }, allowedToolIds: [] }).config.allowedToolIds, []);
  assert.doesNotThrow(() => assertCeiling([], ['get_financials'], [], ['builtin:get_financials']));
  const member = snapshotMember({ id: 'stable-person', name: '反方', currentVersionId: 'version-1' }, { id: 'version-1', config: agent.config }, { agentId: 'stable-person', agentVersionId: 'version-1', memberId: 'seat-1' });
  assert.equal(member.rosterAgentId, 'stable-person');
  assert.equal(member.rosterAgentVersionId, 'version-1');
  assert.equal(member.agentId, 'native-codex');
  assert.equal(member.id, 'seat-1');
  const defaultSeat = snapshotMember({ id: '01234567-89ab-4def-8123-0123456789ab', name: 'Stable', currentVersionId: 'version-1' }, { id: 'version-1', config: agent.config }, { agentId: '01234567-89ab-4def-8123-0123456789ab', agentVersionId: 'version-1' });
  assert.ok(defaultSeat.id.length <= 32, 'the internal seat ID must fit retained Council member identity bounds');
  assert.equal(defaultSeat.rosterAgentId, '01234567-89ab-4def-8123-0123456789ab');
});

test('capability validation rejects credentials, unexpected configuration and forged unavailable source claims', async () => {
  assert.ok(existsSync('server/modules/agent-roster/agent-roster.rules.ts'), 'persistent agent capability rules must exist');
  const { parseCreate, assertCeiling } = await import('./agent-roster.rules');
  const base = { requestKey: 'test-create', executor: { executionMode: 'model', model: 'slow' } };
  assert.throws(() => parseCreate({ ...base, executor: { ...base.executor, apiKey: 'secret' } }));
  assert.throws(() => parseCreate({ ...base, preferences: { hiddenPrompt: 'secret' } }));
  assert.throws(() => parseCreate({ ...base, executor: { executionMode: 'local', localAgentId: 'native-codex', settings: { model: 'one\ntwo' } } }), 'native model configuration must reject control characters before persistence');
  assert.throws(() => assertCeiling([], [], [{ kind: 'document_version', id: 'source', revision: '1', availability: 'available' }], []));
  assert.throws(() => assertCeiling([], [], [], ['unapproved-tool']));
});
