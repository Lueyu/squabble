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
