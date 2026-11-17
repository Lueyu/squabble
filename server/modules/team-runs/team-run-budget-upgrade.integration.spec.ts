import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

test('fresh and upgraded run ledgers preserve finite reservations and replay explicit unknown monetary costs',
  { skip: !process.env.TEAM_TEST_DATABASE_URL }, async () => {
    const url = process.env.TEAM_TEST_DATABASE_URL!;
    const suffix = randomUUID().replaceAll('-', '');
    const freshName = 'run_budget_fresh_' + suffix, upgradeName = 'run_budget_upgrade_' + suffix;
    const admin = postgres(url, { max: 1, onnotice: () => undefined });
    const fresh = postgres(url, { max: 1, onnotice: () => undefined, connection: { search_path: freshName } });
    const upgrade = postgres(url, { max: 1, onnotice: () => undefined, connection: { search_path: upgradeName } });
    try {
      await admin.unsafe('CREATE SCHEMA ' + freshName);
      await admin.unsafe('CREATE SCHEMA ' + upgradeName);
      const schema = readFileSync('scripts/db/01_schema.sql', 'utf8');
      await fresh.unsafe(schema);
      const nullable = async (client: typeof fresh) => (await client`
        SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema()
          AND table_name='team_run_cycles' AND column_name='reserved_cost_usd'`)[0].is_nullable;
      assert.equal(await nullable(fresh), 'YES');
      const baseline = schema.split('-- 68_team_run_unbounded_budget.sql')[0];
      assert.notEqual(baseline, schema, 'The upgrade baseline must predate the nullable cost migration');
      await upgrade.unsafe(baseline);
      assert.equal(await nullable(upgrade), 'NO');
      const owner = randomUUID(), teamId = randomUUID(), accountId = randomUUID();
      const [agreement] = await upgrade`INSERT INTO team_run_agreements
        (owner_id,team_id,account_id,state,configuration_json,scope_revision,member_snapshots,confirmed_by)
        VALUES(${owner},${teamId},${accountId},'confirmed','{}'::jsonb,1,'[]'::jsonb,${owner}) RETURNING id`;
      await upgrade`INSERT INTO team_run_cycles(owner_id,team_id,agreement_id,agreement_revision,trading_date,
        state,reserved_cost_usd,reserved_calls) VALUES(${owner},${teamId},${agreement.id},1,'2026-11-12','observed',1,2)`;
      const before = await upgrade`SELECT * FROM team_run_cycles`;
      const migration = readFileSync('scripts/db/68_team_run_unbounded_budget.sql', 'utf8');
      await upgrade.unsafe(migration);
      await upgrade.unsafe(migration);
      await upgrade.unsafe(readFileSync('scripts/db/63_team_runs.sql', 'utf8'));
      await fresh.unsafe(migration);
      assert.equal(await nullable(upgrade), 'YES');
      assert.deepEqual(await upgrade`SELECT * FROM team_run_cycles`, before);
      await upgrade`INSERT INTO team_run_cycles(owner_id,team_id,agreement_id,agreement_revision,trading_date,
        state,reserved_cost_usd,reserved_calls) VALUES(${owner},${teamId},${agreement.id},1,'2026-11-13','observed',NULL,2)`;
      for (const amount of [0, -1]) {
        await assert.rejects(upgrade`INSERT INTO team_run_cycles(owner_id,team_id,agreement_id,agreement_revision,trading_date,
          state,reserved_cost_usd,reserved_calls) VALUES(${owner},${teamId},${agreement.id},1,'2026-11-16','observed',${amount},2)`, /check constraint/iu);
      }
      const [unknown] = await upgrade`SELECT reserved_cost_usd FROM team_run_cycles WHERE trading_date='2026-11-13'`;
      assert.equal(unknown.reserved_cost_usd, null);
      await assert.rejects(upgrade`INSERT INTO team_run_cycles(owner_id,team_id,agreement_id,agreement_revision,trading_date,
        state,reserved_cost_usd,reserved_calls) VALUES(${owner},${teamId},${agreement.id},1,'2026-11-16','observed',0,2)`);
    } finally {
      await fresh.end(); await upgrade.end();
      await admin.unsafe('DROP SCHEMA IF EXISTS ' + freshName + ' CASCADE');
      await admin.unsafe('DROP SCHEMA IF EXISTS ' + upgradeName + ' CASCADE');
      await admin.end();
    }
  });
