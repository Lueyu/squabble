const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

const f = fixture();
const { ownedSpecialtyIds, missingSpecialtyIds, matchStaffing } = f.load('features/teams/team-staffing.ts');

const agent = (id, templateId, options = {}) => ({
  id, name: id, specialty: 'fixture specialty', description: '', delivery: '', status: options.status ?? 'active',
  availability: options.availability ?? 'configured', currentVersionId: `${id}-v1`, avatar: 'technical',
  currentVersion: { id: `${id}-v1`, version: 1, agentId: id, createdAt: '', config: { schemaVersion: 1, templateId, instructions: '', executor: { executionMode: 'model', connectionId: 'model', model: 'fast' }, allowedToolIds: [] } },
});

const slot = (roleId, recommendedTemplateId, required = true) => ({ roleId, recommendedTemplateId, required });
const openIds = match => match.open.map(s => s.roleId).join(',');

test('five financials agents still leave eleven specialties missing', () => {
  const roster = ['a', 'b', 'c', 'd', 'e'].map(id => agent(id, 'financials'));
  const missing = missingSpecialtyIds(roster);
  assert.equal(missing.length, 11);
  assert.ok(missing.includes('bear'));
  assert.ok(missing.includes('portfolio'));
  assert.ok(!missing.includes('financials'));
  assert.equal(ownedSpecialtyIds(roster).size, 1);
});

test('missing bear is reported even when every other specialty is owned', () => {
  const roster = ['financials', 'valuation', 'risk', 'moderator', 'business', 'industry', 'growth', 'macro', 'events', 'quantitative', 'portfolio'].map((id, index) => agent(`a${index}`, id));
  assert.equal(missingSpecialtyIds(roster).join(','), 'bear');
});

test('a single financials agent cannot fill two independent financials seats', () => {
  const roster = [agent('only-financials', 'financials')];
  const match = matchStaffing([slot('role-a', 'financials'), slot('role-b', 'financials')], roster);
  assert.equal(match.assignments['role-a'], 'only-financials');
  assert.equal(match.assignments['role-b'], undefined);
  assert.equal(openIds(match), 'role-b');
  assert.equal(match.candidates['role-b'].length, 0, 'the consumed identity must not be re-offered');
});

test('archived and unavailable agents are never auto-assigned', () => {
  const roster = [
    agent('archived-fin', 'financials', { status: 'archived' }),
    agent('unavailable-fin', 'financials', { availability: 'unavailable' }),
  ];
  const match = matchStaffing([slot('role-a', 'financials')], roster);
  assert.equal(Object.keys(match.assignments).length, 0);
  assert.equal(openIds(match), 'role-a');
});

test('distinct specialties consume distinct identities in slot order', () => {
  const roster = [agent('fin', 'financials'), agent('bear-a', 'bear'), agent('bear-b', 'bear')];
  const match = matchStaffing([slot('lead', 'portfolio', false), slot('fin', 'financials'), slot('bear', 'bear')], roster);
  assert.equal(match.assignments.fin, 'fin');
  assert.equal(match.assignments.bear, 'bear-a');
  assert.equal(match.assignments.lead, undefined);
  assert.equal(openIds(match), 'lead');
  assert.equal(match.candidates.bear.map(a => a.id).join(','), 'bear-a,bear-b');
});

test('an empty roster never fabricates assignments or identities', () => {
  const match = matchStaffing([slot('a', 'financials'), slot('b', 'valuation')], []);
  assert.equal(Object.keys(match.assignments).length, 0);
  assert.equal(openIds(match), 'a,b');
});
