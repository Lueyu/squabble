const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'research-errors.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exported = { exports: {} };
new Function('module', 'exports', compiled)(exported, exported.exports);
const { safeAnalysisError, analysisErrorCode } = exported.exports;

test('failure messages and log classifications never expose SQL, credentials or portfolio values', () => {
  const error = new Error('Failed query: insert into agent_evidence params: alice-secret, holdings 993824');
  error.cause = { code: '23502' };
  assert.equal(analysisErrorCode(error), '23502');
  for (const language of ['en', 'zh-CN']) {
    const safe = safeAnalysisError(error, language);
    assert.doesNotMatch(safe, /insert|agent_evidence|alice-secret|993824/);
    assert.equal(safeAnalysisError(error.message, language), safe);
  }
  assert.match(safeAnalysisError(new Error('LLM provider returned HTTP 401'), 'en'), /HTTP 401/);
});

test('budget failures retain a specific safe explanation without including provider payloads', () => {
  const error = Object.assign(new Error('API key secret and prompt private'), { code: 'LLM_BUDGET_EXCEEDED' });
  const en = safeAnalysisError(error, 'en');
  const zh = safeAnalysisError(error, 'zh-CN');
  assert.match(en, /budget/i);
  assert.match(zh, /预算/);
  assert.doesNotMatch(en + zh, /secret|private/);
  assert.equal(safeAnalysisError(en, 'en'), en);
  assert.equal(safeAnalysisError(zh, 'zh-CN'), zh);
});

test('budget reasons distinguish permanent task caps from resetting account periods', () => {
  const checks = [
    ['task_tokens', /task.*token|token.*task/i, /本次讨论|本任务/],
    ['task_calls', /task.*call|call.*task/i, /本次讨论|本任务/],
    ['daily_tokens', /UTC.*day|daily/i, /UTC.*日|当日/],
    ['monthly_tokens', /UTC.*month|monthly/i, /UTC.*月|当月/],
    ['daily_calls', /daily.*call|call.*day/i, /当日.*调用/],
    ['input_tokens', /input|prompt/i, /输入|提示/],
  ];
  for (const [reason, enPattern, zhPattern] of checks) {
    const error = Object.assign(new Error('secret private payload'), { code: 'LLM_BUDGET_EXCEEDED', reason });
    const en = safeAnalysisError(error, 'en');
    const zh = safeAnalysisError(error, 'zh-CN');
    assert.match(en, enPattern);
    assert.match(zh, zhPattern);
    assert.doesNotMatch(en + zh, /secret|private payload/);
    assert.equal(safeAnalysisError(en, 'en'), en);
    assert.equal(safeAnalysisError(zh, 'zh-CN'), zh);
    if (reason.startsWith('task')) assert.doesNotMatch(en, /wait.*reset/i);
  }
});

test('safe provider and completion errors identify the remedy and survive persisted error reads', () => {
  for (const [status, pattern] of [[400, /model ID|parameters/], [401, /API key/], [402, /balance|credit/],
    [404, /model ID|endpoint/], [422, /parameters/], [429, /rate|quota/], [503, /busy|unavailable/]]) {
    const en = safeAnalysisError(new Error(`LLM provider returned HTTP ${status}`), 'en');
    assert.match(en, pattern);
    assert.equal(safeAnalysisError(en, 'en'), en);
    const zh = safeAnalysisError(new Error(`LLM provider returned HTTP ${status}`), 'zh-CN');
    assert.equal(safeAnalysisError(zh, 'zh-CN'), zh);
  }
  for (const [code, pattern] of [['LLM_REQUEST_TIMEOUT', /timed out/], ['LLM_OUTPUT_LIMIT', /output.*limit|truncated/], ['LLM_EMPTY_RESPONSE', /empty/], ['LLM_INVALID_JSON', /JSON/]]) {
    const error = Object.assign(new Error('secret private provider URL'), { code });
    const en = safeAnalysisError(error, 'en');
    assert.match(en, pattern);
    assert.doesNotMatch(en, /secret|private provider URL/);
    assert.equal(safeAnalysisError(en, 'en'), en);
  }
});
