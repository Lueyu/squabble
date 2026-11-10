const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');
function load() {
  const source = fs.readFileSync(path.join(__dirname, 'research-documents.ts'), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, URLSearchParams });
  return exports;
}
test('report navigation pins exact version and section, preserving encoded excerpt', () => {
  const { researchDiscussionPath, researchStrategyPath } = load();
  const path = researchDiscussionPath({ id: 'v1', ticker: 'ACME', kind: 'daily' }, 'risk', 'A & B');
  const query = new URL(`https://example.test${path}`).searchParams;
  assert.equal(query.get('referenceVersionId'), 'v1'); assert.equal(query.get('sectionId'), 'risk'); assert.equal(query.get('excerpt'), 'A & B');
  assert.equal(query.get('scene'), 'stock');
  assert.match(researchDiscussionPath({ id: 'portfolio-v1', ticker: null, kind: 'portfolio' }), /scene=portfolio_daily/);
  assert.equal(researchStrategyPath('v1'), '/paper?sourceReportVersionId=v1&draft=1');
  assert.equal(new URL(`https://example.test${researchStrategyPath('v1', 'risk')}`).searchParams.get('sourceSectionId'), 'risk');
});
test('section edits preserve citation ids and produce inspectable before/after changes', () => {
  const { researchSectionChanges, researchSectionsContent } = load();
  const original = [{ id: 'risk', title: 'Risk', content: 'Old risk' }];
  const edited = [{ id: 'risk', title: 'Risk', content: 'New risk' }];
  const diff = researchSectionChanges(original, edited);
  assert.equal(diff[0].id, 'risk'); assert.equal(diff[0].before, 'Old risk'); assert.equal(diff[0].after, 'New risk');
  assert.match(researchSectionsContent(edited), /New risk/); assert.equal(original[0].content, 'Old risk');
});

test('report reader tolerates an older server response without adoption history during upgrade', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const navigation = require('./simple-test-loader.cjs')().load('features/navigation/workspace-navigation.ts');
  const source = fs.readFileSync(path.join(__dirname, '../pages/Analysis/ResearchDocumentPage.tsx'), 'utf8');
  const exported = {};
  const version = { id: 'v1', title: 'Saved research', kind: 'daily', version: 1, status: 'valid', sourceStatus: 'available',
    createdAt: '2026-11-05T00:00:00Z', sections: [], snapshot: null, source: null };
  const ui = ({ children }) => React.createElement('div', null, children);
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports: exported, Date, URLSearchParams, require: name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === 'react-router-dom') return { Link: ui, useNavigate: () => () => {}, useParams: () => ({ versionId: 'v1' }),
      useLocation: () => ({ pathname: '/analysis/reports/v1', search: '', hash: '', state: { returnTo: '/analysis?date=2026-11-05' }, key: 'saved-report' }),
      useSearchParams: () => [new URLSearchParams(), () => {}] };
    if (name === '@/features/navigation/workspace-navigation') return navigation;
    if (name === '@tanstack/react-query') return { useQuery: () => ({ data: { version, document: { strategyVersionIds: [] }, versions: [version], drafts: [], diff: [], strategyUses: [] } }) };
    if (name === 'react-i18next') return { useTranslation: () => ({ i18n: { resolvedLanguage: 'en' } }) };
    if (name === 'sonner') return { toast: {} };
    if (name === '@/hooks/use-simple-experience') return { useSimpleExperience: () => ({ enabled: false }) };
    if (name === 'lucide-react') return Object.fromEntries(['ArrowLeft', 'GitBranch', 'MessageSquare', 'Pencil', 'Check', 'LoaderCircle'].map(key => [key, ui]));
    if (name.startsWith('@/components/ui/')) return { Button: ui, Badge: ui, Input: ui, Textarea: ui };
    return {};
  } });
  assert.match(renderToStaticMarkup(React.createElement(exported.default)), /Saved research/);
});
