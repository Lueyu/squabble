const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const ts = require('typescript');
let language = 'en';
let listing;
let liveThesis = {};
let memoryById = {};
const requests = [];
const noop = () => {};
const mutation = { mutate: noop, reset: noop, isPending: false };
const queries = new Map();
const cache = new Map();
let renderPortals = false;
let stateHarness;
function load(relative) {
  const filename = path.isAbsolute(relative) ? relative : path.resolve(__dirname, '..', relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const requireModule = id => {
    if (id === 'react') return { ...React, useState: initial => stateHarness ? stateHarness.useState(initial) : React.useState(initial) };
    if (id === '@radix-ui/react-dialog' && renderPortals) return { ...require(id), Portal: ({ children }) => children };
    if (id === 'react-i18next') return { useTranslation: () => ({ i18n: { language, resolvedLanguage: language }, t: key => key }) };
    if (id === '@/hooks/use-research-memory') return {
      useResearchMemory: () => ({ data: listing }), useResearchMemoryPreferences: () => ({ data: { autoArchive: true, recallEnabled: true } }),
      useResearchMemoryActions: () => Object.fromEntries(['preferences', 'updateMemory', 'deleteMemory', 'updateThesis', 'deleteThesis'].map(k => [k, mutation])),
      useResearchThesisVersions: () => ({}), useResearchMemoryById: () => memoryById, useResearchThesis: () => liveThesis,
    };
    if (id === '@tanstack/react-query') return { useQuery: options => queries.get(options.queryKey[1]) ?? {},
      useMutation: () => mutation, useQueryClient: () => ({ invalidateQueries: noop }) };
    if (id === './http' && filename.endsWith('research-memory.ts')) return { __esModule: true, default: Object.fromEntries(
      ['get', 'post', 'patch', 'put', 'delete'].map(method => [method, async (...args) => { requests.push({ method, args }); return { data: { ok: true } }; }])) };
    if (id.startsWith('@/') || id.startsWith('@shared/') || id.startsWith('.')) {
      const target = id.startsWith('@/') ? path.resolve(__dirname, '..', id.slice(2))
        : id.startsWith('@shared/') ? path.resolve(__dirname, '../../../shared', id.slice(8)) : path.resolve(path.dirname(filename), id);
      const resolved = [target, `${target}.tsx`, `${target}.ts`].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
      if (resolved) return load(resolved);
    }
    return require(id);
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, require: requireModule, URL, Date, setTimeout, clearTimeout });
  return module.exports;
}
const source = { sessionId: 'session', reportId: 'report', reportVersion: 1, reportRevision: 1, reportCreatedAt: '2026-08-20T00:00:00Z', url: '/council?session=session' };
const thesis = { id: 'old-thesis', memoryId: 'outside-history-cap', ticker: 'TEST', market: 'US', topic: 'general', status: 'accepted', version: 3,
  claim: 'Independent long-term claim', supportingEvidence: [{ evidenceId: 'e1' }], opposingEvidence: ['Counterevidence'], assumptions: ['Demand holds'], indicators: [],
  invalidationConditions: ['Margin falls below 10%'], horizon: { startAt: '2026-08-20T00:00:00Z', reviewAt: '2027-01-01T00:00:00Z' },
  boundaryOrigin: 'proposed', evidenceRelations: [{ evidenceId: 'e2', role: 'refute' }], provenance: { origin: 'agent' },
  sourceStatus: 'available', source, citations: [], flags: ['provenance_unknown'], freshness: 'unknown', excluded: false, expiresAt: null,
  createdAt: '2026-08-20T00:00:00Z', updatedAt: '2026-08-20T00:00:00Z' };
const render = (Component, props) => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Component, props)));
// Keep the actual component and event handlers; only the hook host and network are controlled.
function interactive(Component) {
  const states = []; let cursor;
  return props => {
    stateHarness = { useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; } };
    cursor = 0;
    try { return Component(props); } finally { stateHarness = undefined; }
  };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const element = (tree, predicate) => { const result = nodes(tree).find(predicate); assert.ok(result, 'expected a matching rendered control'); return result; };

test('dossier leads with active claims and visible boundaries before folded history in both languages', () => {
  const Panel = load('pages/Council/CouncilMemoryPanel.tsx').CouncilMemoryPanel;
  listing = { theses: [thesis], memories: [{ id: 'recent', ticker: 'TEST', topic: 'general', summary: 'Recent historical report',
    sourceStatus: 'available', source, flags: [], citations: [], excluded: false }] };
  for (const locale of ['en', 'zh-CN']) {
    language = locale;
    const html = render(Panel, { ticker: 'TEST', language: locale });
    assert.ok(html.indexOf(thesis.claim) < html.indexOf('Recent historical report'), 'active thesis must precede report history');
    assert.ok(html.includes(thesis.invalidationConditions[0]));
    assert.ok(html.includes(thesis.assumptions[0]));
    assert.ok(html.includes(locale === 'en' ? 'Author: Agent' : '作者：Agent'));
  }
  language = 'en';
});

test('missing legacy inventory is unknown only when the automated context opts in', () => {
  const Inventory = load('pages/Council/CouncilMemoryInventory.tsx').default;
  assert.equal(render(Inventory, {}), '');
  const html = render(Inventory, { applicable: true });
  assert.match(html, /unknown/i);
  assert.doesNotMatch(html, /Submitted 0/);
});

test('edit payload preserves optional structures and expiry while excluding server provenance', async () => {
  const { editableThesisContent, thesisEditRequest, formatMemoryDate } = load('pages/Council/memory-presentation.ts');
  const rich = { ...thesis, expiresAt: '2027-05-01T00:00:00Z', monitorConditions: [{ conditionIndex: 0, metric: 'price' }],
    supersedes: { thesisId: 'old', version: 2, reason: 'Reviewed replacement' } };
  const content = editableThesisContent(rich);
  assert.equal(content.provenance, undefined);
  assert.equal(content.id, undefined);
  assert.deepEqual(content.horizon, rich.horizon);
  assert.deepEqual(content.monitorConditions, rich.monitorConditions);
  assert.deepEqual(content.supersedes, rich.supersedes);
  const input = thesisEditRequest(rich, { ...content, claim: 'Updated view' }, 'New source reviewed', rich.expiresAt);
  const api = load('api/research-memory.ts');
  requests.length = 0;
  await api.updateResearchThesis('old/thesis', input);
  assert.equal(requests[0].args[0], '/api/research-memory/theses/old%2Fthesis');
  assert.equal(requests[0].args[1].expectedVersion, 3);
  assert.equal(requests[0].args[1].changeReason, 'New source reviewed');
  assert.equal(requests[0].args[1].content.evidenceRelations[0].role, 'refute');
  assert.equal(requests[0].args[1].expiresAt, rich.expiresAt);
  assert.equal(formatMemoryDate('2026-08-20', 'en'), '2026-08-20');
});

test('archive and evidence APIs retain server symbol scope and monitor version guards', async () => {
  const api = load('api/research-memory.ts'); requests.length = 0;
  await api.fetchResearchArchiveJobs({ ticker: '700.HK', market: 'HK', cursor: 'next', limit: 20 });
  await api.importResearchReports({ ticker: '700.HK', market: 'HK', cursor: 'older' });
  assert.equal(requests[0].args[1].params.market, 'HK');
  assert.equal(requests[1].args[1].ticker, '700.HK');
  assert.equal(typeof api.fetchResearchEvidence, 'function');
  assert.equal(typeof api.writeResearchMonitor, 'function');
  await api.fetchResearchEvidence('memory/old');
  await api.writeResearchMonitor('thesis', { expectedVersion: 3, ruleId: 'rule', ruleVersion: 4, enabled: false, condition: { threshold: 10 } });
  assert.equal(requests[2].args[0], '/api/research-memory/memories/memory%2Fold/evidence');
  assert.equal(requests[3].args[1].ruleVersion, 4);
});

test('source facts retain calendar publication, unknowns and safe URLs in actual evidence rendering', () => {
  const { EvidenceGraph } = load('pages/Council/MemoryEvidenceDetails.tsx');
  const { memoryCopy } = load('pages/Council/memory-copy.ts');
  const metadata = { provider: 'Fictional filing', verification: 'unknown', observationBasis: 'legacy_fetched_at',
    publishedAt: '2026-08-20', publicationPrecision: 'day', observedAt: null, sourceUrl: 'javascript:alert(1)',
    sourceRevision: 'filing-2', supersedesSourceRevision: 'filing-1', revisionReason: 'Restatement', facts: [{
      entity: 'Fictional Co', metric: 'revenue', value: 123456, unit: 'million', currency: 'USD', basis: null,
      actuality: 'actual', periodStart: '2026-01-01', periodEnd: '2026-06-30', instant: null }] };
  const graph = { evidence: [{ id: 'record', evidenceId: 'e1', reportId: 'report', reportVersion: 2, reportRevision: 1,
    ingestedAt: '2026-11-04T01:00:00Z', metadata: { sources: [metadata] } }],
    comparisonEvidence: [{ id: 'competing-record', evidenceId: 'e1', reportId: 'another-report', reportVersion: 1, reportRevision: 1,
      title: 'Competing filing', source: { ...source, reportId: 'another-report', url: '/council?reportId=another-report' },
      ingestedAt: '2026-11-04T02:00:00Z', metadata: { sources: [{ ...metadata, sourceUrl: 'https://example.test/competing', publishedAt: '2026-08-21',
        facts: [{ ...metadata.facts[0], value: 222222 }] }] } }],
    relations: [{ thesisId: thesis.id, version: thesis.version, evidenceRecordId: 'record', role: 'refute' }],
    comparisons: [{ left: 'record', right: 'competing-record', leftSourceIndex: 0, rightSourceIndex: 0, leftFactIndex: 0, rightFactIndex: 0, kind: 'conflict' }] };
  for (const locale of ['en', 'zh-CN']) {
    const html = render(EvidenceGraph, { graph, citations: [{ evidenceId: 'e1', title: 'Filing' }], thesisId: thesis.id, version: thesis.version, copy: memoryCopy[locale], locale });
    for (const value of ['2026-08-20', '2026-08-21', '123456', '222222', 'USD', 'Restatement', 'Competing filing',
      'href="https://example.test/competing"', 'href="/council?reportId=another-report"',
      memoryCopy[locale].dayPrecision, memoryCopy[locale].legacyObservation, memoryCopy[locale].comparisonHint]) assert.ok(html.includes(value), value);
    assert.doesNotMatch(html, /href="javascript:/);
    assert.ok(html.includes(memoryCopy[locale].unknown));
  }
});

test('rendered monitor distinguishes current clear from latched breach and permits only latest logical rule controls', () => {
  const { MemoryMonitors } = load('pages/Council/MemoryMonitors.tsx');
  const { memoryCopy } = load('pages/Council/memory-copy.ts');
  const condition = { conditionIndex: 0, metric: 'price', unit: 'USD', threshold: 10, operator: 'lt', validFrom: thesis.createdAt,
    validUntil: '2027-01-01T00:00:00Z', evidenceIds: ['e1'], rationale: 'Fictional price condition' };
  const base = { rootId: 'logical', thesisId: thesis.id, thesisVersion: thesis.version, ticker: 'TEST', market: 'US', origin: 'user', condition,
    lastObservation: { state: 'clear', value: 12, observedAt: thesis.createdAt, observationKey: 'repeated' }, lastValidObservation: null };
  queries.set('monitors', { data: { scope: 'enabled-paper-strategies', executionEligible: false, breached: true, configuration: 'unconfigured',
    unsupportedConditions: [0], replacement: { thesisId: 'previous', version: 1, reason: 'Updated source' }, replacementState: 'stale',
    rules: [{ ...base, id: 'latest', version: 2, enabled: false }, { ...base, id: 'old-rule', version: 1, enabled: false }],
    events: [1, 2].map(i => ({ ...base.lastObservation, id: `event-${i}`, ruleId: 'latest', ruleVersion: 2, thesisVersion: 3, createdAt: thesis.createdAt })) } });
  const html = render(MemoryMonitors, { thesis, copy: memoryCopy.en, locale: 'en' });
  assert.ok(html.includes(memoryCopy.en.clear)); assert.ok(html.includes(memoryCopy.en.latched));
  assert.ok(html.includes(memoryCopy.en.replacementStale)); assert.ok(html.includes(memoryCopy.en.noObservation));
  assert.equal((html.match(/>Enable<\/button>/g) ?? []).length, 1);
  assert.ok(html.includes('event-1')); assert.ok(html.includes('event-2'));
  const candidateHtml = render(MemoryMonitors, { thesis: { ...thesis, status: 'candidate' }, copy: memoryCopy.en, locale: 'en' });
  assert.doesNotMatch(candidateHtml, />Enable<\/button>/);
  assert.doesNotMatch(candidateHtml, />Configure condition<\/button>/);
  queries.delete('monitors');
});

test('new monitor drafts retain opening conditions and cannot silently rebase after a live thesis change', () => {
  const { MemoryMonitors } = load('pages/Council/MemoryMonitors.tsx');
  const { memoryCopy } = load('pages/Council/memory-copy.ts');
  const copy = memoryCopy.en, saved = [], parent = interactive(MemoryMonitors);
  const initial = { ...thesis, invalidationConditions: ['Price below 90'], citations: [{ evidenceId: 'e1', title: 'Filing' }] };
  const props = { thesis: initial, copy, locale: 'en' };
  queries.set('monitors', { data: { rules: [], events: [], unsupportedConditions: [], replacementState: 'none' }, refetch: noop });
  mutation.mutate = input => saved.push(input);
  try {
    element(parent(props), node => node.props?.children === copy.addRule).props.onClick();
    let editorElement = element(parent(props), node => node.type?.name === 'MonitorEditor');
    const editor = interactive(editorElement.type);
    const change = (predicate, value) => element(editor(editorElement.props), predicate).props.onChange({ target: { value } });
    change(node => node.props?.type === 'number', '90');
    change(node => node.props?.placeholder && node.props.value === '', '2026-11-01T00:00:00Z');
    change(node => node.props?.placeholder && node.props.value === '', '2027-11-01T00:00:00Z');
    change(node => node.type?.name === 'Textarea', 'Keep this useful draft');
    element(editor(editorElement.props), node => node.type?.name === 'Checkbox').props.onCheckedChange(true);
    const readyForm = editor(editorElement.props);
    assert.ok(nodes(readyForm).some(node => node.props?.children === copy.monitorDateInput));
    readyForm.props.onSubmit({ preventDefault: noop });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].expectedVersion, 3);
    assert.equal(saved[0].condition.threshold, 90);
    assert.equal(saved[0].condition.conditionIndex, 0);
    saved.length = 0;
    const edited = { ...props, thesis: { ...initial, version: 4, invalidationConditions: ['Price below 80'] } };
    const changedTree = parent(edited);
    editorElement = element(changedTree, node => node.type?.name === 'MonitorEditor');
    const changedForm = editor(editorElement.props);
    assert.ok(nodes(changedTree).some(node => node.props?.role === 'alert'), 'live version change is explained');
    assert.equal(element(changedForm, node => node.props?.type === 'number').props.value, 90);
    assert.equal(element(changedForm, node => node.type?.name === 'Textarea').props.value, 'Keep this useful draft');
    assert.ok(nodes(changedForm).some(node => node.type === 'option' && node.props.children === 'Price below 90'));
    assert.ok(!nodes(changedForm).some(node => node.type === 'option' && node.props.children === 'Price below 80'));
    assert.equal(element(changedForm, node => node.props?.type === 'submit').props.disabled, true);
    changedForm.props.onSubmit({ preventDefault: noop });
    assert.equal(saved.length, 0, 'forced submit must not bypass the disabled control');
    editorElement.props.onSave({ expectedVersion: 4, condition: { threshold: 90 } });
    assert.equal(saved.length, 0, 'parent request guard also rejects stale editor callbacks');
    element(changedTree, node => node.props?.children === copy.restartMonitorDraft).props.onClick();
    element(parent(edited), node => node.props?.children === copy.addRule).props.onClick();
    const fresh = element(parent(edited), node => node.type?.name === 'MonitorEditor');
    assert.equal(fresh.props.thesis.version, 4);
    assert.equal(fresh.props.thesis.invalidationConditions[0], 'Price below 80');
  } finally { mutation.mutate = noop; queries.delete('monitors'); }
});

test('monitor drafts block a replaced logical rule and unavailable source without losing draft context', () => {
  const { MemoryMonitors } = load('pages/Council/MemoryMonitors.tsx');
  const { memoryCopy } = load('pages/Council/memory-copy.ts');
  const copy = memoryCopy.en, saved = [];
  const rule = { id: 'rule-1', rootId: 'root', version: 1, thesisVersion: 3, condition: { threshold: 90 }, enabled: true };
  const view = { rules: [rule], events: [], unsupportedConditions: [], replacementState: 'none' };
  for (const change of ['rule', 'source']) {
    const parent = interactive(MemoryMonitors), props = { thesis, copy, locale: 'en' };
    queries.set('monitors', { data: view, refetch: noop }); mutation.mutate = input => saved.push(input);
    try {
      element(parent(props), node => node.props?.children === copy.editRule).props.onClick();
      assert.equal(element(parent(props), node => node.props?.children === copy.disableRule).props.disabled, true,
        'another mutation must not silently close an open draft');
      const changedProps = change === 'source' ? { ...props, thesis: { ...thesis, sourceStatus: 'source-deleted', source: null } } : props;
      if (change === 'rule') queries.set('monitors', { data: { ...view, rules: [...view.rules, { ...rule, id: 'rule-2', version: 2 }] }, refetch: noop });
      const changed = parent(changedProps);
      const editor = element(changed, node => node.type?.name === 'MonitorEditor');
      assert.equal(editor.props.blocked, true);
      assert.equal(editor.props.rule.id, 'rule-1');
      editor.props.onSave({ expectedVersion: 3, condition: { threshold: 90 }, ruleId: 'rule-1', ruleVersion: 1 });
      assert.equal(saved.length, 0);
    } finally { mutation.mutate = noop; queries.delete('monitors'); }
  }
});

test('archive failures describe manual action and do not offer resurrection of deleted reports', () => {
  const { MemoryOperations } = load('pages/Council/MemoryOperations.tsx');
  const { memoryCopy } = load('pages/Council/memory-copy.ts');
  queries.set('archive-jobs', { data: { counts: { queued: 0, running: 1, failed: 2, succeeded: 1 }, nextCursor: 'older', jobs: [
    { id: 'disabled', sessionId: 'source-session', reportId: 'older-report', ticker: 'TEST', reportVersion: 1, state: 'failed', error: 'MEMORY_AUTO_ARCHIVE_DISABLED', updatedAt: thesis.createdAt },
    { id: 'deleted', ticker: 'TEST', reportVersion: 2, state: 'failed', error: 'MEMORY_DELETED', updatedAt: thesis.createdAt },
  ] } });
  const html = render(MemoryOperations, { ticker: 'TEST', market: 'US', copy: memoryCopy.en, locale: 'en' });
  assert.ok(html.includes(memoryCopy.en.autoDisabled)); assert.ok(html.includes(memoryCopy.en.manualArchive));
  assert.ok(html.includes(memoryCopy.en.archiveGone)); assert.doesNotMatch(html, /MEMORY_AUTO_ARCHIVE_DISABLED/);
  assert.ok(html.includes(memoryCopy.en.loadMore));
  assert.match(html, /href="\/council\?sessionId=source-session&amp;reportId=older-report#report-older-report-v1"/);
  queries.delete('archive-jobs');
});

test('live editor keeps the old draft on CAS conflict and uses full memory citation choices outside history cap', () => {
  const { MemoryEditorSession } = load('pages/Council/MemoryEditorSession.tsx');
  const { memoryCopy } = load('pages/Council/memory-copy.ts');
  liveThesis = { data: { ...thesis, claim: 'A remote edit', version: 4 } };
  memoryById = { data: { sourceStatus: 'available', citations: [{ evidenceId: 'e3', title: 'Additional citation outside history cap' }] } };
  const props = { snapshot: thesis, mode: 'edit', copy: memoryCopy.en, busy: false, onCancel: noop, onReload: noop, onSave: noop };
  const html = render(MemoryEditorSession, props);
  assert.ok(html.includes(thesis.claim)); assert.doesNotMatch(html, /A remote edit/);
  assert.ok(html.includes('Additional citation outside history cap'));
  assert.ok(html.includes(memoryCopy.en.draftConflict)); assert.ok(html.includes(memoryCopy.en.reloadLatest));
  assert.match(html, /type="submit"[^>]*disabled/);
  assert.ok(html.includes('2027-01-01T00:00:00Z'));
  liveThesis = { data: thesis, error: { isAxiosError: true, message: 'Network offline' } };
  const offline = render(MemoryEditorSession, props);
  assert.ok(offline.includes(thesis.claim), 'transient refresh failure must retain the draft');
  assert.match(offline, /type="submit"[^>]*disabled/);
  liveThesis = { data: { ...thesis, sourceStatus: 'source-deleted', source: null } };
  const gone = render(MemoryEditorSession, props);
  assert.ok(gone.includes(memoryCopy.en.sourceDeleted)); assert.ok(!gone.includes(thesis.claim)); assert.doesNotMatch(gone, /<form/);
  liveThesis = { data: { ...thesis, sourceStatus: 'not-yet-known', source: null } };
  assert.ok(render(MemoryEditorSession, props).includes(memoryCopy.en.sourcePending));
  liveThesis = {}; memoryById = {};
});

test('memory strategy and context errors provide bilingual actions without raw codes or API key advice', () => {
  const { memoryReason } = load('utils/memory-reason.ts');
  for (const locale of ['en', 'zh-CN']) for (const code of ['MEMORY_ARCHIVE_PENDING', 'MEMORY_ARCHIVE_FAILED', 'MEMORY_ARCHIVE_DISABLED',
    'MEMORY_LEGACY_PLAN_REVIEW_REQUIRED', 'MEMORY_SUBMISSION_UNKNOWN', 'MEMORY_CONDITION_BREACHED', 'MEMORY_MONITOR_UNKNOWN', 'MEMORY_CONTEXT_LIMIT']) {
    const text = memoryReason(code, locale);
    assert.ok(text && !text.includes('MEMORY_')); assert.doesNotMatch(text, /API key|API 密钥/);
  }
});

test('the dossier sheet close button accepts a localized accessible name', () => {
  renderPortals = true;
  const { Sheet, SheetContent, SheetTitle, SheetDescription } = load('components/ui/sheet.tsx');
  const html = renderToStaticMarkup(React.createElement(Sheet, { open: true }, React.createElement(SheetContent, { closeLabel: '关闭' },
    React.createElement(SheetTitle, null, '研究记忆'), React.createElement(SheetDescription, null, '论点与边界'))));
  assert.match(html, /class="sr-only">关闭<\/span>/);
  assert.doesNotMatch(html, /class="sr-only">Close<\/span>/);
  renderPortals = false;
});
