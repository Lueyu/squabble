const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const filename = resolve(__dirname, 'simple-experience.ts');
const moduleUnderTest = { exports: {} };
if (existsSync(filename)) runInNewContext(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: moduleUnderTest, exports: moduleUnderTest.exports, URLSearchParams, Date });
const api = moduleUnderTest.exports;

test('three primary destinations have the same order in Chinese and English', () => {
  assert.equal(api.simpleNavigation?.('zh-CN').map(item => item.label).join(','), '今日,频道,AI 投资');
  assert.equal(api.simpleNavigation?.('en').map(item => item.label).join(','), 'Today,Channel,AI investing');
});
test('a past decision keeps its frozen context when a stock code is also present', () => {
  assert.equal(JSON.stringify(api.contextFromSearch?.(new URLSearchParams('decisionId=old-order&ticker=TEST'))),
    JSON.stringify({ kind: 'decision', orderId: 'old-order' }));
  assert.equal(JSON.stringify(api.contextFromSearch?.(new URLSearchParams('referenceVersionId=original'))),
    JSON.stringify({ kind: 'report', documentId: 'original' }));
  assert.equal(api.contextFromSearch?.(new URLSearchParams()), undefined);
});
test('the home page highlights at most three actual attention items without invented fillers', () => {
  assert.equal(api.highlightedAttention?.([{ id: 'one' }]).length, 1);
  assert.equal(api.highlightedAttention?.(Array.from({ length: 9 }, (_, id) => ({ id }))).length, 3);
  assert.equal(api.highlightedAttention?.([]).length, 0);
});
test('request identity survives a retry and changes only for new intent', () => {
  let sequence = 0;
  const intent = api.createRequestIntent?.(() => `request-${++sequence}`);
  assert.equal(intent?.keyFor({ message: 'Question' }), 'request-1');
  assert.equal(intent?.keyFor({ message: 'Question' }), 'request-1');
  assert.equal(intent?.keyFor({ message: 'Another question' }), 'request-2');
  intent?.complete();
  assert.equal(intent?.keyFor({ message: 'Another question' }), 'request-3');
});
