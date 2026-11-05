import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newCheckpoint, parseContribution } from './council.dialogue';
import type { CouncilMember } from '../../../shared/council.interface';
import { ResearchToolsService } from '../research-tools/research-tools.service';
import { agentContribution } from './council.native';

const members: CouncilMember[] = [
  { id: 'one', name: 'One', role: 'researcher', model: 'fast', instructions: '' },
  { id: 'two', name: 'Two', role: 'manager', model: 'fast', instructions: '' },
];

test('simple research starts with every actual member independently before any discussion', () => {
  const checkpoint = Reflect.apply(newCheckpoint, undefined, [members, { independent: true }]);
  assert.deepEqual(checkpoint.turns.slice(0, 2).map((turn: { phase: string }) => turn.phase), ['opening', 'opening']);
  assert.equal(checkpoint.simple.stage, 'independent');
  assert.equal(checkpoint.simple.supplementRounds, 0);
});

test('one actual source can research without manufacturing a second member', () => {
  const checkpoint = Reflect.apply(newCheckpoint, undefined, [[members[0]], { independent: true }]);
  assert.deepEqual(checkpoint.turns, [{ memberId: 'one', phase: 'opening' }]);
});

test('public claim challenges and explicit retained or changed views survive parsing', () => {
  const contribution = parseContribution({ content: 'The margin claim is not established.', evidenceIds: ['filing'],
    respondsToClaims: ['claim-1'], stanceChange: { status: 'changed', reason: 'The filing excludes a one-off gain.' },
    evidenceCheckStatus: 'unverified', claims: [{ id: 'claim-2', statement: 'Recurring margin is unknown.', evidenceIds: ['filing'] }] },
  new Set(['filing']), { memberId: 'one', phase: 'response' }, null);
  assert.deepEqual(Reflect.get(contribution, 'respondsToClaims'), ['claim-1']);
  assert.equal(Reflect.get(contribution, 'stanceChange').status, 'changed');
  assert.equal(Reflect.get(contribution, 'claims')[0].id, 'claim-2');
});

test('native discussion context uses frozen common facts and hides current-cycle private tool activity', async () => {
  const rows = [{ id: 'progress', role: 'system', memberName: 'system', content: 'PRIVATE_TOOL_RESULT', revision: 1, createdAt: new Date() },
    { id: 'user', role: 'user', memberName: 'You', content: 'Shared question', revision: 1, createdAt: new Date() }];
  const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) }) };
  const common = { id: 'common', title: 'Common facts', content: 'SHARED_FACTS', sourceName: 'Shared snapshot', relevanceScore: 1 };
  const session = { evidenceSnapshot: [common, { ...common, id: 'private', content: 'PRIVATE_TOOL_RESULT' }],
    checkpoint: { simple: { stage: 'independent', commonEvidence: [common] } } };
  const result = await Reflect.apply(Reflect.get(ResearchToolsService.prototype, 'context'), { db }, ['owner', { sessionId: 'session', revision: 1 }, session, 8]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_TOOL_RESULT'), false);
  assert.equal(JSON.stringify(result).includes('SHARED_FACTS'), true);
});

test('independent tool snapshots include only that member own acquisitions alongside shared facts', async () => {
  const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) };
  const fact = { title: 'Source', sourceName: 'Provider', relevanceScore: 1 };
  const session = { evidenceSnapshot: [], checkpoint: { simple: { stage: 'independent', commonEvidence: [], privateEvidence: {
    one: [{ ...fact, id: 'one-evidence', content: 'OWN_PRIVATE_FACT' }], two: [{ ...fact, id: 'two-evidence', content: 'OTHER_PRIVATE_FACT' }],
  } } } };
  const result = await Reflect.apply(Reflect.get(ResearchToolsService.prototype, 'context'), { db }, ['owner', { memberId: 'one' }, session, 8]);
  assert.equal(JSON.stringify(result).includes('OWN_PRIVATE_FACT'), true);
  assert.equal(JSON.stringify(result).includes('OTHER_PRIVATE_FACT'), false);
});

test('late steering waits until the common initial research boundary has been released', async () => {
  const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [
    { id: 'new', role: 'user', memberName: 'You', content: 'LATE_STEERING', revision: 1, createdAt: new Date() },
    { id: 'initial', role: 'user', memberName: 'You', content: 'COMMON_QUESTION', revision: 1, createdAt: new Date() },
  ] }) }) }) }) };
  const session = { evidenceSnapshot: [], checkpoint: { simple: { stage: 'independent', commonEvidence: [], commonMessageIds: ['initial'] } } };
  const result = await Reflect.apply(Reflect.get(ResearchToolsService.prototype, 'context'), { db }, ['owner', {}, session, 8]);
  assert.equal(JSON.stringify(result).includes('COMMON_QUESTION'), true);
  assert.equal(JSON.stringify(result).includes('LATE_STEERING'), false);
});

test('native public claims keep valid source aliases when the server assigns immutable evidence IDs', () => {
  const parsed = agentContribution({ text: '', data: { content: 'A public source supports this claim.', evidenceIds: ['filing'],
    sources: [{ id: 'filing', title: 'Issuer filing', url: 'https://issuer.example/report', content: 'Source excerpt' }],
    claims: [{ id: 'margin', statement: 'Margin remains uncertain.', evidenceIds: ['filing'] }],
  } }, [], { memberId: 'one', phase: 'opening' }, null);
  assert.deepEqual(parsed.contribution.claims?.[0].evidenceIds, [parsed.sources[0].id]);
});
