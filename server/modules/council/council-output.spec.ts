import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContribution } from './council.dialogue';

const segments = { basis: '第一段：虚构企业的现金。', context: '第二段：虚构行业。', allocation: '第三段：组合。', price: '第四段：价格。', sources: '第五段：来源。' };
const fixture = () => ({ response: { thesis: 'A supported fixture conclusion.', evidencePoints: ['Evidence'], risks: ['Risk'], nextChecks: ['Check'], details: segments }, evidenceIds: ['source-1'], claims: [{ id: 'claim-1', statement: 'Public claim', evidenceIds: ['source-1'] }] });
test('known details record retains all five segments, order and original input', () => {
  const raw = fixture(); const before = JSON.stringify(raw);
  const result = parseContribution(raw, new Set(['source-1']), { memberId: 'one', phase: 'opening' }, null);
  const details = result.response!.details!;
  let last = -1;
  for (const value of Object.values(segments)) { const at = details.indexOf(value); assert.ok(at > last); last = at; }
  assert.equal(JSON.stringify(raw), before);
});
test('details compatibility retains hard evidence, candidate and size checks', () => {
  assert.throws(() => parseContribution({ ...fixture(), evidenceIds: ['missing'] }, new Set(['source-1']), { memberId: 'one', phase: 'opening' }, null));
  assert.throws(() => parseContribution({ ...fixture(), quantity: 2 }, new Set(['source-1']), { memberId: 'one', phase: 'opening' }, null));
  assert.throws(() => parseContribution({ ...fixture(), response: { ...fixture().response, details: { nested: { text: 'unsafe shape' } } } }, new Set(['source-1']), { memberId: 'one', phase: 'opening' }, null), /response.details/u);
  assert.throws(() => parseContribution({ ...fixture(), response: { ...fixture().response, thesis: 'x'.repeat(6001) } }, new Set(['source-1']), { memberId: 'one', phase: 'opening' }, null), /response.thesis/u);
});
test('native flat reader fields retain the same bounded response contract',()=>{
  const raw={...fixture().response,evidenceIds:['source-1'],claims:fixture().claims};const before=JSON.stringify(raw);
  const parsed=parseContribution(raw,new Set(['source-1']),{memberId:'one',phase:'opening'},null);
  assert.equal(parsed.response?.thesis,raw.thesis);assert.ok(parsed.response?.details?.includes(segments.sources));assert.equal(JSON.stringify(raw),before);
  assert.throws(()=>parseContribution({...raw,evidenceIds:['not-real']},new Set(['source-1']),{memberId:'one',phase:'opening'},null));
  assert.throws(()=>parseContribution({...raw,risks:{}},new Set(['source-1']),{memberId:'one',phase:'opening'},null));
});
