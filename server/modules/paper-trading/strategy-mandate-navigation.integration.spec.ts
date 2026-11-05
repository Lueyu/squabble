import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { builderProfiles, paperAccounts } from '../../database/schema';
import { normalizeBuilderConfig } from './agent-builder.rules';
import { AgentBuilderService } from './agent-builder.service';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { StrategyMandateService } from './strategy-mandate.service';
import type { StrategyMandateInput } from '../../../shared/strategy-mandate.interface';

test('exact strategy navigation is read-only and changed teams require an explicit version rebind', { skip: !process.env.STRATEGY_TEST_DATABASE_URL }, async () => {
  const namespace = 'mandate_navigation_' + randomUUID().replaceAll('-', '');
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  await admin.unsafe('CREATE SCHEMA ' + namespace);
  const sql = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 4, onnotice: () => undefined, connection: { search_path: namespace } });
  try {
    await sql.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const db = drizzle(sql); const owner = randomUUID();
    await sql`INSERT INTO users(id,username,password_hash) VALUES(${owner},'navigation-fixture','fixture')`;
    const config = normalizeBuilderConfig({ name: 'Navigation fixture', template: 'balanced', tickers: ['AAPL'], minimumRating: 'Buy', customPrompt: '',
      maxOrderPct: 2, maxOrdersPerDay: 20, dailyLossLimitPct: 20, notifyOnProposal: false,
      council: { enabled: true, members: [{ id: 'r', role: 'researcher', name: 'Researcher', model: 'fast', instructions: '' },
        { id: 'm', role: 'manager', name: 'Manager', model: 'slow', instructions: '' }] },
      automation: { enabled: true, preOpenMinutes: 60, monitorSeconds: 30, eventReplanCooldownMinutes: 120, maxEventReplansPerDay: 1, notifyClosingSummary: false } });
    const [profile] = await db.insert(builderProfiles).values({ owner, config, status: 'active' }).returning();
    const [activeAccount] = await db.insert(paperAccounts).values({ owner, isActive: true, botEnabled: true }).returning();
    const [historicalAccount] = await db.insert(paperAccounts).values({ owner, isActive: false, botEnabled: false }).returning();
    const documents = new ResearchDocumentsService(db);
    const source = await documents.submit(owner, { idempotencyKey: 'navigation', title: 'Exact source', kind: 'deep', ticker: 'AAPL',
      content: 'Fictional evidence', sections: [{ id: 'thesis', title: 'Thesis', content: 'Fictional evidence' }], dataAsOf: new Date().toISOString(), availableAt: new Date().toISOString() });
    const builder = new AgentBuilderService(db, {} as never);
    const service = new StrategyMandateService(db, documents, builder, {} as never, {} as never);
    const endsAt = new Date(Date.now() + 86400000).toISOString();
    const input: StrategyMandateInput = { title: 'Read-only historical mandate', objective: 'Navigation fixture', period: 'custom', timezone: 'Asia/Shanghai',
      startsAt: new Date().toISOString(), endsAt, accountId: historicalAccount.id, profileId: profile.id, references: [{ versionId: source.id }],
      dailyPlanMode: 'fixed_rules', limits: { maxPositionPct: 10, maxDailyIncreasePct: 5, maxDailyTurnoverPct: 20 },
      routePolicy: { councilPositionCapRatio: 0.8, councilIncrementPct: 3, rollingWindowMinutes: 60, candidateTtlSeconds: 1200 },
      rules: [{ id: 'entry', ticker: 'AAPL', side: 'buy', trigger: { kind: 'price_below', value: 100 }, referencePrice: 100, minPrice: 95, maxPrice: 105,
        maxPositionPct: 10, stopLossPrice: 90, expiresAt: endsAt, evidenceIds: [source.id], rationale: 'Fictional evidence' }] };
    const historical = await service.create(owner, input);
    const linked = await service.viewVersion(owner, historical.id);
    assert.equal(linked.id, historical.id); assert.equal(linked.accountId, historicalAccount.id);
    await assert.rejects(service.viewVersion(randomUUID(), historical.id), /not found/);
    const [unchanged] = await db.select().from(paperAccounts).where(eq(paperAccounts.id, activeAccount.id));
    assert.equal(unchanged.isActive, true); assert.equal(unchanged.botEnabled, true);
    const draft = await service.create(owner, { ...input, accountId: activeAccount.id });
    await db.update(builderProfiles).set({ version: 2 }).where(eq(builderProfiles.id, profile.id));
    await assert.rejects(service.publish(owner, draft.id, draft.revision, null), /agent changed/);
    const edited = await service.update(owner, draft.id, draft.revision, { ...draft, title: 'Reviewed rules' });
    assert.equal(edited.profileVersion, 1, 'ordinary edits must not silently rebind changed authority');
    await assert.rejects(service.rebindProfile(owner, draft.id, edited.revision, 1), /Team version changed/);
    await assert.rejects(service.rebindProfile(owner, draft.id, edited.revision - 1, 2), /Draft changed/);
    const rebound = await service.rebindProfile(owner, draft.id, edited.revision, 2);
    assert.equal(rebound.profileVersion, 2); assert.equal(rebound.revision, edited.revision + 1);
    assert.equal((await service.publish(owner, rebound.id, rebound.revision, null)).status, 'published');
    await assert.rejects(service.rebindProfile(owner, rebound.id, rebound.revision, 2), /Draft changed/);
  } finally { await sql.end(); await admin.unsafe('DROP SCHEMA ' + namespace + ' CASCADE'); await admin.end(); }
});
