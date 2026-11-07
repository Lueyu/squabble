import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentErrorMessage } from './council.native';

test('native provider limits explain the cause and manual recovery in both languages', () => {
  for (const language of ['en', 'zh']) {
    const usage = agentErrorMessage('LOCAL_USAGE_LIMIT', language);
    const rate = agentErrorMessage('LOCAL_RATE_LIMIT', language);
    assert.match(usage, /额度|usage limit/i);
    assert.match(usage, /模型|model/i);
    assert.match(rate, /频率|rate limit/i);
    assert.match(rate, /稍后|later/i);
    for (const message of [usage, rate]) {
      assert.match(message, /未自动重试|not retried/i);
      assert.doesNotMatch(message, /检查连接|check.*connection/i);
    }
  }
});

test('incomplete native research explains retained work and step retry without blaming connection or limits', () => {
  for (const language of ['en', 'zh']) {
    const message = agentErrorMessage('LOCAL_PROTOCOL_INCOMPLETE', language);
    assert.match(message, /未完整返回|not fully returned|not confirmed complete/iu);
    assert.match(message, /保留|retained/iu);
    assert.match(message, /当前步骤|current step/iu);
    assert.doesNotMatch(message, /连接|connection|限流|rate limit|暂时不可用|unavailable/iu);
  }
});
test('returned invalid results direct users to local formatting within the saved research', () => {
  for (const language of ['en', 'zh']) {
    const text = agentErrorMessage('LOCAL_INVALID_RESULT', language);
    assert.match(text, /已返回|returned/iu); assert.match(text, /保留|retained/iu);
    assert.match(text, /原研究|saved research/iu); assert.doesNotMatch(text, /新建讨论|new discussion/iu);
  }
});
