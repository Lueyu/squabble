import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { paperAccounts, paperSnapshots } from '../../database/schema';
import { portfolioValuePoints } from '../../database/portfolio-value-points.schema';
import { PortfolioComparisonService } from './portfolio-comparison.service';
import { simulationPreviews, simulationSeeds } from '../../database/simulation-experiments.schema';
import { simulationValuationBaselines } from '../../database/user-strategy-runtime.schema';
import { paperEquityObservations } from '../../database/portfolio-observations.schema';
import type { SimulationSeed } from '../../../shared/simulation-experiment.interface';

test('comparison reads owned saved observations, preserves gaps and performs no valuation writes', async () => {
  assert.ok(process.env.STRATEGY_TEST_DATABASE_URL, 'A disposable STRATEGY_TEST_DATABASE_URL is required');
  const namespace = `comparison_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const client = postgres(process.env.STRATEGY_TEST_DATABASE_URL!, { max: 2, onnotice: () => undefined, connection: { search_path: namespace } });
  try {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const db = drizzle(client);
    const owner = randomUUID();
    const other = randomUUID();
    const [ownAccount, foreignAccount] = await db.insert(paperAccounts).values([
      { owner, name: 'Fictional late account', createdAt: new Date('2026-11-03T16:00:00Z') },
      { owner: other, name: 'Other workspace' },
    ]).returning();
    await db.insert(paperSnapshots).values([
      { owner, accountId: ownAccount.id, snapshotDate: '2026-11-03', valuedAt: new Date('2026-11-03T16:00:00Z'), equity: '1000', cash: '1000' },
      { owner, accountId: ownAccount.id, snapshotDate: '2026-11-06', valuedAt: new Date('2026-11-06T16:00:00Z'), equity: '1050', cash: '1050' },
      { owner: other, accountId: foreignAccount.id, snapshotDate: '2026-11-06', valuedAt: new Date('2026-11-06T16:00:00Z'), equity: '999999', cash: '999999' },
    ]);
    await db.insert(portfolioValuePoints).values([
      { owner, dateKey: '2026-11-03', slot: 'a', capturedAt: new Date('2026-11-03T15:00:00Z'), totalValueUsd: '1000', knownValueUsd: '1000', complete: true, estimated: false },
      { owner, dateKey: '2026-11-04', slot: 'b', capturedAt: new Date('2026-11-04T15:00:00Z'), totalValueUsd: '1500', knownValueUsd: '1500', complete: true, estimated: false, externalFlows: [{ id: 'deposit', fingerprint: 'new' }] },
    ]);
    const before = await client`SELECT count(*) AS n FROM portfolio_value_points`;
    const service = new PortfolioComparisonService(db);
    const view = await service.read(owner, '1M', undefined, new Date('2026-11-09T12:00:00Z'));
    assert.equal(view.series.length, 2);
    assert.equal(view.series[0].returnPct, null, 'new external money must not be displayed as investment return');
    const simulation = view.series.find(series => series.accountId === ownAccount.id)!;
    assert.equal(simulation.points[0].date, '2026-11-03');
    assert.equal(simulation.points[1].equityUsd, null, 'missing dates break the line');
    assert.equal(simulation.equityUsd, 1050);
    assert.equal(simulation.returnPct, null, 'unseeded legacy history cannot establish a verified return');
    await assert.rejects(service.read(owner, '1M', foreignAccount.id), /COMPARISON_ACCOUNT_NOT_FOUND/);
    await assert.rejects(service.read(owner, 'yesterday'), /COMPARISON_PERIOD_INVALID/);
    const ownOnly = await service.read(owner, 'ALL', ownAccount.id, new Date('2026-11-09T12:00:00Z'));
    assert.equal(ownOnly.series.length, 1);
    assert.deepEqual(await client`SELECT count(*) AS n FROM portfolio_value_points`, before);

    const [deferred, fallback, unknown] = await db.insert(paperAccounts).values([
      { owner, name: 'Deferred baseline' }, { owner, name: 'Legacy timestamp' }, { owner, name: 'Cash unknown' },
    ]).returning();
    const seed: SimulationSeed = {
      sourceRevision: 'fictional', capturedAt: '2026-11-03T12:00:00.000Z', positions: [],
      cash: [{ currency: 'USD', total: '100', available: '100', frozen: '0', unsettled: '0', availabilityKnown: true }],
      initialEquityUsd: '100', fx: [], gaps: [],
      model: { version: 'paper-v1', feeBps: 0, slippageBps: 0, corporateActions: 'unsupported' },
    };
    for (const [account, data] of [
      [deferred, { ...seed, initialEquityUsd: null, gaps: ['QUOTE_MISSING'] }],
      [fallback, seed],
      [unknown, { ...seed, cash: [{ ...seed.cash[0], availabilityKnown: false }], gaps: ['CASH_UNKNOWN'] }],
    ] as const) {
      const [preview] = await db.insert(simulationPreviews).values({ owner, seed: data, expiresAt: new Date('2026-11-10') }).returning();
      await db.insert(simulationSeeds).values({ owner, accountId: account.id, previewId: preview.id,
        idempotencyKey: account.id, requestHash: account.id, seed: data });
    }
    await db.insert(simulationValuationBaselines).values({ owner, accountId: deferred.id,
      seed: { ...seed, initialEquityUsd: '200', valuationStartedAt: '2026-11-05T12:00:00.000Z' } });
    await db.insert(paperSnapshots).values([
      { owner, accountId: deferred.id, snapshotDate: '2026-11-04', valuedAt: new Date('2026-11-04T12:00:00Z'), equity: '100', cash: '100' },
      { owner, accountId: deferred.id, snapshotDate: '2026-11-06', valuedAt: new Date('2026-11-06T12:00:00Z'), equity: '220', cash: '220' },
      { owner, accountId: fallback.id, snapshotDate: '2026-11-03', valuedAt: new Date('2026-11-03T14:00:00Z'), equity: '110', cash: '110' },
      // The Shanghai valuation date is tomorrow in UTC, but its actual observation already exists.
      { owner, accountId: fallback.id, snapshotDate: '2026-11-10', valuedAt: new Date('2026-11-09T17:00:00Z'), equity: '121', cash: '121' },
      { owner, accountId: unknown.id, snapshotDate: '2026-11-04', valuedAt: new Date('2026-11-04T12:00:00Z'), equity: '110', cash: '110' },
      { owner, accountId: unknown.id, snapshotDate: '2026-11-05', valuedAt: new Date('2026-11-05T12:00:00Z'), equity: '121', cash: '121' },
    ]);
    const verified = await service.read(owner, 'ALL', [deferred.id, fallback.id, unknown.id].join(','), new Date('2026-11-09T18:00:00Z'));
    const delayed = verified.series.find(item => item.accountId === deferred.id)!;
    assert.equal(delayed.points[0].returnPct, null, 'a later baseline must not retroactively trust older snapshots');
    assert.equal(delayed.returnFrom, '2026-11-05T12:00:00.000Z');
    assert.ok(Math.abs(delayed.returnPct! - 10) < 1e-8);
    const legacy = verified.series.find(item => item.accountId === fallback.id)!;
    assert.equal(legacy.returnFrom, seed.capturedAt, 'old seeds use their captured timestamp when no explicit valuation start exists');
    assert.equal(legacy.valuationAsOf, '2026-11-09T17:00:00.000Z');
    assert.equal(legacy.equityUsd, 121);
    assert.ok(Math.abs(legacy.returnPct! - 21) < 1e-8);
    assert.equal(verified.series.find(item => item.accountId === unknown.id)!.returnPct, null);

    await db.insert(paperEquityObservations).values([
      {owner,accountId:deferred.id,slot:'missing-quote',dateKey:'2026-11-09',capturedAt:new Date('2026-11-09T16:00:00Z'),equityUsd:null,knownValueUsd:'100',complete:false,estimated:true,marketQuotes:[],gaps:['QUOTE_TIME_UNVERIFIED:ACME'],sourceFingerprint:'missing'},
      {owner,accountId:deferred.id,slot:'recovered-quote',dateKey:'2026-11-09',capturedAt:new Date('2026-11-09T17:00:00Z'),equityUsd:'240',knownValueUsd:'240',complete:true,estimated:false,marketQuotes:[],gaps:[],sourceFingerprint:'recovered'},
    ]);
    await db.insert(paperSnapshots).values({owner,accountId:deferred.id,snapshotDate:'2026-11-09',valuedAt:new Date('2026-11-09T18:00:00Z'),equity:'999',cash:'999'});
    const recovered=(await service.read(owner,'ALL',deferred.id,new Date('2026-11-09T19:00:00Z'))).series[0];
    const quoteGap=recovered.points.find(point=>point.timestamp==='2026-11-09T16:00:00.000Z')!;
    assert.equal(quoteGap.equityUsd,null);assert.equal(quoteGap.returnPct,null);
    assert.ok(!quoteGap.gaps.includes('CASH_FLOW_OR_BASELINE_CHANGED'),'missing market data is not a financial discontinuity');
    assert.equal(recovered.equityUsd,240,'later legacy daily facts cannot replace the intraday stream');
    assert.ok(Math.abs(recovered.returnPct!-20)<1e-8,'known recovery can compare to the unchanged trusted opening');
    await db.insert(paperEquityObservations).values({owner,accountId:deferred.id,slot:'changed-account',dateKey:'2026-11-09',capturedAt:new Date('2026-11-09T19:30:00Z'),equityUsd:null,knownValueUsd:'100',complete:false,estimated:true,marketQuotes:[],gaps:['ACCOUNT_CHANGED_DURING_CAPTURE'],sourceFingerprint:'changed'});
    const changed=(await service.read(owner,'ALL',deferred.id,new Date('2026-11-09T20:00:00Z'))).series[0];
    assert.equal(changed.returnPct,null);assert.ok(changed.gaps.includes('CASH_FLOW_OR_BASELINE_CHANGED'));
  } finally {
    await client.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await admin.end();
  }
});
