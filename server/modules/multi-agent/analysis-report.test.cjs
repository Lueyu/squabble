const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'analysis-report.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exported = { exports: {} };
new Function('module', 'exports', compiled)(exported, exported.exports);
const { buildPipelineReport, languageInstruction, normalizeAnalysisLanguage } = exported.exports;

const detail = {
  language: 'en', ticker: 'AAPL', evidence: [
    { id: 'fact', sourceName: 'Market Quote Provider', title: 'Price', content: 'USD 100' },
    { id: 'gap', sourceName: 'Data Unavailable', title: 'News unavailable', content: 'No verified news' },
  ],
  arguments: [], debate: [], riskGate: [{ ruleName: 'Exposure', ruleType: 'hard', passed: false }],
  rating: { rating: 'Watch', confidence: 'low', targetPrice: null, action: 'Wait', aggregationLogic: 'Insufficient evidence', keyUncertainty: 'Missing news' },
};

test('basic report is explicitly non-LLM and contains no invented debate or price targets', () => {
  const report = buildPipelineReport(detail, 'basic', null);
  assert.equal(report.analysisTrace.engine, 'basic');
  assert.equal(report.analysisTrace.language, 'en');
  assert.equal(report.targetBase, null);
  assert.deepEqual(report.bullPoints, []);
  assert.equal(report.analysisTrace.steps.find(step => step.id === 'debate').status, 'skipped');
  assert.match(report.analysisTrace.steps.find(step => step.id === 'risk').summary, /1.*hard/i);
  assert.deepEqual(report.analysisTrace.steps[0].evidenceIds, ['fact']);
});

test('LLM report preserves published arguments and exact evidence citations, not unsupported claims', () => {
  const report = buildPipelineReport({ ...detail,
    arguments: [{ id: 'a', side: 'bull', round: 1, argument: 'Supported claim', evidenceIds: ['fact'] },
      { id: 'b', side: 'bear', round: 1, argument: 'Invented claim', evidenceIds: ['unknown'] }],
    debate: [{ speaker: 'critic', content: 'Check the evidence', createdAt: '2026-10-30' }],
  }, 'llm', { provider: 'user', modelFast: 'fast', modelSlow: 'slow' });
  assert.equal(report.analysisTrace.model, 'slow');
  assert.equal(report.bullPoints[0].detail, 'Supported claim');
  assert.deepEqual(report.bullPoints[0].evidenceIds, ['fact']);
  assert.deepEqual(report.bearPoints, []);
  assert.equal(report.criticPoints[0].critique, 'Check the evidence');
});

test('language validation rejects unsupported values and output instruction retains JSON enums', () => {
  assert.equal(normalizeAnalysisLanguage(undefined), 'zh-CN');
  assert.equal(normalizeAnalysisLanguage('en'), 'en');
  assert.throws(() => normalizeAnalysisLanguage('fr'), /language/);
  assert.match(languageInstruction('en'), /English/);
  assert.match(languageInstruction('en'), /JSON keys/);
  assert.match(languageInstruction('zh-CN'), /简体中文/);
});
