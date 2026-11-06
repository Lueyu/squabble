import test from 'node:test';
import assert from 'node:assert/strict';
import { agentContribution } from './council.native';
import { researchPresentation } from '../experience/research-presentation';
import { readableResearchSections } from '../../../shared/research-reading';

const response = { thesis: 'Cash flow needs checking.', evidencePoints: ['The filing records lower cash.'], risks: ['Concentration'], nextChecks: ['Read the next filing.'], details: { Portfolio: 'Keep position sizes under review.' } };
test('prefaced fenced native protocol becomes a validated substantive report', () => {
  const raw = `Here is the research.\n\n\`\`\`json\n${JSON.stringify({response})}\n\`\`\``;
  const result = agentContribution({text:raw}, [], {memberId:'member',phase:'summary'}, null);
  assert.equal(result.contribution.response?.thesis, response.thesis);
  assert.match(result.contribution.opinion!.summary,/Keep position sizes/u);
  assert.doesNotMatch(result.contribution.opinion!.summary,/```|"response"/u);
});
test('known nested response envelopes are read locally without losing sections', () => {
  const result = researchPresentation({summary:`Result follows:\n\`\`\`json\n${JSON.stringify({response:{response}})}\n\`\`\``}, []);
  assert.match(result.content,/Cash flow needs checking/u);
  assert.match(result.content,/Concentration/u);
  assert.match(result.content,/Keep position sizes/u);
  assert.doesNotMatch(result.content,/```|evidencePoints|"response"/u);
});
test('native JSON-string response containers retain typed validation and all report sections', () => {
  for (const container of [JSON.stringify(response), JSON.stringify({ response }), `Result:\n\`\`\`json\n${JSON.stringify({ response })}\n\`\`\``]) {
    const result = agentContribution({ data: { response: container }, text: '' }, [], { memberId: 'member', phase: 'summary' }, null);
    assert.equal(result.contribution.response?.thesis, response.thesis);
    assert.match(result.contribution.opinion!.summary, /Keep position sizes/u);
    assert.doesNotMatch(result.contribution.opinion!.summary, /```|"response"/u);
  }
  assert.throws(() => agentContribution({ data: { response: JSON.stringify({ ...response, risks: 'malformed risks' }) }, text: '' },
    [], { memberId: 'member', phase: 'summary' }, null), /response.risks/u);
});
test('unknown protocol stays pending instead of becoming a completed prose report', () => {
  assert.throws(()=>agentContribution({text:'Output:\n```json\n{"unsupported":{"value":42}}\n```'},[],{memberId:'m',phase:'summary'},null), /substantive|content|structured|整理|protocol/iu);
  const result=researchPresentation({summary:'Output:\n```json\n{"unsupported":{"value":42}}\n```'},[]);
  assert.equal(result.content,'');
  assert.equal(result.readingState,'pending');
});
test('a structured transport containing fenced protocol in content is normalized before publication',()=>{
  const raw=`Research:\n\`\`\`json\n${JSON.stringify({response})}\n\`\`\``;
  const result=agentContribution({data:{content:raw},text:raw},[],{memberId:'m',phase:'summary'},null);
  assert.match(result.contribution.opinion!.summary,/Cash flow needs checking/u);
  assert.doesNotMatch(result.contribution.opinion!.summary,/```|"response"/u);
});
test('reading exposes public references while keeping raw evidence envelopes and credential URLs private',()=>{
  const result=researchPresentation({summary:'A sourced conclusion.',evidence:[{title:'Issuer filing',sourceUrl:'https://example.org/filing',content:'PRIVATE_EVIDENCE_PAYLOAD'},{title:'Credentials',sourceUrl:'https://user:secret@example.org/private'}]},[]);
  assert.match(result.content,/\[Issuer filing\]\(https:\/\/example.org\/filing\)/u);
  assert.doesNotMatch(result.content,/PRIVATE_EVIDENCE_PAYLOAD|user:secret/u);
});
test('section reading retains public evidence points and next checks while excluding private envelopes', () => {
  const sections = [{ id: 'summary', title: 'Conclusion', content: 'Keep researching.' },
    { id: 'evidencePoints', title: 'Supporting evidence', content: '["The filing records lower cash."]' },
    { id: 'nextEvidence', title: 'Next evidence', content: '["Read the next filing."]' },
    { id: 'evidence', title: 'Raw evidence', content: '[{"content":"PRIVATE_PAYLOAD"}]' }];
  const text = readableResearchSections(sections);
  assert.match(text, /The filing records lower cash/u);
  assert.match(text, /Read the next filing/u);
  assert.doesNotMatch(text, /PRIVATE_PAYLOAD|"content"/u);
});
