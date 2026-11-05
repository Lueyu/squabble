const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
function load(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, Date, Intl, Set, Map, URLSearchParams, crypto: require('node:crypto').webcrypto, require: name => imports[name] });
  return exports;
}
test('strategy dates follow the selected business zone, independent of browser timezone', () => {
  const { zonedInput, resolveZonedInput, strategyPeriodDates } = load('utils/strategy-dates.ts');
  assert.equal(zonedInput('2026-11-05T01:00:00Z', 'America/New_York'), '2026-11-04T20:00');
  assert.equal(resolveZonedInput('2026-11-05T09:00', 'Asia/Shanghai').iso, '2026-11-05T01:00:00.000Z');
  const now = new Date('2026-03-08T12:00:00Z');
  assert.equal(strategyPeriodDates('day', 'America/New_York', now).endsAt, '2026-03-09T03:59:59.999Z');
  assert.equal(strategyPeriodDates('month', 'Asia/Shanghai', new Date('2026-01-31T18:00:00Z')).endsAt, '2026-02-28T15:59:59.999Z');
});
test('strategy date entry rejects DST gaps and requires a deliberate choice for the repeated hour', () => {
  const { resolveZonedInput } = load('utils/strategy-dates.ts');
  assert.equal(resolveZonedInput('2026-03-08T02:30', 'America/New_York').error, 'nonexistent');
  const repeated = resolveZonedInput('2026-11-01T01:30', 'America/New_York');
  assert.equal(repeated.error, 'ambiguous');
  assert.deepEqual(Array.from(repeated.candidates), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  assert.equal(resolveZonedInput('2026-11-01T01:30', 'America/New_York', repeated.candidates[1]).iso, repeated.candidates[1]);
  assert.equal(resolveZonedInput('2026-02-30T09:00', 'Asia/Shanghai').error, 'invalid');
  assert.equal(resolveZonedInput('2026-11-01T01:30', 'Invalid/Zone').error, 'zone');
});
test('first-use team creation saves a draft with configured native routes and never activates trading', async () => {
  const React = require('react'); const calls = []; let selected;
  const ui = ({ children }) => React.createElement('div', null, children);
  const templates = load('../../shared/council-templates.ts');
  const component = load('pages/Paper/StrategyTeamSetup.tsx', {
    'react/jsx-runtime': require('react/jsx-runtime'),
    react: { useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] },
    'react-router-dom': { Link: ui },
    'react-i18next': { useTranslation: () => ({ i18n: { language: 'en' } }) },
    '@/api/builder': { createBuilderProfile: async config => { calls.push(config); return { id: 'new-team', config, status: 'draft' }; } },
    '@shared/council-templates': templates,
    '@shared/strategy.interface': { DEFAULT_STRATEGY_AUTOMATION: { enabled: false, preOpenMinutes: 60, monitorSeconds: 60, eventReplanCooldownMinutes: 120, maxEventReplansPerDay: 1, notifyClosingSummary: false } },
    '@/utils/council-state': { DEFAULT_CADENCE: { reviewEveryTradingDays: 5, maxOrdersPerWeek: 2, cooldownTradingDays: 3, maxWeeklyTurnoverPct: 10 }, validateCouncilSettings: () => null },
    '@/pages/Council/useCouncilModels': { useCouncilModels: () => ({ loading: false, localAgents: [{ id: 'native-codex', available: true, connected: true }] }),
      assignLocalAgents: members => members.map(member => ({ ...member, executionMode: 'local', agentId: 'native-codex' })) },
    '@/pages/Council/CouncilTeamEditor': { default: ui },
    '@/components/ui/button': { Button: ui }, '@/components/ui/input': { Input: ui }, '@/components/ui/label': { Label: ui },
  });
  const tree = component.default({ onCreated: profile => { selected = profile; }, onCancel: () => {} });
  const find = node => {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.['data-action'] === 'create-team-draft') return node;
    return React.Children.toArray(node.props?.children).map(find).find(Boolean);
  };
  assert.equal(calls.length, 0, 'rendering the first-use form must not create or activate anything');
  await find(tree).props.onClick();
  assert.equal(calls.length, 1); assert.equal(selected.status, 'draft');
  assert.equal(calls[0].automation.enabled, false); assert.equal(calls[0].council.enabled, true);
  assert.equal(calls[0].council.members.length, 3);
  assert.ok(calls[0].council.members.every(member => member.agentId === 'native-codex'));
  assert.equal(calls[0].automation.fastReviewer.agentId, 'native-codex');
});
test('workbench blocks invalid wall times, resolves an ambiguous occurrence and saves the exact selected instants', async () => {
  const React = require('react'); const states = []; let cursor = 0; const saved = [];
  const ui = ({ children }) => React.createElement('div', null, children);
  const components = Object.fromEntries(['Button', 'Card', 'CardHeader', 'CardTitle', 'CardContent', 'Badge', 'Input', 'Label', 'Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription', 'DialogFooter'].map(key => [key, ui]));
  const imports = {
    'react/jsx-runtime': require('react/jsx-runtime'),
    react: { useState: initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } },
    'react-router-dom': { Link: ui, useSearchParams: () => [new URLSearchParams('sourceReportVersionId=v1&draft=1')] },
    'react-i18next': { useTranslation: () => ({ i18n: { language: 'en' } }) },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: async () => {}, setQueryData: () => {} }), useQuery: ({ queryKey }) => ({ data:
      queryKey[0] === 'builder' ? [{ id: 'profile', status: 'draft', version: 1, config: { name: 'Existing team' } }]
        : queryKey[0] === 'research-document' ? { version: { id: 'v1', title: 'Research' } } : { items: [], decisions: [] } }) },
    sonner: { toast: { success: () => {}, error: message => { throw new Error(message); } } },
    'lucide-react': {}, '@/api/builder': {}, '@/api/research-documents': {},
    '@/api/strategy-mandates': { createStrategyMandate: async value => { saved.push(value); return { ...value, id: 'draft', revision: 1 }; } },
    '@shared/strategy.interface': { STRATEGY_TRIGGER_KINDS: ['price_below'] },
    '@/utils/strategy-dates': load('utils/strategy-dates.ts'), './StrategyTeamSetup': { default: ui },
  };
  for (const part of ['button', 'card', 'badge', 'input', 'label', 'dialog']) imports['@/components/ui/' + part] = components;
  const module = load('pages/Paper/StrategyWorkbench.tsx', imports);
  const render = () => { cursor = 0; return module.StrategyWorkbench({ accountId: 'account' }); };
  const nodes = (tree, predicate) => {
    if (!tree || typeof tree !== 'object') return [];
    return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props?.children).flatMap(child => nodes(child, predicate))];
  };
  const byId = (tree, id) => nodes(tree, node => node.props?.id === id)[0];
  const fieldInput = (tree, id) => { const field = byId(tree, id); return byId(field.type(field.props), id); };
  const saveButton = tree => nodes(tree, node => React.Children.toArray(node.props?.children).includes('Save draft'))[0];
  byId(render(), 'mandate-timezone').props.onChange({ target: { value: 'America/New_York' } });
  fieldInput(render(), 'mandate-start').props.onChange({ target: { value: '2026-03-08T02:30' } });
  assert.equal(saveButton(render()).props.disabled, true);
  fieldInput(render(), 'mandate-start').props.onChange({ target: { value: '2026-11-01T01:30' } });
  assert.equal(saveButton(render()).props.disabled, true);
  const field = byId(render(), 'mandate-start');
  nodes(field.type(field.props), node => node.type === 'select')[0].props.onChange({ target: { value: '2026-11-01T06:30:00.000Z' } });
  fieldInput(render(), 'mandate-end').props.onChange({ target: { value: '2026-11-01T02:30' } });
  assert.equal(saveButton(render()).props.disabled, false);
  byId(render(), 'mandate-daily-plan-mode').props.onChange({ target: { value: 'bounded_ai' } });
  byId(render(), 'limit-minCashPct').props.onChange({ target: { value: '15' } });
  byId(render(), 'limit-maxGrossExposurePct').props.onChange({ target: { value: '80' } });
  byId(render(), 'limit-maxOrderPct').props.onChange({ target: { value: '5' } });
  const button = label => nodes(render(), node => React.Children.toArray(node.props?.children).includes(label))[0];
  button('Add basket').props.onClick(); assert.equal(saveButton(render()).props.disabled, true);
  const groupId = nodes(render(), node => typeof node.props?.id === 'string' && node.props.id.startsWith('group_') && node.props.id.endsWith('-label'))[0].props.id.replace(/-label$/, '');
  byId(render(), groupId + '-label').props.onChange({ target: { value: 'Technology' } });
  byId(render(), groupId + '-tickers').props.onChange({ target: { value: 'aapl, msft,' } });
  assert.equal(byId(render(), groupId + '-tickers').props.value, 'aapl, msft,', 'typing separators must not be erased');
  button('Add event window').props.onClick();
  const eventId = nodes(render(), node => typeof node.props?.id === 'string' && node.props.id.startsWith('event_') && node.props.id.endsWith('-label'))[0].props.id.replace(/-label$/, '');
  byId(render(), eventId + '-label').props.onChange({ target: { value: 'Earnings' } });
  byId(render(), eventId + '-tickers').props.onChange({ target: { value: 'aapl' } });
  fieldInput(render(), eventId + '-endsAt').props.onChange({ target: { value: '2026-03-08T02:30' } });
  assert.equal(saveButton(render()).props.disabled, true, 'an invalid event time must also block saving');
  fieldInput(render(), eventId + '-endsAt').props.onChange({ target: { value: '2026-11-01T02:45' } });
  assert.equal(saveButton(render()).props.disabled, false);
  await saveButton(render()).props.onClick();
  assert.equal(saved.length, 1); assert.equal(saved[0].startsAt, '2026-11-01T06:30:00.000Z');
  assert.equal(saved[0].endsAt, '2026-11-01T07:30:00.000Z'); assert.equal(saved[0].timezone, 'America/New_York');
  assert.equal(saved[0].profileId, 'profile');
  assert.equal(saved[0].dailyPlanMode, 'bounded_ai'); assert.equal(saved[0].limits.minCashPct, 15);
  assert.equal(saved[0].limits.maxGrossExposurePct, 80); assert.equal(saved[0].limits.maxOrderPct, 5);
  assert.deepEqual(Array.from(saved[0].exposureGroups[0].tickers), ['AAPL', 'MSFT']);
  assert.equal(saved[0].eventWindows[0].endsAt, '2026-11-01T07:45:00.000Z');
});

function workbenchHarness({ params = '', draft, profileVersion = 1, linked, api = {} }) {
  const React = require('react'); const states = []; let cursor = 0;
  const ui = ({ children }) => React.createElement('div', null, children);
  const components = Object.fromEntries(['Button', 'Card', 'CardHeader', 'CardTitle', 'CardContent', 'Badge', 'Input', 'Label', 'Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription', 'DialogFooter'].map(key => [key, ui]));
  const imports = {
    'react/jsx-runtime': require('react/jsx-runtime'),
    react: { useState: initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } },
    'react-router-dom': { Link: ui, useSearchParams: () => [new URLSearchParams(params)] },
    'react-i18next': { useTranslation: () => ({ i18n: { language: 'en' } }) },
    '@tanstack/react-query': { useQueryClient: () => ({ invalidateQueries: async () => {}, setQueryData: () => {} }), useQuery: ({ queryKey }) => ({ data:
      queryKey[0] === 'builder' ? [{ id: 'profile', status: 'draft', version: profileVersion, config: { name: 'Current team' } }]
        : queryKey[0] === 'strategy-mandate-version' ? linked
          : queryKey[0] === 'mandate-report-picker' ? { items: ['v1', 'v2'].map(id => ({ id, title: id, version: 1, createdAt: new Date().toISOString(), status: 'valid', sourceStatus: 'available' })) }
            : queryKey[0] === 'research-document' ? undefined : { items: draft ? [draft] : [], decisions: [] } }) },
    sonner: { toast: { success: () => {}, error: message => { throw new Error(message); } } },
    'lucide-react': {}, '@/api/builder': {}, '@/api/research-documents': {}, '@/api/strategy-mandates': api,
    '@shared/strategy.interface': { STRATEGY_TRIGGER_KINDS: ['price_below'] },
    '@/utils/strategy-dates': load('utils/strategy-dates.ts'), './StrategyTeamSetup': { default: ui },
  };
  for (const part of ['button', 'card', 'badge', 'input', 'label', 'dialog']) imports['@/components/ui/' + part] = components;
  const module = load('pages/Paper/StrategyWorkbench.tsx', imports);
  const render = () => { cursor = 0; return module.StrategyWorkbench({ accountId: 'active-account' }); };
  const nodes = (tree, predicate) => !tree || typeof tree !== 'object' ? []
    : [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props?.children).flatMap(child => nodes(child, predicate))];
  const button = text => nodes(render(), node => React.Children.toArray(node.props?.children).includes(text))[0];
  const byId = id => nodes(render(), node => node.props?.id === id)[0];
  return { render, nodes, button, byId };
}
function editableFixture() {
  const now = new Date(); return { id: 'draft', accountId: 'active-account', profileId: 'profile', profileVersion: 1, revision: 1, version: 1, status: 'draft',
    title: 'Two-source draft', objective: 'Evidence selection', timezone: 'Asia/Shanghai', period: 'custom', startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 86400000).toISOString(),
    sourceWarnings: [], references: [{ versionId: 'v1' }, { versionId: 'v2' }], limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20 },
    routePolicy: { councilPositionCapRatio: 0.8, councilIncrementPct: 3, rollingWindowMinutes: 60, candidateTtlSeconds: 1200 }, dailyPlanMode: 'fixed_rules',
    rules: [{ id: 'entry', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_below', value: 100 }, referencePrice: 100, minPrice: 95, maxPrice: 105, stopLossPrice: 90,
      maxPositionPct: 10, evidenceIds: ['v1'], rationale: 'Measured evidence', expiresAt: new Date(now.getTime() + 86400000).toISOString() }] };
}
test('linked strategy displays its exact historical account without selecting or activating it', () => {
  const linked = { ...editableFixture(), id: 'linked', accountId: 'historical-account', title: 'Exact historical strategy' };
  const harness = workbenchHarness({ params: 'strategyId=linked', linked });
  const cards = harness.nodes(harness.render(), node => node.props?.['data-strategy-version'] === 'linked');
  assert.equal(cards.length, 1); assert.equal(cards[0].props['data-read-only'], true);
  const renderedText = JSON.stringify(cards[0].props.children);
  assert.match(renderedText, /Exact historical strategy/); assert.match(renderedText, /historical-account/);
  assert.equal(harness.nodes(cards[0], node => typeof node.props?.onClick === 'function').length, 0, 'historical navigation provides no activation or account-switch controls');
});
test('rules can select their own pinned evidence and repair removed report dependencies', async () => {
  const draft = editableFixture(); const saves = [];
  const harness = workbenchHarness({ draft, api: { updateStrategyMandate: async (_id, config) => { saves.push(config); return { ...draft, ...config, revision: 2 }; } } });
  harness.button('Edit draft').props.onClick();
  harness.byId('entry-evidence-v2').props.onChange({ target: { checked: true } });
  await harness.button('Save draft').props.onClick();
  assert.deepEqual(Array.from(saves[0].rules[0].evidenceIds), ['v1', 'v2']);
  harness.byId('entry-evidence-v2').props.onChange({ target: { checked: false } });
  const source = harness.nodes(harness.render(), node => node.props?.['data-report-version'] === 'v1')[0];
  source.props.onChange({ target: { checked: false } });
  assert.equal(harness.button('Save draft').props.disabled, true, 'removing the last used source leaves a visible repairable gap');
  harness.byId('entry-evidence-v2').props.onChange({ target: { checked: true } });
  assert.equal(harness.button('Save draft').props.disabled, false);
  await harness.button('Save draft').props.onClick();
  assert.deepEqual(Array.from(saves[1].references.map(reference => reference.versionId)), ['v2']);
  assert.deepEqual(Array.from(saves[1].rules[0].evidenceIds), ['v2']);
});
test('a changed team is explicitly rebound with both draft and team versions before review', async () => {
  const draft = editableFixture(); const calls = [];
  const harness = workbenchHarness({ draft, profileVersion: 2, api: { rebindStrategyProfile: async (...args) => {
    calls.push(args); return { ...draft, profileVersion: 2, revision: 2 }; } } });
  await harness.button('Rebind team V2 & review').props.onClick();
  assert.deepEqual(calls, [['draft', 1, 2]]);
  assert.equal(harness.byId('mandate-profile').props.disabled, true);
});
