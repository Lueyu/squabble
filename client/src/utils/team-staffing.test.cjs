const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

const f = fixture();
const { ownedSpecialtyIds, missingSpecialtyIds, matchStaffing, suggestTeamStaffing, applySuggestedTeamStaffing } = f.load('features/teams/team-staffing.ts');
const { TEAM_TEMPLATES } = f.load(require('node:path').resolve(__dirname, '../../../shared/team-templates.ts'));
const { instantiateTemplate } = f.load(require('node:path').resolve(__dirname, '../../../shared/team-template-instantiation.ts'));

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

function classicState() {
  let sequence = 0;
  return instantiateTemplate(TEAM_TEMPLATES[0], () => `seat-${++sequence}`);
}
const models = [{ id: 'model', available: true, fastModel: 'fixture-fast', slowModel: 'fixture-slow' }];

test('instantiated template seats receive matching saved friends without changing duties, grants or layout', () => {
  const state = classicState();
  const roster = ['business', 'financials', 'bear', 'portfolio'].map(id => agent(id, id));
  state.config.roles[0].sourceGrantIds = ['existing-source'];
  const suggestions = suggestTeamStaffing(state, roster);
  assert.equal(Object.keys(suggestions.assignments).length, 4);
  const next = applySuggestedTeamStaffing(state, suggestions.assignments, roster, models);
  assert.ok(next.config.roles.every(role => role.agentId && role.agentVersionId && role.participation === 'enabled'));
  assert.deepEqual(next.config.roles.map(role => role.responsibility), state.config.roles.map(role => role.responsibility));
  assert.deepEqual(next.config.roles.map(role => role.sourceGrantIds), state.config.roles.map(role => role.sourceGrantIds));
  assert.equal(next.layout, state.layout);
  assert.equal(next.display, state.display);
  assert.equal(state.config.roles[0].agentId, undefined);
});

test('suggestions preserve configured and legacy placeholder seats and do not reuse their friend', () => {
  const state = classicState();
  const roster = ['business', 'financials', 'bear', 'portfolio'].map(id => agent(id, id));
  state.config.roles[0] = { ...state.config.roles[0], agentId: 'business', agentVersionId: 'business-v1', participation: 'enabled', executor: { executionMode: 'model', connectionId: 'model', model: 'fixture-fast' } };
  state.config.roles[1].executor = { executionMode: 'model', connectionId: 'model', model: 'fixture-fast' };
  const suggestions = suggestTeamStaffing(state, roster);
  assert.equal(suggestions.assignments[state.config.roles[0].id], undefined);
  assert.equal(suggestions.assignments[state.config.roles[1].id], undefined);
  const next = applySuggestedTeamStaffing(state, { ...suggestions.assignments, [state.config.roles[0].id]: 'bear', [state.config.roles[1].id]: 'financials' }, roster, models);
  assert.equal(next.config.roles[0], state.config.roles[0]);
  assert.equal(next.config.roles[1], state.config.roles[1]);
});

test('customized duties and unavailable friends remain explicit choices instead of guessed assignments', () => {
  const state = classicState();
  const businessId = TEAM_TEMPLATES[0].staffing.find(slot => slot.recommendedTemplateId === 'business').roleId;
  const businessIndex = TEAM_TEMPLATES[0].config.roles.findIndex(role => role.id === businessId);
  state.config.roles[businessIndex].responsibility = 'My custom research scope';
  const roster = ['business', 'financials', 'bear', 'portfolio'].map(id => agent(id, id, { availability: 'unavailable' }));
  roster[0] = agent('business', 'business');
  const suggestions = suggestTeamStaffing(state, roster);
  assert.deepEqual(Object.keys(suggestions.assignments), []);
});
