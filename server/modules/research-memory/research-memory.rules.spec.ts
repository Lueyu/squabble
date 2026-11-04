import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuoteService } from '../quote/quote.service';
import { canonicalMemorySymbol, rankMemoryRecall } from './research-memory.rules';
import type { ResearchMemoryRecallItem } from '@shared/research-memory.interface';

const detect = QuoteService.prototype.detectMarket;
test('canonical memory identity shares HK aliases and rejects incompatible markets and ambiguous numbers', () => {
  assert.deepEqual(canonicalMemorySymbol('700.HK', undefined, detect), { ticker: '00700.HK', market: 'HK' });
  assert.deepEqual(canonicalMemorySymbol('0700', 'HK', detect), { ticker: '00700.HK', market: 'HK' });
  assert.deepEqual(canonicalMemorySymbol('600519.SS', undefined, detect), { ticker: '600519.SH', market: 'CN' });
  assert.throws(() => canonicalMemorySymbol('000001', 'HK', detect));
  assert.throws(() => canonicalMemorySymbol('700', undefined, detect));
  assert.throws(() => canonicalMemorySymbol('ABC.HK', undefined, detect));
});

test('recall retains a finite candidate pool with a hard bounded context and treats history as opinion', () => {
  const items: ResearchMemoryRecallItem[] = Array.from({ length: 8 }, (_, index) => ({
    kind: 'history', id: String(index), version: 1, memoryId: String(index),
    summary: `${index} ${'untrusted opinion '.repeat(1000)}`, flags: ['opinion'],
    source: { sessionId: 's', reportId: String(index), reportVersion: 1, reportRevision: 1,
      reportCreatedAt: new Date(Date.UTC(2026, 10, index + 1)).toISOString(), url: '/council' }, citations: [],
  }));
  const result = rankMemoryRecall(items, '', { autoArchive: true, recallEnabled: true });
  assert.equal(result.items.length, 8);
  assert.equal(result.items[0].id, '7');
  assert.equal(result.items[0].summary, items[7].summary, 'ranking preserves whole selected items even if they cannot fit');
  assert.equal(result.context, '', 'oversized histories are omitted as whole units');
  const compact = rankMemoryRecall(items.map(item => ({ ...item, summary: 'Historical opinion' })), '', { autoArchive: true, recallEnabled: true });
  assert.match(compact.context, /opinion/i);
  assert.match(compact.context, /never.*instructions/i);
  const topical = rankMemoryRecall(items.map((item, index) => ({ ...item, topic: index === 0 ? 'valuation' : 'general' })),
    'valuation', { autoArchive: true, recallEnabled: true });
  assert.equal(topical.items[0].id, '0', 'an exact topic match outranks a newer unrelated report');
  const confirmed = rankMemoryRecall(items.map((item, index) => ({ ...item, kind: index === 0 ? 'thesis' : 'history' })),
    '', { autoArchive: true, recallEnabled: true });
  assert.equal(confirmed.items[0].kind, 'thesis', 'a valid confirmed thesis outranks newer historical opinions');
});
