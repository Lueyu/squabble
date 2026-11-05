import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { normalizeThread, freezeThreadContext, threadPromptContext, hasDeliberation } from './council.thread';

test('legacy sessions retain stock semantics and portfolio scenes do not require a ticker', () => {
  assert.equal(normalizeThread({ ticker: 'aapl' }).scene, 'stock');
  assert.equal(normalizeThread({ scene: 'portfolio_daily', subject: 'Daily holdings' }).ticker, 'PORTFOLIO');
  assert.throws(() => normalizeThread({ scene: 'invalid', ticker: 'AAPL' }), /scene/iu);
  assert.throws(() => normalizeThread({ scene: 'stock' }), /ticker/iu);
  assert.throws(() => normalizeThread({ ticker: 'bad ticker' }), BadRequestException);
  assert.throws(() => normalizeThread({ scene: 'period_strategy', period: { start: '2026-11-30', end: '2026-11-01' } }), /period/iu);
});

test('fork context stops at the selected owned message and freezes values', () => {
  const messages = [{ id: 'a', role: 'user', memberName: 'You', content: 'Original' },
    { id: 'b', role: 'manager', memberName: 'Manager', content: 'Later' }];
  const frozen = freezeThreadContext(messages, 'a');
  messages[0].content = 'Changed';
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0].content, 'Original');
  assert.throws(() => freezeThreadContext(messages, 'foreign'), /message/iu);
});

test('fixed report text and inherited transcript remain whole in every prompt context', () => {
  const reference = { versionId: 'v1', title: 'Report', content: 'fixed text '.repeat(500), version: 1 };
  const context = threadPromptContext({ scene: 'portfolio_daily', subject: 'Holdings',
    resolvedReferences: [reference], inheritedContext: [{ id: 'a', role: 'user', memberName: 'You', content: 'Prior' }] } as never);
  assert.deepEqual(context.pinnedReports, [reference]);
  assert.equal(context.parentDiscussion[0].content, 'Prior');
  assert.equal(context.scene, 'portfolio_daily');
});

test('high-risk approval requires a real manager and another participant in the current cycle', () => {
  const messages = [{ memberId: 'r', role: 'researcher', cycleId: 'now' }, { memberId: 'm', role: 'manager', cycleId: 'now' }];
  assert.equal(hasDeliberation('basic', 'now', messages), false);
  assert.equal(hasDeliberation('llm', 'now', messages.slice(1)), false);
  assert.equal(hasDeliberation('llm', 'new', messages), false);
  assert.equal(hasDeliberation('llm', 'now', messages), true);
});

 test('reviewed continuation uses a bounded summary and source links rather than recursively copied transcript', () => {
  const context = threadPromptContext({ inheritedContext: [{ id: 'a', role: 'user', memberName: 'You', content: 'Large old text '.repeat(1000) }],
    continuationSummary: { content: 'Reviewed hypothesis, still unverified', sourceSessionId: 'parent', sourceMessageIds: ['a'], references: [{ versionId: 'v1' }] } } as never);
  assert.deepEqual(context.parentDiscussion, []);
  assert.equal(context.continuationSummary?.content, 'Reviewed hypothesis, still unverified');
  assert.match(context.summaryPolicy, /not.*evidence/iu);
});

test('pinned Council report snapshots expose provenance without recursively replaying archived transcripts', () => {
  const context = threadPromptContext({ resolvedReferences: [{ versionId: 'report', content: 'Exact published summary', snapshot: {
    holdings: [{ ticker: 'AAPL', quantity: 5 }], inheritedContext: [{ content: 'Old transcript'.repeat(100) }],
    resolvedReferences: [{ versionId: 'old-version', title: 'Old source', version: 1, status: 'revoked', content: 'Nested old body' }],
  } }] } as never);
  const payload = JSON.stringify(context);
  assert.ok(payload.includes('Exact published summary'));
  assert.ok(payload.includes('old-version'));
  assert.ok(payload.includes('revoked'));
  assert.ok(payload.includes('holdings'));
  assert.equal(payload.includes('Old transcript'), false);
  assert.equal(payload.includes('Nested old body'), false);
});
