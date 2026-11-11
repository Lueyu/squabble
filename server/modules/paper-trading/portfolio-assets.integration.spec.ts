import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PortfolioAssetsService } from './portfolio-assets.service';

test('asset reads preserve account isolation, native cash, null marks and the entire ledger without writes', {
  skip: !process.env.STRATEGY_TEST_DATABASE_URL,
}, async () => {
  const url = process.env.STRATEGY_TEST_DATABASE_URL!;
  const namespace = `portfolio_assets_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const client = postgres(url, { max: 1, onnotice: () => undefined, connection: { search_path: namespace } });
  await admin.unsafe(`CREATE SCHEMA ${namespace}`);
  try {
    await client.unsafe(readFileSync('scripts/db/01_schema.sql', 'utf8'));
    const owner = randomUUID(); const foreign = randomUUID();
    const [a] = await client`INSERT INTO paper_accounts(owner,name,ledger_mode) VALUES(${owner},'Fictional A','native_currency') RETURNING id`;
    const [b] = await client`INSERT INTO paper_accounts(owner,name) VALUES(${owner},'Fictional B') RETURNING id`;
    const [secret] = await client`INSERT INTO paper_accounts(owner,name) VALUES(${foreign},'PRIVATE') RETURNING id`;
    await client`INSERT INTO paper_positions(owner,account_id,ticker,market,currency,shares,avg_cost) VALUES(${owner},${a.id},'FICT','HK','HKD',2.5,0),(${owner},${b.id},'OTHER','US','USD',9,10)`;
    await client`INSERT INTO simulation_cash(owner,account_id,currency,available,frozen,unsettled,availability_known) VALUES(${owner},${a.id},'HKD',123.45,2,3,true),(${owner},${a.id},'CNY',0,0,0,false)`;
    for (let i = 0; i < 23; i++) {
      const [order] = await client`INSERT INTO paper_orders(owner,account_id,ticker,side,quantity,status) VALUES(${owner},${a.id},'FICT','buy',1,'filled') RETURNING id`;
      await client`INSERT INTO paper_trades(owner,account_id,order_id,ticker,side,quantity,price,cash_after) VALUES(${owner},${a.id},${order.id},'FICT','buy',1,10,100)`;
    }
    const before = await client`SELECT (SELECT count(*)::int FROM paper_snapshots) AS nav, (SELECT count(*)::int FROM simulation_settlements) AS settlement, (SELECT sum(available) FROM simulation_cash) AS cash`;
    const service = new PortfolioAssetsService(drizzle(client));
    const result = await service.read(owner, a.id);
    assert.equal(result.accountId, a.id);
    assert.equal(result.positions.length, 1);
    assert.equal(result.positions[0].ticker, 'FICT');
    assert.equal(result.positions[0].avgCost, null, 'zero placeholder cost does not become known cost');
    assert.equal(result.positions[0].currentPrice, null);
    assert.equal(result.positions[0].marketValue, null);
    assert.equal(result.equityUsd, null);
    assert.equal(result.cash.find(item => item.currency === 'HKD')?.available, '123.45');
    assert.equal(result.cash.find(item => item.currency === 'CNY')?.available, null);
    assert.equal(result.orders.length, 23, 'ledger must not silently truncate to the 20 overview actions');
    assert.equal(result.trades.length, 23);
    await service.read(owner, a.id);
    await assert.rejects(service.read(owner, secret.id), /ACCOUNT_NOT_FOUND/);
    await assert.rejects(service.read(owner, randomUUID()), /ACCOUNT_NOT_FOUND/);
    await assert.rejects(service.read(owner, 'bad-id'), /INVALID_ACCOUNT_ID/);
    const after = await client`SELECT (SELECT count(*)::int FROM paper_snapshots) AS nav, (SELECT count(*)::int FROM simulation_settlements) AS settlement, (SELECT sum(available) FROM simulation_cash) AS cash`;
    assert.deepEqual(after, before);
  } finally {
    await client.end(); await admin.unsafe(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
  }
});
