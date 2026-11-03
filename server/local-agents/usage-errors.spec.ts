import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeEventCollector } from './events';
import type { LocalAgentProvider } from '../../shared/local-agents.interface';
import { readOpenCodeDiagnostic, providerLimitFailure } from './failures';

const failures: Array<[LocalAgentProvider, unknown, string]> = [
  ['opencode', { type: 'error', error: { name: 'APIError', data: { message: 'Free usage limit reached. private-token' } } }, 'NATIVE_AGENT_USAGE_LIMIT'],
  ['codex', { type: 'turn.failed', error: { message: 'You have hit your usage limit. Try again later.' } }, 'NATIVE_AGENT_USAGE_LIMIT'],
  ['claude', { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['API Error: 429 insufficient_quota'] }, 'NATIVE_AGENT_USAGE_LIMIT'],
  ['gemini', { type: 'result', status: 'error', error: { code: 429, message: 'Too many requests' } }, 'NATIVE_AGENT_RATE_LIMIT'],
  ['antigravity', { event: 'result', result: { status: 'ERROR', error: { code: 'rate_limit_exceeded' } } }, 'NATIVE_AGENT_RATE_LIMIT'],
  ['kimi', { role: 'error', content: 'Error: credit balance is too low' }, 'NATIVE_AGENT_USAGE_LIMIT'],
  ['doubao', { status: 'failed', error: { message: '余额不足，请充值' } }, 'NATIVE_AGENT_USAGE_LIMIT'],
];

for (const [provider, event, code] of failures) test(`${provider} publishes a safe usage failure code`, () => {
  const collector = new NativeEventCollector(provider, () => undefined);
  assert.throws(() => collector.read(JSON.stringify(event)), { message: code });
});

test('ordinary research text about usage limits is not treated as a provider error', () => {
  const collector = new NativeEventCollector('opencode', () => undefined);
  collector.read(JSON.stringify({ type: 'text', part: { text: 'Free usage limit reached is a pricing constraint.' } }));
  collector.read(JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }));
  assert.equal(collector.result().text, 'Free usage limit reached is a pricing constraint.');
});

test('unknown provider failures do not publish raw private diagnostics', () => {
  const collector = new NativeEventCollector('opencode', () => undefined);
  assert.throws(() => collector.read(JSON.stringify({ type: 'error', error: { message: 'private-token: unknown failure' } })),
    { message: 'NATIVE_AGENT_FAILED' });
});

test('OpenCode auxiliary title failures and non-error logs do not stop the primary research', () => {
  for (const line of [
    'level=ERROR small=true agent=title error.error="Free usage limit reached"',
    'level=ERROR agent=title error="rate_limit_exceeded"',
    'level=INFO small=false error="Free usage limit reached"',
    'Free usage limit reached',
    'level=ERROR message="stream error" error="private-token unknown failure"',
    'level=ERROR service=tool error="HTTP 429: too many requests while reading a source"',
  ]) assert.doesNotThrow(() => readOpenCodeDiagnostic(line));
  assert.throws(() => readOpenCodeDiagnostic('ERROR 2026-11-03 service=llm error="rate_limit_exceeded"'),
    { message: 'NATIVE_AGENT_RATE_LIMIT' });
});

test('credit exhaustion takes precedence over HTTP 429, while per-minute quotas stay rate limits', () => {
  assert.equal(providerLimitFailure({ statusCode: 429, message: 'insufficient_quota' })?.message, 'NATIVE_AGENT_USAGE_LIMIT');
  assert.equal(providerLimitFailure({ statusCode: 429, message: 'quota exceeded: requests per minute' })?.message, 'NATIVE_AGENT_RATE_LIMIT');
  assert.equal(providerLimitFailure({ code: 'quota_exceeded' })?.message, 'NATIVE_AGENT_USAGE_LIMIT');
  assert.equal(providerLimitFailure({ message: 'You have hit your rate limit. Retry after 60 seconds.' })?.message, 'NATIVE_AGENT_RATE_LIMIT');
  assert.equal(providerLimitFailure({ message: 'You have hit your tokens per minute limit.' })?.message, 'NATIVE_AGENT_RATE_LIMIT');
  assert.equal(providerLimitFailure({ message: "You've hit your limit. Resets tomorrow." })?.message, 'NATIVE_AGENT_USAGE_LIMIT');
});
