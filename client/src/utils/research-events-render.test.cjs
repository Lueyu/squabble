const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
const translations = require('../i18n/council.en.json');
const cache = new Map();
let language = 'en';

function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const requireModule = id => {
    if (id.endsWith('.css')) return {};
    if (id === 'react-i18next') return { useTranslation: () => ({ i18n: { language }, t: (key, values = {}) => {
      const value = key.replace(/^council\./, '').split('.').reduce((item, part) => item?.[part], translations) ?? key;
      return String(value).replace(/\{\{(\w+)\}\}/gu, (_match, name) => String(values[name] ?? ''));
    } }) };
    if (id.startsWith('@/') || id.startsWith('@shared/') || id.startsWith('.')) {
      const target = id.startsWith('@/') ? path.resolve(__dirname, '..', id.slice(2))
        : id.startsWith('@shared/') ? path.resolve(__dirname, '../../..', 'shared', id.slice(8))
          : path.resolve(path.dirname(filename), id);
      const resolved = [target, `${target}.tsx`, `${target}.ts`].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
      if (resolved) return load(resolved);
    }
    return require(id);
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, { exports: module.exports, module, require: requireModule, URL });
  return module.exports;
}

const ChatMessage = load(path.resolve(__dirname, '../pages/Council/CouncilChatMessage.tsx')).default;
const base = { id: 'reply', role: 'researcher', memberId: 'm1', memberName: 'Analyst', content: 'A supported answer.',
  revision: 1, createdAt: '2026-11-03T01:00:00Z' };
const session = { id: 's1', revision: 1, status: 'running', messages: [], reports: [], members: [
  { id: 'm1', role: 'researcher', name: 'Analyst' },
] };
const task = { key: 'task-turn', taskId: 't1', revision: 1, memberId: 'm1', memberName: 'Analyst', turn: 0,
  status: 'running', startedAt: base.createdAt, activities: [], sourceCount: 0, isStale: false, truncated: false };
const render = props => renderToStaticMarkup(React.createElement(ChatMessage, { session, onQuestion: () => {}, ...props }));

test('legacy automated replies expose missing submission records as unknown while user replies do not', () => {
  const automated = render({ message: base });
  assert.match(automated, /Memory submission unknown/);
  assert.doesNotMatch(automated, /Submitted 0/);
  assert.doesNotMatch(render({ message: { ...base, role: 'user' } }), /Memory submission unknown/);
});

test('role messages and task attempts show a folded bilingual selected/prepared/submitted inventory', () => {
  const inventory = { requested: [{ kind: 'thesis', id: 'thesis-1', version: 2 }], selected: [{ kind: 'thesis', id: 'thesis-1', version: 2 }],
    prepared: [], submitted: [], counts: { requested: 1, selected: 1, prepared: 0, submitted: 0 },
    budgetTokens: 120, usedTokens: 0, basis: 'conservative-utf8', omissions: [{ kind: 'thesis', id: 'thesis-1', version: 2, reason: 'budget' }] };
  const workflow = { goal: 'financials', peers: [], tasks: [{ id: 't', key: 'financials', state: 'failed', dependencies: [], skills: [], reworks: 0,
    attempts: [{ id: 'attempt', kind: 'work', state: 'failed', startedAt: base.createdAt, memory: inventory }] }] };
  const Panel = load(path.resolve(__dirname, '../pages/Council/CouncilWorkflowPanel.tsx')).default;
  try {
    for (const [locale, labels] of [['en', ['Selected', 'Prepared', 'Submitted', 'Whole item exceeds budget']],
      ['zh-CN', ['已选择', '已准备', '已提交', '整条超过预算']]]) {
      language = locale;
      const chat = render({ message: { ...base, memory: inventory } });
      const panel = renderToStaticMarkup(React.createElement(Panel, { session: { ...session, workflow }, actions: {} }));
      const running = render({ task: { ...task, taskId: 'attempt' }, session: { ...session, workflow } });
      for (const html of [chat, panel, running]) {
        for (const label of labels) assert.ok(html.includes(label), `${locale}: ${label}`);
        assert.match(html, /thesis-1/); assert.match(html, /v2/);
        assert.doesNotMatch(html, /<details[^>]*\bopen(?:[= >])/u);
        assert.doesNotMatch(html, /model used|模型已使用/iu);
      }
    }
  } finally { language = 'en'; }
});

test('all seven template personas retain distinct portraits and match their message palette', () => {
  const Avatar = load(path.resolve(__dirname, '../pages/Council/CouncilMemberAvatar.tsx')).default;
  const templates = ['value', 'growth', 'risk', 'technical', 'news', 'macro', 'moderator'];
  const portraits = templates.map(avatar => renderToStaticMarkup(React.createElement(Avatar, { avatar, role: 'researcher' })));
  assert.equal(new Set(portraits.map(html => html.slice(html.indexOf('<svg')))).size, 7);
  for (const avatar of templates) {
    const html = render({ message: base, session: { ...session, members: [{ ...session.members[0], avatar }] } });
    assert.ok(html.includes(`data-persona="${avatar}"`));
  }
  assert.match(render({ message: { ...base, role: 'user' } }), /data-persona="user"/);
  assert.match(render({ message: { ...base, role: 'manager', memberId: null }, session: { ...session, members: [] } }), /data-persona="moderator"/);
});

test('copy includes folded public sections and reply excerpts are bounded without hiding the original', () => {
  const { councilCopyText, councilReplyExcerpt } = load(path.resolve(__dirname, 'council-message-text.ts'));
  const message = { ...base, response: { thesis: base.content, evidencePoints: ['Evidence'], risks: ['Risk'], nextChecks: ['Check'], details: 'Full detail' }, reasoningSummary: ['Evidence'] };
  const copy = councilCopyText(message);
  for (const text of [base.content, 'Evidence', 'Risk', 'Check', 'Full detail']) assert.ok(copy.includes(text));
  assert.equal(copy.split('Evidence').length, 2);
  assert.equal(councilReplyExcerpt({ ...base, content: 'A'.repeat(500) }).length, 181);
  assert.equal(councilCopyText({ ...base, content: 'A'.repeat(500) }).length, 500);
});

test('research is collapsed above the answer in one role card and failure stays visible while collapsed', () => {
  const html = render({ message: base, task: { ...task, status: 'failed', summary: 'Source disconnected.' } });
  assert.equal((html.match(/<article\b/gu) ?? []).length, 1);
  assert.ok(html.indexOf('<details') < html.indexOf(base.content));
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:[= >])/u);
  assert.ok(html.includes(translations.progress.history));
  assert.match(html, /Failed/);
  assert.ok(html.indexOf('Failed') < html.indexOf('</summary>'), 'collapsed state must retain the failure label');
});

test('active cards display one-line research status and wait for a reply without a second card', () => {
  const html = render({ task });
  assert.equal((html.match(/<article\b/gu) ?? []).length, 1);
  assert.ok(html.includes(translations.progress.taskStates.running));
  assert.match(html, /Researching/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:[= >])/u);
});

test('a successful answer still shows source failures in its collapsed research summary', () => {
  const html = render({ message: base, task: { ...task, status: 'succeeded', activities: [
    { key: 'failed-source', kind: 'tool', status: 'failed', summary: 'Filing unavailable', at: base.createdAt, startedAt: base.createdAt },
  ] } });
  const summary = html.slice(html.indexOf('<summary'), html.indexOf('</summary>'));
  assert.ok(summary.includes(translations.progress.taskStates.succeeded));
  assert.match(summary, /Source gaps/);
});

test('structured answers render a readable hierarchy with full details and no duplicate rationale', () => {
  const response = { thesis: 'Cash flow supports resilience.', evidencePoints: ['Cash generation improved.'],
    risks: ['Margins may weaken.'], nextChecks: ['Review the next filing.'], details: 'Full supporting detail. '.repeat(400) };
  const html = render({ message: { ...base, content: response.thesis, response,
    reasoningSummary: [...response.evidencePoints, 'A separate public rationale.'] }, task });
  for (const text of [response.thesis, ...response.evidencePoints, ...response.risks, ...response.nextChecks, response.details]) {
    assert.ok(html.includes(text));
  }
  assert.equal(html.split(response.evidencePoints[0]).length - 1, 1);
  assert.ok(html.includes('A separate public rationale.'));
  assert.match(html, /Evidence and rationale/);
  assert.match(html, /Risks/);
  assert.match(html, /Next checks/);
  assert.match(html, /Full analysis/);
});

test('legacy paragraphs and user text remain intact while duplicate public rationale is omitted', () => {
  const content = 'A material fact.\n\nA second paragraph.';
  const html = render({ message: { ...base, content, reasoningSummary: ['A material fact.', 'An additional reason.'] } });
  assert.ok(html.includes(content));
  assert.equal(html.split('A material fact.').length - 1, 1);
  assert.ok(html.includes('An additional reason.'));
  assert.ok(render({ message: { ...base, role: 'user', content } }).includes(content));
});
