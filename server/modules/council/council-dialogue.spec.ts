import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discussionPrompt, parseContribution } from './council.dialogue';
import { agentAssignment, agentContribution } from './council.native';

const turn = { memberId: 'analyst', phase: 'opening' as const };
const response = { thesis: '现金流支持业务韧性，但估值仍需验证。',
  evidencePoints: ['经营现金流增长，需结合资本开支核对自由现金流。'],
  risks: ['需求下滑可能压低利润率。'], nextChecks: ['核对下一份财报的现金流和资本开支。'],
  details: '完整分析与推导依据。'.repeat(400) };

test('API and native members preserve the same structured public answer and full details', () => {
  const data = { response, evidenceIds: [] };
  const api = parseContribution(data, new Set(), turn, null);
  const native = agentContribution({ data, text: '' }, [], turn, null).contribution;
  assert.deepEqual(api.response, response);
  assert.deepEqual(native.response, response);
  assert.equal(api.content, native.content);
  for (const point of [response.thesis, ...response.evidencePoints, ...response.risks, ...response.nextChecks, response.details]) {
    assert.ok(api.content.includes(point), 'backward-compatible report content must retain every part');
  }
});

test('legacy substantive contributions are preserved without the previous 3000-character cut', () => {
  const content = '证据与解释。'.repeat(800);
  assert.equal(parseContribution({ content, evidenceIds: [] }, new Set(), turn, null).content, content);
  assert.equal(agentContribution({ data: { content, evidenceIds: [] }, text: '' }, [], turn, null).contribution.content, content);
});

test('moderator reports retain complete structured details for research and candidate reviews', () => {
  const candidate = { ticker: 'AAPL', side: 'buy' as const, quantity: 1, price: 100, reason: 'Fixture' };
  for (const order of [null, candidate]) {
    const result = parseContribution({ response, evidenceIds: [], decision: 'wait' }, new Set(),
      { memberId: 'manager', phase: 'summary' }, order);
    assert.equal(result.opinion?.summary.length, result.content.length);
    assert.ok(result.opinion?.summary.includes(response.details));
  }
});

test('a response with legacy content preserves both the original text and complete report evidence', () => {
  const content = 'Original additional explanation.';
  const result = parseContribution({ content, response, evidenceIds: [] }, new Set(),
    { memberId: 'manager', phase: 'summary' }, null);
  assert.equal(result.content, content);
  assert.ok(result.opinion?.summary.includes(content));
  assert.ok(result.opinion?.summary.includes(response.details));
});

test('structured output rejects malformed fields and excessive payloads instead of silently clipping', () => {
  for (const patch of [{ thesis: '' }, { risks: 'unknown' }, { evidencePoints: [42] }, { details: 'x'.repeat(30001) }]) {
    assert.throws(() => parseContribution({ response: { ...response, ...patch }, evidenceIds: [] }, new Set(), turn, null), /structured|response/i);
  }
});

test('both execution prompts ask for substantive readable answers with longer moderator guidance', () => {
  const member = { id: 'analyst', name: 'Analyst', role: 'researcher' as const, model: 'fast' as const, instructions: '' };
  const prompts = [discussionPrompt(turn, 'zh-CN', false), agentAssignment({ ticker: 'AAPL', language: 'zh-CN',
    member, turn, candidate: null, messages: [], evidence: [] })];
  for (const prompt of prompts) {
    assert.match(prompt, /300[–-]600/);
    assert.match(prompt, /500[–-]800/);
    assert.match(prompt, /evidencePoints/);
    assert.match(prompt, /nextChecks/);
    assert.match(prompt, /private chain-of-thought/);
    assert.doesNotMatch(prompt, /最多300|within 140 words|up to 6000 characters/);
  }
});
