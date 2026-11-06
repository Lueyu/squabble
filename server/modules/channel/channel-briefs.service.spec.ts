import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { ChannelBriefsService } from './channel-briefs.service';
import { ChannelService } from './channel.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { councilReports, councilSessions } from '../../database/council.schema';
import { channelBriefs, channelBubbles, channelReports, channelTemplateRegistry } from '../../database/channel.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { holdings } from '../../database/schema';

const url = process.env.CHANNEL_TEST_DATABASE_URL ?? process.env.COUNCIL_TEST_DATABASE_URL;
test('production Brief compilation persists report contracts and dispatches actual completed research and price conditions', { skip: !url }, async () => {
  const namespace = `briefs_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  const client = postgres(url!, { max: 6, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const file of readdirSync('scripts/db').filter(name => /^\d\d_.*\.sql$/u.test(name) && !name.startsWith('02_')).sort()) await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    const db = drizzle(client), documents = new ResearchDocumentsService(db), owner = randomUUID(), stranger = randomUUID();
    let quotePrice = 90, quoteSequence = 0;
    const quoteAt = () => new Date(Date.now() + quoteSequence * 100).toISOString();
    const quotes = { getQuote: async (ticker: string) => ({ symbol: ticker, price: String(quotePrice), currency: 'USD', market: 'US', source: 'fixture', quoteAt: quoteAt() }) };
    const channel = new ChannelService(db, quotes as never); await channel.onModuleInit();
    const briefs = new ChannelBriefsService(db, channel, quotes as never);
    const [holding] = await db.insert(holdings).values({ owner, ticker: 'ACME', shares: '3', buyPrice: '80', currentPrice: '90' }).returning();
    const now = new Date(), evidenceId = 'filing-one';
    const [session] = await db.insert(councilSessions).values({ owner, ticker: 'PORTFOLIO', scene: 'portfolio_daily', status: 'completed',
      profileVersion: 1, profileSnapshot: {} as never, createdAt: new Date(now.getTime() - 130000),
      checkpoint: { simple: { researchOnly: true, contextDate: '2026-11-06' } } as never }).returning();
    const [report] = await db.insert(councilReports).values({ owner, sessionId: session.id, version: 1, revision: 1,
      decision: 'wait', summary: '# Daily report\n\nACME original filing condition.\n\n## Strategy draft\n\nObserve only.', dissent: [], nextReviewCondition: 'Original price condition',
      engine: 'local', publicationOutcome: 'succeeded', evidence: [{ id: evidenceId, title: 'Fictional filing', content: 'ACME observation condition', sourceUrl: 'https://example.test/filing', fetchedAt: now.toISOString(),
        metadata: { sources: [{ origin: 'provider', verification: 'server-verified', provider: 'fixture', kind: 'financial', sourceUrl: 'https://example.test/filing', sourceRevision: '1', supersedesSourceRevision: null,
          revisionReason: null, publishedAt: now.toISOString(), publicationPrecision: 'instant', observedAt: now.toISOString(), observationBasis: 'server',
          facts: [{ entity: 'ACME', metric: 'price', value: 100, currency: 'USD', unit: 'USD', basis: 'observation', actuality: 'actual', periodStart: null, periodEnd: null, instant: now.toISOString() }] }] } }],
      thesisCandidates: [{ claim: 'ACME observation premise', supportingEvidence: [{ evidenceId }], opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: ['Observe the explicitly stated condition'],
        monitorConditions: [{ conditionIndex: 0, metric: 'price', unit: 'USD', operator: 'lte', threshold: 100,
          validFrom: new Date(now.getTime() - 10000).toISOString(), validUntil: new Date(now.getTime() + 3600000).toISOString(), evidenceIds: [evidenceId], rationale: 'A sourced observation boundary, not a trade order' }] }] }).returning();
    const version = await documents.importSource(owner, { type: 'council', id: report.id });
    await db.update(councilReports).set({ researchVersionId: version.id }).where(eq(councilReports.id, report.id));
    await channel.ingestReport(owner, { id: version.id, revision: version.version, title: version.title, content: report.summary, sections: version.sections, createdAt: report.createdAt.toISOString(), source: { type: 'council', id: report.id, researchOnly: true } });

    await briefs.tick();
    const stored = await db.select().from(channelBriefs).where(eq(channelBriefs.owner, owner));
    assert.equal(stored.length, 3, 'close, actual process duration and calculable cross are persisted as real Briefs');
    assert.ok(stored.every(row => row.data.when && row.data.text.templateRevision === 1 && row.data.card.templateRevision === 1 && row.data.anchor.reportSectionId));
    const published = await db.select().from(channelBubbles).where(eq(channelBubbles.owner, owner));
    assert.ok(published.some(row => row.data.templateId === 'channel.research.closed'));
    assert.ok(published.some(row => row.data.templateId === 'channel.process.research_arrived'));
    assert.ok(published.some(row => row.data.templateId === 'channel.report.condition'));
    assert.ok(!published.some(row => /监控按原计划继续/u.test(row.data.text)), 'completion does not invent an active monitor');
    assert.equal((await channel.projection(stranger)).episodes.length, 0);
    assert.equal((await channel.projection(stranger)).report, null);
    await assert.rejects(channel.bubble(stranger, published[0].id));

    await briefs.tick();
    assert.equal((await db.select().from(channelBubbles).where(eq(channelBubbles.owner, owner))).length, published.length, 'same quote and same completed research do not re-publish');
    quotePrice = 110; quoteSequence++; await briefs.tick();
    quotePrice = 88; quoteSequence++; await briefs.tick();
    assert.equal((await db.select().from(channelBubbles).where(eq(channelBubbles.owner, owner))).filter(row => row.data.templateId === 'channel.report.condition').length, 2, 'a new clear-to-met observation re-arms the watch episode');
    const [after] = await db.select().from(holdings).where(eq(holdings.id, holding.id));
    assert.equal(after.shares, holding.shares); assert.equal(after.buyPrice, holding.buyPrice, 'Brief dispatch never changes real holdings');

    await db.update(researchDocumentVersions).set({ revokedAt: new Date() }).where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, version.id)));
    await briefs.tick();
    assert.ok((await db.select().from(channelBriefs).where(eq(channelBriefs.owner, owner))).every(row => row.data.status === 'invalidated'));
    assert.equal((await db.select().from(channelReports).where(eq(channelReports.owner, owner))).length, 1, 'revocation does not erase the original channel report');
    const [raw] = await db.select().from(councilReports).where(eq(councilReports.id, report.id));
    assert.equal(raw.summary, report.summary, 'original report content is preserved');

    const [template] = await db.select().from(channelTemplateRegistry).where(eq(channelTemplateRegistry.id, 'channel.report.condition'));
    assert.ok(template, 'dispatch uses the shared registry rather than an ad-hoc text catalog');
  } finally {
    await client.end(); await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`; await admin.end();
  }
});
