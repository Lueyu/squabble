import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const url = process.env.EXPERIENCE_TEST_DATABASE_URL ?? process.env.RESEARCH_TEST_DATABASE_URL;
const files = ['37_asset_ledger_integrity.sql', '39_user_investment_strategies.sql', '40_transaction_imports.sql', '41_portfolio_value_points.sql', '42_user_strategy_runtime.sql', '43_channel_workbench.sql', '44_strategy_draft_deletion.sql', '45_portfolio_workspace.sql', '46_strategy_interviews.sql', '47_portfolio_companions.sql','48_portfolio_history.sql', '49_research_deletions.sql', '50_data_library.sql', '51_browser_sources.sql'];
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';

test('fresh install and repeated asset/report/strategy upgrades have identical catalogs and preserve existing ledgers', { skip: !url }, async () => {
  const client = new Client({ connectionString: url });
  const prefix = 'assets_upgrade_' + randomUUID().replaceAll('-', '');
  const fresh = prefix + '_fresh', upgrade = prefix + '_upgrade';
  const current = readFileSync('scripts/db/01_schema.sql', 'utf8');
  const marker = '-- 37_asset_ledger_integrity.sql';
  assert.ok(current.includes(marker));
  const old = current.slice(0, current.indexOf(marker));
  const normal = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(fresh + '.', '').replaceAll(upgrade + '.', ''));
  const schema = async (name: string) => { await client.query('SET LOCAL search_path TO ' + identifier(name)); };
  const catalog = async (name: string) => normal({
    columns: (await client.query(`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default,is_identity FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,column_name`, [name])).rows,
    constraints: (await client.query(`SELECT c.relname,co.contype,pg_get_constraintdef(co.oid) AS definition FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname,co.contype,pg_get_constraintdef(co.oid)`, [name])).rows,
    indexes: (await client.query(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname`, [name])).rows,
    triggers: (await client.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [name])).rows,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 45000');
    for (const name of [fresh, upgrade]) await client.query('CREATE SCHEMA ' + identifier(name));
    await schema(fresh); await client.query(current);
    await schema(upgrade); await client.query(old);
    const owner = randomUUID(), account = randomUUID();
    await client.query(`INSERT INTO holdings(owner,ticker,shares,buy_price,market,currency) VALUES ($1,'FICT',7,42,'US','USD')`, [owner]);
    await client.query(`INSERT INTO cash_accounts(owner,currency,balance) VALUES ($1,'USD',1234.50)`, [owner]);
    await client.query(`INSERT INTO paper_accounts(id,owner,initial_cash,cash_balance,bot_enabled,ledger_mode) VALUES ($1,$2,10000,9876.54,false,'native')`, [account, owner]);
    await client.query(`INSERT INTO paper_positions(owner,account_id,ticker,shares,avg_cost) VALUES ($1,$2,'FICT',2.5,49.38)`, [owner, account]);
    await client.query(`INSERT INTO user_api_settings(owner,finnhub_api_key_enc,llm_route) VALUES ($1,'test-only-existing-encrypted-finnhub', '{"mode":"basic"}')`, [owner]);
    const before = {
      holdings: (await client.query('SELECT id,owner,ticker,shares,buy_price FROM holdings')).rows,
      cash: (await client.query('SELECT id,owner,currency,balance FROM cash_accounts')).rows,
      paper: (await client.query('SELECT * FROM paper_positions')).rows,
      financialSettings: (await client.query('SELECT owner,finnhub_api_key_enc,llm_route FROM user_api_settings')).rows,
    };
    for (let pass = 0; pass < 2; pass++) for (const file of files) await client.query(readFileSync('scripts/db/' + file, 'utf8'));
    assert.deepEqual((await client.query('SELECT id,owner,ticker,shares,buy_price FROM holdings')).rows, before.holdings);
    assert.deepEqual((await client.query('SELECT id,owner,currency,balance FROM cash_accounts')).rows, before.cash);
    assert.deepEqual((await client.query('SELECT * FROM paper_positions')).rows, before.paper);
    assert.deepEqual((await client.query('SELECT owner,finnhub_api_key_enc,llm_route FROM user_api_settings')).rows, before.financialSettings);
    assert.equal((await client.query('SELECT reconciliation_status FROM cash_accounts')).rows[0].reconciliation_status, 'confirmed');
    assert.equal((await client.query('SELECT shares FROM position_baselines')).rows[0].shares, '7');
    const upgraded = await catalog(upgrade);
    assert.deepEqual(await catalog(fresh), upgraded);
    // A later nonzero, unconfirmed balance and new holding must not be promoted
    // into confirmed state or opening checkpoints when startup replays SQL.
    await client.query(`INSERT INTO cash_accounts(owner,currency,balance) VALUES ($1,'HKD',500);`, [owner]);
    await client.query(`INSERT INTO holdings(owner,ticker,shares,buy_price) VALUES ($1,'LATER',2,20)`, [owner]);
    for (const file of files) await client.query(readFileSync('scripts/db/' + file, 'utf8'));
    assert.equal((await client.query(`SELECT reconciliation_status FROM cash_accounts WHERE currency='HKD'`)).rows[0].reconciliation_status, 'unconfirmed');
    assert.equal((await client.query(`SELECT count(*) FROM position_baselines WHERE ticker='LATER'`)).rows[0].count, '0');
    for (const table of ['paper_orders', 'paper_trades', 'strategy_signals', 'investment_requests', 'user_investment_strategy_current',
      'portfolio_strategy_assignments', 'portfolio_combination_revisions', 'portfolio_combination_drafts', 'portfolio_combination_previews',
      'strategy_interviews', 'strategy_interview_requests', 'portfolio_account_companions', 'research_deletion_requests',
      'data_library_sources', 'data_library_versions', 'data_library_jobs', 'financial_data_connections']) {
      assert.equal((await client.query('SELECT count(*) FROM ' + identifier(table))).rows[0].count, '0', table + ' must not receive implicit work');
    }
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT count(*) FROM pg_namespace WHERE nspname=ANY($1)', [[fresh, upgrade]])).rows[0].count, '0');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
