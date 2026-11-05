const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../..');
function harness(file, options = {}) {
  const queries = [];
  const states = [], refs = [], effects = [], dependencies = [];
  const navigations = [];
  let cursor = 0, refCursor = 0, effectCursor = 0;
  const fallback = name => new Proxy({ __esModule: true, default: name.split('/').at(-1) }, {
    get: (target, key) => key in target ? target[key] : String(key),
  });
  const jsx = (type, props, key) => typeof type === 'function' ? type(props) : ({ type, props: props || {}, key });
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useMemo: fn => fn(), useRef(initial) { const i = refCursor++; return refs[i] ?? (refs[i] = { current: initial }); },
    useEffect(fn, deps) { const i = effectCursor++;
      if (!dependencies[i] || deps.some((v, j) => v !== dependencies[i][j])) effects.push(fn);
      dependencies[i] = deps; },
  };
  const cache = {};
  function load(relative) {
    if (cache[relative]) return cache[relative];
    const exports = {}; cache[relative] = exports;
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, { exports, Date, URL, crypto: require('node:crypto'), document: { getElementById() {} },
      window: { setInterval() { return 1; }, clearInterval() {} }, require(name) {
        if (name === 'react') return react;
        if (name === '@tanstack/react-query') return {
          useQuery(query) { queries.push(query); return { data: options.data, isSuccess: Boolean(options.data), isPending: !options.data }; },
          useMutation(config) { return { isPending: false, reset() {}, async mutate(value) { const result = await config.mutationFn(value); config.onSuccess?.(result); return result; } }; },
        };
        if (name === '@/api/council') return options.council ?? {};
        if (name === '@/api/research-documents') return {};

        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (name === 'react-router-dom') return { Link: 'Link', useNavigate: () => route => navigations.push(route) };
        if (name === 'react-i18next') return { useTranslation: () => ({ t: (key, options = {}) => `${key}${options.count == null ? '' : `:${options.count}`}`, i18n: { language: 'en' } }) };
        if (name === '@/utils/research-events') return load('client/src/utils/research-events.ts');
        if (name === './CouncilResearchTimeline') return load('client/src/pages/Council/CouncilResearchTimeline.tsx');
        if (name === './CouncilResearchProgress') return load('client/src/pages/Council/CouncilResearchProgress.tsx');
        if (name === './thread-copy') return load('client/src/pages/Council/thread-copy.ts');
        return fallback(name);
      } }, { filename: relative });
    return exports;
  }
  return { load, queries, navigations, render(props) { cursor = 0; refCursor = 0; effectCursor = 0; return load(file).default(props); },
    runEffects() { for (const effect of effects.splice(0)) effect(); } };
}
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []; }
function text(tree) { return Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null ? '' : String(tree); }
const event = (sequence, changes = {}) => ({ sequence, id: `e${sequence}`, taskId: 'task', sessionId: 'room', revision: 2,
  memberId: 'morgan', memberName: 'Morgan', turn: 0, kind: 'tool', toolName: 'research_quote',
  status: 'running', at: '2026-11-03T00:00:00Z', summary: `Public step ${sequence}`, ...changes });
const session = (events, changes = {}) => ({ id: 'room', revision: 2, status: 'running', members: [], reports: [],
  messages: [{ id: 'legacy', memberName: 'Morgan', phase: 'progress', content: 'Legacy acquisition' }], researchEvents: events, ...changes });
const progress = () => {
  const view = harness('client/src/pages/Council/CouncilResearchTimeline.tsx');
  return { render: ({ session }) => view.load('client/src/utils/research-events.ts').researchTimeline(session).tasks
    .map(task => view.render({ task })) };
};

test('structured turn research is collapsed and retains public tools and waiting state', () => {
  const tree = progress().render({ session: session([event(1, { kind: 'task', status: 'queued' }), event(2, { kind: 'capability', status: 'succeeded', summary: 'Snapshot mode' })]) });
  assert.ok(!text(tree).includes('Legacy acquisition'));
  assert.ok(text(tree).includes('council.progress.taskStates.queued'));
  assert.ok(text(tree).includes('Snapshot mode'));
  assert.ok(nodes(tree).some(node => node.type === 'details' && !node.props.open));
  assert.ok(nodes(tree).some(node => node.type === 'summary' && text(node).includes('council.progress.taskStates.queued')));
});

test('terminal task cards have no spinners and preserve tool failures and safe source links', () => {
  const tree = progress().render({ session: session([event(1, { kind: 'task' }), event(2, { status: 'failed',
    summary: 'Source unavailable', durationMs: 2300, sources: [
      { title: 'Unsafe', url: 'javascript:alert(1)', fetchedAt: '2026-11-03' },
      { title: 'Quote source', url: 'https://example.com/quote', fetchedAt: '2026-11-03' },
    ] }), event(3, { kind: 'task', status: 'failed' })]) });
  assert.ok(!nodes(tree).some(node => node.props.className?.includes('animate-spin')));
  assert.ok(text(tree).includes('Source unavailable'));
  assert.ok(text(tree).includes('council.progress.taskStates.failed'));
  assert.ok(text(tree).includes('council.progress.duration'));
  assert.ok(nodes(tree).some(node => node.type === 'a' && node.props.href === 'https://example.com/quote'));
  assert.ok(!nodes(tree).some(node => node.type === 'a' && node.props.href?.startsWith('javascript:')));
});

test('public summaries are timestamped observations without spinners, elapsed time or fabricated terminal labels', () => {
  for (const status of ['running', 'succeeded']) {
    const tree = progress().render({ session: session([event(1, { kind: 'task', status }),
      event(2, { kind: 'summary', summary: 'Research began', durationMs: 5000 })]) });
    const row = nodes(tree).find(node => node.type === 'li' && text(node).includes('Research began'));
    assert.ok(row);
    assert.ok(!nodes(row).some(node => node.props.className?.includes('animate-spin')));
    assert.ok(!text(row).includes('council.progress.taskStates.'));
    assert.ok(!text(row).includes('council.progress.duration'));
    assert.ok(nodes(row).some(node => node.type === 'time'));
  }
});

test('built-in research tools have translated names while unknown native tools retain their names', () => {
  const names = ['get_quotes', 'get_financials', 'get_valuation', 'get_news', 'get_research_report',
    'get_discussion_context', 'search_research_web'];
  const tree = progress().render({ session: session([...names, 'custom_native_tool'].map((toolName, index) =>
    event(index, { toolName, status: 'succeeded' }))) });
  for (const name of names) assert.ok(text(tree).includes(`council.progress.toolNames.${name}`));
  assert.ok(text(tree).includes('custom_native_tool'));
  for (const locale of ['en', 'zh-CN']) {
    const translations = JSON.parse(fs.readFileSync(path.join(root, `client/src/i18n/council.${locale}.json`), 'utf8'));
    for (const name of names) assert.ok(translations.progress.toolNames[name] && translations.progress.toolNames[name] !== name);
  }
});

test('all retained activities remain available inside collapsed per-turn research, including interrupted history', () => {
  const tree = progress().render({ session: session([...Array.from({ length: 10 }, (_, i) => event(i, { status: 'succeeded' })),
    event(1, { taskId: 'old', revision: 1 })], { researchEventsTruncated: true }) });
  const disclosures = nodes(tree).filter(node => node.type === 'details');
  assert.equal(disclosures.length, 2);
  assert.ok(disclosures.every(node => !node.props.open));
  for (let i = 0; i < 10; i++) assert.ok(text(tree).includes(`Public step ${i}`));
  assert.ok(text(tree).includes('council.progress.taskStates.interrupted'));
});

test('legacy history still renders when structured events are absent', () => {
  const tree = harness('client/src/pages/Council/CouncilResearchProgress.tsx').render({ message: session(undefined).messages[0] });
  assert.ok(text(tree).includes('Legacy acquisition'));
  assert.ok(nodes(tree).some(node => node.type === 'details' && !node.props.open));
});

test('a new revision retains uncorrelated legacy progress and removes only identified event backing rows', () => {
  const current = { id: 'current', revision: 2, memberName: 'Morgan', phase: 'progress', content: 'Current data gathering', createdAt: event(1).at };
  const previous = { ...current, id: 'previous', revision: 1, researchEventId: 'e1', content: 'Old duplicated acquisition' };
  const view = harness('client/src/pages/Council/CouncilResearchProgress.tsx');
  const conversation = view.load('client/src/utils/research-events.ts').researchConversation;
  const room = session([event(1, { revision: 1 })], { messages: [previous, current] });
  let entries = conversation(room).entries;
  assert.ok(entries.some(entry => entry.legacyActivity?.content === 'Current data gathering'));
  assert.ok(!entries.some(entry => entry.legacyActivity?.content === 'Old duplicated acquisition'));
  room.researchEvents.push(event(2, { kind: 'task' }));
  entries = conversation(room).entries;
  assert.ok(entries.some(entry => entry.legacyActivity?.content === 'Current data gathering'));
  current.researchEventId = 'e2';
  assert.ok(!conversation(room).entries.some(entry => entry.legacyActivity?.id === 'current'));
});

test('new task-local events scroll only when already following the newest activity', () => {
  const view = harness('client/src/pages/Council/CouncilConversation.tsx');
  const props = { session: session([event(1)], { messages: [] }), profileChanged: false, actions: { send: {} } };
  let tree = view.render(props);
  const viewport = { scrollTop: 0, scrollHeight: 800, clientHeight: 200 };
  nodes(tree).find(node => node.props.role === 'log').props.ref.current = viewport;
  view.runEffects();
  assert.equal(viewport.scrollTop, 800);
  viewport.scrollHeight = 1000;
  props.session = session([event(1), event(2)], { messages: [] });
  tree = view.render(props); view.runEffects();
  assert.equal(viewport.scrollTop, 1000);
  viewport.scrollTop = 100;
  nodes(tree).find(node => node.props.role === 'log').props.onScroll();
  props.session = session([event(1), event(2), event(3)], { messages: [] });
  view.render(props); view.runEffects();
  assert.equal(viewport.scrollTop, 100);
  assert.ok(text(view.render(props)).includes('council.latestMessages'));
});

test('near-limit continuation reviews a summary before forking the latest substantive message', async () => {
  const view = harness('client/src/pages/Council/CouncilConversation.tsx');
  const messages = Array.from({ length: 25 }, (_, index) => ({ id: `user-${index}`, role: 'user', memberName: 'You',
    content: `Question ${index}`, revision: 2, createdAt: '2026-11-05T00:00:00Z' }));
  const room = session([], { messages: [...messages, { id: 'progress', role: 'system', phase: 'progress', content: 'Progress',
    revision: 2, createdAt: '2026-11-05T00:00:01Z' }] });
  const requests = [];
  const props = { session: room, profileChanged: false, actions: { send: {}, fork: {
    isPending: false, mutateAsync: async request => { requests.push(request); return { id: 'new-branch' }; },
  } } };
  const tree = view.render(props);
  const action = nodes(tree).find(node => node.type === 'Button' && text(node).includes('Fork from here'));
  assert.ok(action);
  action.props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(requests, [], 'opening review never creates a branch or starts a model call');
  const dialog = nodes(view.render(props)).find(node => node.type === 'CouncilContinuationDialog');
  assert.equal(dialog.props.messageId, 'user-24');
  await dialog.props.onFork({ messageId: 'user-24', summary: 'Reviewed open questions' });
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ id: 'room', messageId: 'user-24', summary: 'Reviewed open questions' }]);
  assert.equal(room.messages.length, 26, 'creating a branch never removes parent history');
});

test('report picker preserves exact mixed versions and filters saved dates without substituting latest', () => {
  const items = [
    { id: 'daily-v1', title: 'Portfolio daily', version: 1, ticker: null, createdAt: '2026-11-05T00:00:00Z', status: 'valid', sourceStatus: 'available' },
    { id: 'stock-v3', title: 'AAPL deep research', version: 3, ticker: 'AAPL', createdAt: '2026-11-04T00:00:00Z', status: 'valid', sourceStatus: 'available' },
    { id: 'revoked', title: 'Historical claim', version: 2, createdAt: '2026-11-03T00:00:00Z', status: 'revoked', sourceStatus: 'available' },
  ];
  const view = harness('client/src/pages/Council/CouncilReportPicker.tsx', { data: { items, total: 3 } });
  let selected = [{ versionId: 'daily-v1', sectionId: 'holdings' }];
  const props = () => ({ value: selected, onChange: refs => { selected = refs; }, historical: false });
  let tree = view.render(props());
  const check = nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === 'AAPL deep research v3');
  check.props.onChange();
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), [{ versionId: 'daily-v1', sectionId: 'holdings' }, { versionId: 'stock-v3' }]);
  assert.equal(nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === 'Historical claim v2').props.disabled, true);
  nodes(tree).find(node => node.type === 'Input' && node.props.type === 'date').props.onChange({ target: { value: '2026-11-01' } });
  tree = view.render(props());
  assert.equal(view.queries.at(-1).queryKey[2].from, '2026-11-01');
  assert.equal(view.queries.at(-1).queryKey[2].history, true);
  assert.ok(nodes(tree).some(node => node.type === 'Link' && node.props.to === '/analysis/reports/stock-v3'));
});

test('continuation requires an editable reviewed summary and sends the selected source report', async () => {
  const view = harness('client/src/pages/Council/CouncilContinuationDialog.tsx');
  const requests = [];
  const props = { session: session([], { title: 'Review', ticker: 'AAPL', messages: [{ id: 'm1', role: 'manager', memberName: 'Manager', content: 'Original response', revision: 2 }],
    reports: [{ id: 'r1', revision: 2, summary: 'Initial summary', dissent: ['Unresolved risk'], nextReviewCondition: 'Verify filing' }] }),
    messageId: 'm1', reportId: 'r1', onClose() {}, onFork: async request => { requests.push(request); return { id: 'branch' }; } };
  let tree = view.render(props);
  assert.equal(requests.length, 0);
  const summary = nodes(tree).find(node => node.type === 'Textarea');
  assert.match(summary.props.value, /Unresolved risk/u);
  summary.props.onChange({ target: { value: 'User-reviewed hypothesis; verify filing first' } });
  tree = view.render(props);
  await nodes(tree).find(node => node.type === 'Button').props.onClick();
  assert.equal(requests[0].summary, 'User-reviewed hypothesis; verify filing first');
  assert.equal(requests[0].reportId, 'r1');
  assert.equal(requests[0].messageId, 'm1');
  assert.deepEqual(view.navigations, ['/council?session=branch']);
  assert.equal(props.session.messages[0].content, 'Original response');
});

test('section revision calls AI only after explicit click and opens the editable diff draft', async () => {
  const calls = [];
  const view = harness('client/src/pages/Council/CouncilRevisionDialog.tsx', {
    data: { version: { title: 'Fixed report', version: 3, sections: [{ id: 'risk', title: 'Risks', content: 'Original risk' }] } },
    council: { reviseCouncilReport: async (...args) => { calls.push(args); return { id: 'draft', parentVersionId: 'v3' }; } },
  });
  const props = { sessionId: 'room', reportId: 'r1', parentVersionId: 'v3', onClose() {} };
  let tree = view.render(props);
  assert.equal(calls.length, 0);
  nodes(tree).find(node => node.type === 'select').props.onChange({ target: { value: 'risk' } });
  tree = view.render(props);
  await nodes(tree).find(node => node.type === 'Button' && text(node).includes('Generate editable revision with AI')).props.onClick();
  assert.deepEqual(calls[0].slice(0, 3), ['room', 'r1', 'v3']);
  assert.equal(calls[0][3].sectionId, 'risk');
  assert.equal(calls[0][3].generate, true);
  assert.match(calls[0][3].requestId, /^[a-f0-9-]{36}$/u);
  assert.deepEqual(view.navigations, ['/analysis/reports/v3?draftId=draft']);
});
