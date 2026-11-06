import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import type { StrategyDraftInput } from '../../../shared/user-investment-strategy.interface';

test('immutable report plans import reviewed executable fields with no extraction and preserve explicit user edits', { skip: !process.env.STRATEGY_TEST_DATABASE_URL }, async () => {
  const namespace = 'report_strategy_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 6, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    await client.unsafe(readFileSync('scripts/db/39_user_investment_strategies.sql', 'utf8'));
    const db = drizzle(client), owner = randomUUID(), documents = new ResearchDocumentsService(db); let extractions = 0;
    const service = new UserInvestmentStrategyService(db, documents, { json: async () => { extractions++; throw new Error('No extraction allowed'); } } as never);
    const now = new Date(), startsAt = new Date(now.getTime() - 3600000).toISOString(), endsAt = new Date(now.getTime() + 86400000).toISOString();
    const text = 'AI proposal: AAPL price at most 100: buy 10 shares.';
    const strategy: StrategyDraftInput = { title: 'Fictional proposed plan', body: 'Fictional allocation rationale', timezone: 'Asia/Shanghai', startsAt, endsAt,
      limits: { maxPositionPct: 30, maxDailyIncreasePct: 10, maxDailyTurnoverPct: 30, minCashPct: 10, maxGrossExposurePct: 90, maxOrderPct: 10 },
      entries: [{ id: 'aapl', ticker: 'AAPL', text, sourceKeys: [], startsAt, endsAt, timezone: 'America/New_York',
        directive: { ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_lte', price: 100 }, quantity: 10, reviewedText: text,
          numericEvidence: [{ field: 'trigger.price', value: 100, quote: '100' }, { field: 'quantity', value: 10, quote: '10' }] } }] };
    const plan = { schemaVersion: 1, parameterOrigin: 'ai_proposed', strategy, evidenceIds: ['filing'], gaps: [] };
    async function publish(suffix: string, executionPlan: unknown = plan) {
      return documents.submit(owner, { idempotencyKey: suffix, title: 'Fictional immutable report', kind: 'portfolio', content: 'Full report prose is not an order.',
        sections: [{ id: 'summary', title: 'Summary', content: 'Full report prose is not an order.' }, { id: 'execution-strategy', title: 'Proposed execution strategy', content: 'A readable proposed strategy card.' }],
        availableAt: now.toISOString(), snapshot: { evidence: [{ id: 'filing' }], executionPlan } });
    }
    const report = await publish('typed-plan'), source = { kind: 'report' as const, versionId: report.id, sectionId: 'execution-strategy' };
    const addition = await service.sourcePreview(owner, source);
    assert.equal(addition.source.executionPlan?.readiness, 'ready');
    assert.equal(addition.entries[0].text, text);
    assert.deepEqual(addition.entries[0].directive?.numericEvidence, strategy.entries[0].directive?.numericEvidence);
    assert.deepEqual(addition.entries[0].sourceKeys, [`report:${report.id}:execution-strategy`]);
    await assert.rejects(service.sourcePreview(randomUUID(), source), /not[_ ]found/i);
    const legacyWhole = await service.importSource(owner, { kind: 'report', versionId: report.id });
    assert.equal(legacyWhole.content.entries[0].directive, undefined, 'whole-report import stays observational');
    assert.equal(legacyWhole.sources[0].executionPlan, undefined);

    const imported = await service.importSource(owner, source);
    assert.equal(imported.content.title, strategy.title);
    assert.equal(imported.content.body, strategy.body);
    assert.equal(imported.content.startsAt, startsAt); assert.equal(imported.content.endsAt, endsAt);
    assert.deepEqual(imported.content.limits, strategy.limits);
    assert.equal(imported.content.entries[0].timezone, 'America/New_York');
    assert.equal(imported.preview?.entries[0].state, 'executable');
    assert.equal(imported.preview?.directives[0].quantity, 10);
    assert.equal(imported.preview?.contentHash, (await service.preview(owner, imported.id, imported.revision)).preview?.contentHash,
      'the saved preview uses JSONB canonical content');
    let activations = 0;
    const confirmed = await db.transaction(tx => service.confirmInTransaction(tx, owner, imported.id, imported.revision,
      imported.preview!.contentHash, null, async () => { activations++; }));
    assert.equal(confirmed.status, 'confirmed'); assert.equal(activations, 1);
    assert.equal((await service.importSource(owner, source, true)).id, imported.id, 'daily handoff remains idempotent after confirmation');
    assert.equal(extractions, 0);

    const manualLimits = { maxPositionPct: 20, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 10 };
    const manual = await service.create(owner, { title: 'Manual opinion', body: 'Keep this exact manual body.', timezone: 'UTC',
      startsAt: new Date(now.getTime() - 86400000).toISOString(), endsAt: new Date(now.getTime() + 7 * 86400000).toISOString(), limits: manualLimits,
      entries: [{ id: 'manual', text: 'An independently written manual view.', sourceKeys: [] }] });
    const mixed = await service.addSource(owner, manual.id, manual.revision, source);
    assert.equal(mixed.content.body, manual.content.body); assert.equal(mixed.content.title, manual.content.title);
    assert.equal(mixed.content.startsAt, manual.content.startsAt); assert.equal(mixed.content.endsAt, manual.content.endsAt);
    assert.equal(mixed.content.timezone, 'UTC'); assert.deepEqual(mixed.content.limits, manualLimits);
    assert.deepEqual(mixed.content.entries[0], manual.content.entries[0]);
    assert.equal(mixed.content.entries[1].directive?.reviewedText, text);
    assert.equal(mixed.preview?.entries[1].state, 'executable');
    const outside = await service.create(owner, { ...manual.content, endsAt: new Date(now.getTime() + 3600000).toISOString() });
    await assert.rejects(service.sourcePreview(owner, source, outside.id), /create a new draft/i);
    await assert.rejects(service.addSource(owner, outside.id, outside.revision, source), /create a new draft/i);
    assert.equal((await service.get(owner, outside.id)).revision, 1);

    const incompleteReport = await publish('incomplete-plan', { ...plan, gaps: ['Required evidence is unavailable'] });
    const incomplete = await service.importSource(owner, { ...source, versionId: incompleteReport.id });
    assert.equal(incomplete.sources[0].executionPlan?.readiness, 'needs_info');
    assert.equal(incomplete.content.entries[0].directive, undefined);
    assert.equal(incomplete.preview?.entries[0].state, 'needs_review'); assert.equal(incomplete.preview?.canConfirm, false);
    let deliberateExtractions = 0;
    const preparingService = new UserInvestmentStrategyService(db, documents, { json: async () => {
      deliberateExtractions++; return { entries: incomplete.content.entries.map(entry => ({ id: entry.id, directive: strategy.entries[0].directive })) };
    } } as never);
    const unchanged = await preparingService.prepare(owner, incomplete.id, incomplete.revision, 'explicit-gap-review-preparation');
    assert.equal(deliberateExtractions, 1);
    assert.equal(unchanged.preview?.canConfirm, false, 'extraction cannot resolve an unchanged report evidence gap');
    assert.equal(unchanged.preview?.directives.length, 0);
    const injected = await service.update(owner, unchanged.id, unchanged.revision, { ...unchanged.content,
      entries: unchanged.content.entries.map(entry => ({ ...entry, directive: strategy.entries[0].directive })) });
    assert.equal((await service.preview(owner, injected.id, injected.revision)).preview?.canConfirm, false,
      'adding executable fields cannot bypass gaps without explicitly editing the proposal text');
    const reviewed = await service.update(owner, incomplete.id, injected.revision, { ...injected.content,
      entries: injected.content.entries.map(entry => ({ ...entry, directive: undefined, text: 'AAPL observation after explicit investor review.' })) });
    assert.equal((await service.preview(owner, reviewed.id, reviewed.revision)).preview?.canConfirm, true);

    const expiredEnd = new Date(now.getTime() - 3600000).toISOString(), expiredStart = new Date(now.getTime() - 86400000).toISOString();
    const expiredReport = await publish('expired-plan', { ...plan, strategy: { ...strategy, startsAt: expiredStart, endsAt: expiredEnd,
      entries: strategy.entries.map(entry => ({ ...entry, startsAt: expiredStart, endsAt: expiredEnd })) } });
    const expired = await service.importSource(owner, { ...source, versionId: expiredReport.id });
    assert.equal(expired.content.startsAt, expiredStart); assert.equal(expired.content.endsAt, expiredEnd);
    assert.equal(expired.preview?.entries[0].state, 'expired'); assert.equal(expired.preview?.directives.length, 0);

    const revocable = await publish('revocable-plan');
    const revokedDraft = await service.importSource(owner, { ...source, versionId: revocable.id });
    await documents.revoke(owner, revocable.id, 'Fictional evidence revoked');
    await assert.rejects(db.transaction(tx => service.confirmInTransaction(tx, owner, revokedDraft.id, revokedDraft.revision,
      revokedDraft.preview!.contentHash, imported.id, async () => undefined)), /revoked/i);
    await assert.rejects(service.importSource(owner, { ...source, versionId: revocable.id }), /revoked/i);
    const noTradeReason = 'Available evidence does not justify adding risk.';
    const noTradeReport = await publish('explicit-no-trade-plan', { ...plan, noTradeReason,
      strategy: { ...strategy, body: '', entries: [] } });
    const noTrade = await service.importSource(owner, { ...source, versionId: noTradeReport.id });
    assert.equal(noTrade.content.entries.length, 1, 'explicit adoption has readable observation text even when the plan has no entries or body');
    assert.ok(noTrade.content.entries[0].text.endsWith(noTradeReason));
    assert.equal(noTrade.content.entries[0].directive, undefined); assert.equal(noTrade.content.entries[0].mandateRule, undefined);
    assert.equal(noTrade.preview?.canConfirm, true); assert.equal(noTrade.preview?.directives.length, 0);
    assert.equal(noTrade.preview?.mandateRules.length, 0); assert.equal(noTrade.preview?.entries[0].state, 'observation');
    const noTradeConfirmed = await db.transaction(tx => service.confirmInTransaction(tx, owner, noTrade.id, noTrade.revision,
      noTrade.preview!.contentHash, imported.id, async (_tx, snapshot) => {
        assert.equal(snapshot.preview.directives.length, 0); assert.equal(snapshot.preview.mandateRules.length, 0);
      }));
    assert.equal(noTradeConfirmed.status, 'confirmed');
    assert.equal(extractions, 0, 'report imports and mixed draft previews never request model extraction');
  } finally { await client.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end(); }
});
