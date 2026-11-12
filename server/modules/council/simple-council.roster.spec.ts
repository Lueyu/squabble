import test from 'node:test';
import assert from 'node:assert/strict';
import { SimpleCouncilService } from './simple-council.service';
import { CouncilService } from './council.service';
import { normalizeCouncil } from '../paper-trading/agent-builder.rules';
import { packDiscussionContext } from './council.context';
import { boundedResult } from '../research-tools/research-tools.output';

test('explicit persistent agents on the same model stay separate and freeze the requested versions', async () => {
  const selections = [{ agentId: 'person-a', agentVersionId: 'v1' }, { agentId: 'person-b', agentVersionId: 'v2' }];
  const service = Object.assign(Object.create(SimpleCouncilService.prototype), {
    roster: { resolveMembers: async (owner: string, input: typeof selections) => {
      assert.equal(owner, 'owner'); assert.deepEqual(input, selections);
      return input.map((item, index) => ({ id: item.agentId, name: item.agentId, instructions: 'specialty', model: 'fast', connectionId: 'same-model', role: index ? 'manager' : 'researcher', rosterAgentId: item.agentId, rosterAgentVersionId: item.agentVersionId }));
    } },
  }) as SimpleCouncilService;
  const result = await service.resolveMembers('owner', selections);
  assert.equal(result.members.length, 2);
  assert.equal(result.members[0].rosterAgentVersionId, 'v1');
  assert.equal(result.members[1].rosterAgentVersionId, 'v2');
  assert.equal(result.executors[0].modelVerified, false);
});

test('an explicitly selected unavailable or foreign agent fails instead of falling back to global connections', async () => {
  const service = Object.assign(Object.create(SimpleCouncilService.prototype), { roster: { resolveMembers: async () => { throw new Error('AGENT_NOT_FOUND'); } } }) as SimpleCouncilService;
  await assert.rejects(service.resolveMembers('owner', [{ agentId: 'foreign', agentVersionId: 'v1' }]), /AGENT_NOT_FOUND/);
});

test('explicit and template moderators keep their manager seat when selected first', async () => {
  for (const explicit of [false, true]) {
    const selections = [{ agentId: 'moderator', agentVersionId: 'v1', ...(explicit ? { role: 'manager' as const } : {}) },
      { agentId: 'challenger', agentVersionId: 'v2', role: 'challenger' as const }];
    const service = Object.assign(Object.create(SimpleCouncilService.prototype), { roster: { resolveMembers: async () =>
      [{ id: 'first', name: 'Moderator', role: 'manager', model: 'fast', instructions: '' }, { id: 'last', name: 'Critic', role: 'challenger', model: 'fast', instructions: '' }] } }) as SimpleCouncilService;
    assert.deepEqual((await service.resolveMembers('owner', selections)).members.map(member => member.role), ['manager', 'challenger']);
  }
});

test('multiple selected moderators fail instead of silently replacing one role', async () => {
  const service = Object.assign(Object.create(SimpleCouncilService.prototype), { roster: { resolveMembers: async () =>
    ['a', 'b'].map(id => ({ id, name: id, role: 'manager', model: 'fast', instructions: '' })) } }) as SimpleCouncilService;
  await assert.rejects(service.resolveMembers('owner', [{ agentId: 'a', agentVersionId: 'v1' }, { agentId: 'b', agentVersionId: 'v2' }]), /AGENT_MULTIPLE_MANAGERS/u);
});

test('trusted saved Council snapshots preserve persistent identities and full roster instructions', () => {
  const members = [0, 1].map(index => ({ id: `friend-${index}`, name: 'A'.repeat(80), instructions: 'specialty '.repeat(600),
    role: index ? 'manager' as const : 'researcher' as const, model: 'fast' as const,
    rosterAgentId: `11111111-1111-4111-8111-11111111111${index}`, rosterAgentVersionId: `22222222-2222-4222-8222-22222222222${index}` }));
  const service = Object.create(CouncilService.prototype);
  assert.deepEqual(service.members({ council: { enabled: true, members } }), members);
});

test('legacy public member configuration cannot manufacture roster authority', () => {
  const person = { id: 'member', name: 'Fixture', role: 'manager' as const, instructions: '', model: 'fast' as const,
    rosterAgentId: '11111111-1111-4111-8111-111111111111', rosterAgentVersionId: '22222222-2222-4222-8222-222222222222' };
  assert.equal(normalizeCouncil({ enabled: true, members: [person] }).members[0].rosterAgentId, undefined);
});

test('pinned friend personality reaches the API context in full instead of being shortened as optional prose', () => {
  const instructions = 'Original responsibility. '.repeat(100) + ' FINAL_PERSONALITY_SENTINEL';
  const member = { id: 'friend', name: 'Friend', role: 'researcher' as const, instructions, model: 'fast' as const,
    rosterAgentId: '11111111-1111-4111-8111-111111111111', rosterAgentVersionId: '22222222-2222-4222-8222-222222222222' };
  const packed = packDiscussionContext({ ticker: 'FIXTURE', candidate: null, config: { customPrompt: '', council: { enabled: true, members: [member] } } as never,
    member, turn: { memberId: member.id, phase: 'opening' }, evidence: [], userMessages: ['Question'], currentDiscussion: [], previousDiscussion: [], systemPrompt: 'Research' });
  assert.equal(packed.member.instructions, instructions);
});

test('scoped friend memory tool envelopes preserve whole notes and provenance', () => {
  const content = 'Explicit user boundary. '.repeat(200) + ' FINAL_NOTE_SENTINEL';
  const result = boundedResult({ status: 'succeeded', data: { format: 'scoped-agent-memory/v1', items: [{ id: 'note', content,
    scope: { kind: 'personal' }, sourceRefs: [], sharedFrom: null }], omissions: [] }, sources: [], asOf: new Date().toISOString(), truncated: false });
  assert.equal((result.data as {items:Array<{content:string}>}).items[0].content, content);
});
