const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../..');
function harness(file) {
  const states = [], refs = [], effects = [], dependencies = [];
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
    }).outputText, { exports, Date, URL, document: { getElementById() {} },
      window: { setInterval() { return 1; }, clearInterval() {} }, require(name) {
        if (name === 'react') return react;
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (name === 'react-i18next') return { useTranslation: () => ({ t: (key, options = {}) => `${key}${options.count == null ? '' : `:${options.count}`}`, i18n: { language: 'en' } }) };
        if (name === '@/utils/research-events') return load('client/src/utils/research-events.ts');
        if (name === './CouncilResearchTimeline') return load('client/src/pages/Council/CouncilResearchTimeline.tsx');
        if (name === './CouncilResearchProgress') return load('client/src/pages/Council/CouncilResearchProgress.tsx');
        return fallback(name);
      } }, { filename: relative });
    return exports;
  }
  return { render(props) { cursor = 0; refCursor = 0; effectCursor = 0; return load(file).default(props); },
    runEffects() { for (const effect of effects.splice(0)) effect(); } };
}
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []; }
function text(tree) { return Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null ? '' : String(tree); }
const event = (sequence, changes = {}) => ({ sequence, id: `e${sequence}`, taskId: 'task', sessionId: 'room', revision: 2,
  memberId: 'morgan', memberName: 'Morgan', turn: 0, kind: 'tool', toolName: 'research_quote',
  status: 'running', at: '2026-11-03T00:00:00Z', summary: `Public step ${sequence}`, ...changes });
const session = (events, changes = {}) => ({ id: 'room', revision: 2, status: 'running', members: [], reports: [],
  messages: [{ id: 'legacy', memberName: 'Morgan', phase: 'progress', content: 'Legacy acquisition' }], researchEvents: events, ...changes });
const progress = () => harness('client/src/pages/Council/CouncilResearchProgress.tsx');

test('structured task cards replace legacy acquisition text and show public tools and waiting state', () => {
  const tree = progress().render({ session: session([event(1, { kind: 'task', status: 'queued' }), event(2, { kind: 'capability', status: 'succeeded', summary: 'Snapshot mode' })]) });
  assert.ok(!text(tree).includes('Legacy acquisition'));
  assert.ok(text(tree).includes('council.progress.taskStates.queued'));
  assert.ok(text(tree).includes('Snapshot mode'));
  assert.ok(nodes(tree).some(node => node.type === 'article' && node.props['aria-label'].includes('Morgan')));
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

test('older activities expand accessibly while stale revisions have their own labeled disclosure', () => {
  const tree = progress().render({ session: session([...Array.from({ length: 10 }, (_, i) => event(i, { status: 'succeeded' })),
    event(1, { taskId: 'old', revision: 1 })], { researchEventsTruncated: true }) });
  const disclosures = nodes(tree).filter(node => node.type === 'details');
  assert.ok(disclosures.some(node => text(node).includes('council.progress.olderActivities:4')));
  assert.ok(disclosures.some(node => text(node).includes('council.progress.previousRevisions')));
  assert.ok(text(tree).includes('council.progress.truncated'));
  assert.ok(text(tree).includes('council.progress.taskStates.interrupted'));
});

test('legacy history still renders when structured events are absent', () => {
  const tree = progress().render({ session: session(undefined) });
  assert.ok(text(tree).includes('Legacy acquisition'));
});

test('a new revision retains its legacy progress until its own structured events arrive', () => {
  const current = { id: 'current', revision: 2, memberName: 'Morgan', phase: 'progress', content: 'Current data gathering' };
  const previous = { id: 'previous', revision: 1, memberName: 'Morgan', phase: 'progress', content: 'Old duplicated acquisition' };
  const props = { session: session([event(1, { revision: 1 })], { messages: [previous, current] }) };
  const view = progress();
  let tree = view.render(props);
  assert.ok(text(tree).includes('Current data gathering'));
  assert.ok(!text(tree).includes('Old duplicated acquisition'));
  props.session.researchEvents.push(event(1, { kind: 'task' }));
  tree = view.render(props);
  assert.ok(!text(tree).includes('Current data gathering'));
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
