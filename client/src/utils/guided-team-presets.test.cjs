const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

const f = fixture();
const { GUIDED_RECOMMENDED_PRESET, GUIDED_TEAM_PRESETS, resolveGuidedPresetMembers, activeGuidedPreset } = f.load('features/teams/guided-team-presets.ts');

const agent = (id, templateId, availability = 'configured') => ({
  id, name: id, specialty: 'fixture specialty', status: 'active', availability, currentVersionId: `${id}-v1`,
  currentVersion: { config: { templateId, executor: { executionMode: 'model', connectionId: 'model', model: 'fast' }, allowedToolIds: [] } },
});

test('the recommended preset keeps the guided default trio in its original order', () => {
  assert.equal(GUIDED_RECOMMENDED_PRESET.templateIds.join(','), 'financials,bear,moderator');
  assert.equal(GUIDED_TEAM_PRESETS[0].id, 'recommended');
  assert.equal(GUIDED_TEAM_PRESETS.map(preset => preset.id).join(','), 'recommended,valuation,defensive,full');
});

test('resolution takes the first ready agent per template and skips missing specialties', () => {
  const roster = [agent('a', 'financials'), agent('b', 'financials'), agent('c', 'moderator'), agent('d', 'bear')];
  assert.equal(resolveGuidedPresetMembers(GUIDED_RECOMMENDED_PRESET, roster).map(a => a.id).join(','), 'a,d,c');
  assert.equal(resolveGuidedPresetMembers(GUIDED_TEAM_PRESETS[1], roster).map(a => a.id).join(','), 'a,c');
  assert.equal(resolveGuidedPresetMembers(GUIDED_TEAM_PRESETS[3], roster).map(a => a.id).join(','), 'a,d,c');
  assert.equal(resolveGuidedPresetMembers(GUIDED_RECOMMENDED_PRESET, []).length, 0);
});

test('the active preset is derived from the selection regardless of order', () => {
  const roster = [agent('fin', 'financials'), agent('val', 'valuation'), agent('bear', 'bear'), agent('mod', 'moderator')];
  assert.equal(activeGuidedPreset(null, roster), 'recommended');
  assert.equal(activeGuidedPreset(['fin', 'bear', 'mod'], roster), 'recommended');
  assert.equal(activeGuidedPreset(['mod', 'fin', 'bear'], roster), 'recommended');
  assert.equal(activeGuidedPreset(['fin', 'val', 'mod'], roster), 'valuation');
  assert.equal(activeGuidedPreset(['fin', 'val', 'bear', 'mod'], roster), 'full');
  assert.equal(activeGuidedPreset(['mod', 'val', 'fin', 'bear'], roster), 'full');
  assert.equal(activeGuidedPreset(['fin'], roster), 'custom');
  assert.equal(activeGuidedPreset(['fin', 'bear'], roster), 'custom');
  assert.equal(activeGuidedPreset(['fin', 'unknown-agent'], roster), 'custom');
});

test('an empty or unmatched selection never highlights a preset that resolves to no agent', () => {
  const moderatorOnly = [agent('mod', 'moderator')];
  assert.equal(activeGuidedPreset(['mod'], moderatorOnly), 'recommended');
  assert.equal(activeGuidedPreset([], []), 'custom');
  assert.equal(activeGuidedPreset([], moderatorOnly), 'custom');
});
