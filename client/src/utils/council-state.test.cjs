const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

const source = readFileSync(resolve(__dirname, 'council-state.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const exported = { exports: {} };
const templates = { exports: {} };
runInNewContext(ts.transpileModule(readFileSync(resolve(__dirname, '../../..', 'shared/council-templates.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: templates, exports: templates.exports });
runInNewContext(compiled, { module: exported, exports: exported.exports,
  require: (id) => { if (id === '@shared/council-templates') return templates.exports; throw new Error(`Unexpected import: ${id}`); } });
const { isCurrentCouncilReport, budgetPercent, validateCouncilSettings, validateBudget } = exported.exports;

test('a new note starts one research round only from a ready or completed room', () => {
  const shouldStart = exported.exports.shouldStartCouncilAfterMessage;
  assert.equal(shouldStart?.('completed', 'idle'), true);
  assert.equal(shouldStart?.('idle', 'idle'), true);
  assert.equal(shouldStart?.('running', 'running'), false);
  assert.equal(shouldStart?.('running', 'idle'), false);
  assert.equal(shouldStart?.('paused', 'paused'), false);
  assert.equal(shouldStart?.('failed', 'idle'), false);
  assert.equal(shouldStart?.('completed', 'paused'), false);
  assert.equal(shouldStart?.('idle', 'running'), false);
});

test('Enter sends a chat message while Shift+Enter and IME confirmation do not', () => {
  const shouldSend = exported.exports.shouldSendCouncilMessage;
  const enter = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 };
  assert.equal(shouldSend?.(enter), true);
  assert.equal(shouldSend?.({ ...enter, shiftKey: true }), false);
  assert.equal(shouldSend?.({ ...enter, isComposing: true }), false);
  assert.equal(shouldSend?.({ ...enter, keyCode: 229 }), false);
  assert.equal(shouldSend?.({ ...enter, key: 'a' }), false);
});

test('AI chat hides standalone internal evidence UUID lists but preserves user text and citations', () => {
  const display = exported.exports.councilMessageDisplayContent;
  const ids = '[12345678-abcd-1234-abcd-123456789012, abcdef12-1234-abcd-1234-abcdef123456]';
  const content = `Research summary.\n${ids}\nReview the cash flow.`;
  assert.equal(display?.({ role: 'researcher', content }), 'Research summary.\nReview the cash flow.');
  assert.equal(display?.({ role: 'manager', content: `  ${ids}  \nConclusion.` }), 'Conclusion.');
  assert.equal(display?.({ role: 'user', content }), content);
  assert.equal(display?.({ role: 'system', content }), content);
  assert.equal(display?.({ role: 'challenger', content: 'A source [E1]\n[E1, E2]\n[1234]\nInline ' + ids }),
    'A source [E1]\n[E1, E2]\n[1234]\nInline ' + ids);
});

test('a report becomes obsolete after new input or a newer report version', () => {
  const report = { id: 'r1', version: 1, revision: 2 };
  const session = { revision: 2, profileVersion: 3, reports: [report] };
  assert.equal(isCurrentCouncilReport(report, session, 3), true);
  assert.equal(isCurrentCouncilReport(report, { ...session, revision: 3 }, 3), false);
  assert.equal(isCurrentCouncilReport(report, session, 4), false);
  assert.equal(isCurrentCouncilReport(report, { ...session, reports: [report, { id: 'r2', version: 2, revision: 2 }] }, 3), false);
});

test('budget bars remain bounded and handle unavailable limits', () => {
  assert.equal(budgetPercent(50, 100), 50);
  assert.equal(budgetPercent(150, 100), 100);
  assert.equal(budgetPercent(-5, 100), 0);
  assert.equal(budgetPercent(5, 0), 0);
});

test('teams allow two to six distinct members with exactly one moderator and finite cadence limits', () => {
  const members = ['researcher', 'challenger', 'manager'].map(role => ({ id: role, role, name: role, instructions: '', model: 'fast' }));
  const cadence = { reviewEveryTradingDays: 5, maxOrdersPerWeek: 2, cooldownTradingDays: 3, maxWeeklyTurnoverPct: 10 };
  assert.equal(validateCouncilSettings({ enabled: true, members }, cadence), null);
  assert.equal(validateCouncilSettings({ enabled: true, members: [members[0], members[2]] }, cadence), null);
  assert.equal(validateCouncilSettings({ enabled: true, members: [...members, { ...members[0], id: 'growth' }, { ...members[0], id: 'news' }, { ...members[1], id: 'risk' }] }, cadence), null);
  assert.equal(validateCouncilSettings({ enabled: true, members: [members[0]] }, cadence), 'teamInvalid');
  assert.equal(validateCouncilSettings({ enabled: true, members: Array.from({ length: 7 }, (_, i) => ({ ...members[i === 6 ? 2 : 0], id: String(i) })) }, cadence), 'teamInvalid');
  assert.equal(validateCouncilSettings({ enabled: true, members: [members[0], members[1]] }, cadence), 'teamInvalid');
  assert.equal(validateCouncilSettings({ enabled: true, members: [members[2], { ...members[2], id: 'other-manager' }] }, cadence), 'teamInvalid');
  assert.equal(validateCouncilSettings({ enabled: true, members: [{ ...members[0], personality: 'x'.repeat(241) }, members[2]] }, cadence), 'teamInvalid');
  assert.equal(validateCouncilSettings({ enabled: true, members: [{ ...members[0], researchFocus: ['web'] }, members[2]], webResearch: false }, cadence), 'teamInvalid');
  assert.equal(validateCouncilSettings({ enabled: true, members: [{ ...members[0], researchFocus: ['web'] }, members[2]], webResearch: true }, cadence), null);
  assert.equal(validateCouncilSettings({ enabled: true, members: [members[0], members[0], members[2]] }, cadence), 'teamInvalid');
  assert.equal(validateCouncilSettings({ enabled: true, members }, { ...cadence, maxOrdersPerWeek: 1.5 }), 'cadenceInvalid');
  assert.equal(validateCouncilSettings({ enabled: false, members: [] }, cadence), null);
});

test('budget validation rejects impossible or nonfinite caps and accepts unknown prices', () => {
  const settings = { dailyTokenLimit: 60000, monthlyTokenLimit: 600000, perTaskTokenLimit: 24000, maxInputTokens: 6000, maxOutputTokens: 1000, maxCallsPerTask: 8, dailyCallLimit: 30, inputUsdPerMillion: null, outputUsdPerMillion: null };
  assert.equal(validateBudget(settings), null);
  assert.equal(validateBudget({ ...settings, maxOutputTokens: NaN }), 'invalid');
  assert.equal(validateBudget({ ...settings, inputUsdPerMillion: -1 }), 'priceInvalid');
  assert.equal(validateBudget({ ...settings, maxInputTokens: 30000 }), 'inconsistent');
});

test('native agent teams may use their own web tools while model members still require web permission', () => {
  const members = ['researcher', 'manager'].map(role => ({ id: role, role, name: role,
    instructions: '', model: 'fast', executionMode: 'local', agentId: 'native-codex', researchFocus: ['web'] }));
  assert.equal(validateCouncilSettings({ enabled: true, members, webResearch: false }), null);
  assert.equal(validateCouncilSettings({ enabled: true, members: [{ ...members[0], agentId: '' }, members[1]] }), 'teamInvalid');
  assert.equal(validateCouncilSettings({ enabled: true, members: [{ ...members[0], executionMode: 'model' }, members[1]], webResearch: false }), 'teamInvalid');
});

test('localized presets are valid and template clones never share mutable research focus', () => {
  const { createCouncilPreset, createCouncilMember, COUNCIL_TEAM_PRESETS } = templates.exports;
  for (const language of ['en', 'zh-CN']) {
    for (const preset of COUNCIL_TEAM_PRESETS) {
      const members = createCouncilPreset(preset.id, language);
      assert.equal(validateCouncilSettings({ enabled: true, members, webResearch: false }), null);
      assert.equal(members.filter(member => member.role === 'manager').length, 1);
    }
  }
  const first = createCouncilMember('value', 'en', 'value-a');
  const second = createCouncilMember('value', 'en', 'value-b');
  first.researchFocus.push('web');
  first.name = 'Edited';
  assert.equal(second.researchFocus.includes('web'), false);
  assert.equal(second.name, 'Morgan');
  assert.notEqual(first.id, second.id);
});
