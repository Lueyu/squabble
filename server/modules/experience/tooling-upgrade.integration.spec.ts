import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

test('tooling fresh/upgrade catalogs match and replay preserves unknown receipts, approval and ledgers', async () => {
  const url = process.env.EXPERIENCE_TEST_DATABASE_URL ?? process.env.RESEARCH_TEST_DATABASE_URL;
  assert.ok(url && new URL(url).pathname.includes('test'), 'Disposable test database required');
  const client = new Client({ connectionString: url });
  const prefix = `tooling_upgrade_${randomUUID().replaceAll('-', '')}`;
  const fresh = prefix + '_f', upgrade = prefix + '_u';
  const current = readFileSync('scripts/db/01_schema.sql', 'utf8');
  const marker = '-- 53_agent_tool_runtime.sql';
  assert.ok(current.includes(marker));
  const registry = [...readFileSync('server/common/platform/database.provider.ts', 'utf8')
    .matchAll(/'(\d\d_[^']+\.sql)'/gu)].map(match => match[1]);
  const start = registry.indexOf('53_agent_tool_runtime.sql');
  assert.ok(start > 0);
  const additions = registry.slice(start);
  assert.ok(additions.includes('58_deep_agent_driver.sql'));
  const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value)
    .replaceAll(fresh + '.', '').replaceAll(upgrade + '.', ''));
  const catalog = async (name: string): Promise<unknown> => normalize({
    columns: (await client.query(`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,column_name`, [name])).rows,
    constraints: (await client.query(`SELECT c.relname,co.contype,pg_get_constraintdef(co.oid) AS definition FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname,co.contype,pg_get_constraintdef(co.oid)`, [name])).rows,
    indexes: (await client.query(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname`, [name])).rows,
    triggers: (await client.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [name])).rows,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout=45000');
    for (const name of [fresh, upgrade]) await client.query('CREATE SCHEMA ' + quote(name));
    await client.query('SET LOCAL search_path TO ' + quote(fresh));
    await client.query(current);
    await client.query('SET LOCAL search_path TO ' + quote(upgrade));
    await client.query(current.slice(0, current.indexOf(marker)));
    const owner = randomUUID(), account = randomUUID(), run = randomUUID(), step = randomUUID(), invocation = randomUUID();
    await client.query(`INSERT INTO holdings(owner,ticker,shares,buy_price,market,currency) VALUES ($1,'FICT',7,42,'US','USD')`, [owner]);
    await client.query(`INSERT INTO cash_accounts(owner,currency,balance) VALUES ($1,'USD',1234.50)`, [owner]);
    await client.query(`INSERT INTO paper_accounts(id,owner,initial_cash,cash_balance,bot_enabled,ledger_mode) VALUES ($1,$2,10000,9876.54,false,'native')`, [account, owner]);
    const ledger = async (): Promise<unknown> => ({ holdings: (await client.query('SELECT * FROM holdings')).rows,
      cash: (await client.query('SELECT * FROM cash_accounts')).rows, accounts: (await client.query('SELECT * FROM paper_accounts')).rows });
    const before = await ledger();
    for (const file of additions) await client.query(readFileSync(`scripts/db/${file}`, 'utf8'));
    await client.query(`INSERT INTO agent_runtime_runs(id,owner,identity_hash,identity,driver,frozen_input_hash,frozen_input_enc,policy,state) VALUES ($1,$2,'identity','{}','controlled','frozen','ciphertext','{}','provider_unknown')`, [run, owner]);
    await client.query(`INSERT INTO agent_runtime_steps(id,owner,run_id,step_index,dispatch_key,request_hash,request_enc,model,state) VALUES ($1,$2,$3,0,'dispatch','request','private-request','fixture','provider_unknown')`, [step, owner, run]);
    await client.query(`INSERT INTO agent_tool_invocations(id,owner,run_id,step_id,tool_call_id,tool_id,catalog_version_id,arguments_hash,arguments_enc,state,remote_receipt) VALUES ($1,$2,$3,$4,'call','tool','catalog','hash','private-arguments','provider_unknown','{"remoteId":"known-remote"}')`, [invocation, owner, run, step]);
    await client.query(`INSERT INTO agent_tool_budget_reservations(id,owner,run_id,invocation_id,amount,unit,price_version,state) VALUES ($1,$2,$3,$4,5,'credits','v1','unknown')`, [randomUUID(), owner, run, invocation]);
    await client.query(`INSERT INTO tool_actions(id,owner,run_id,step_id,tool_call_id,tool_id,connection_id,connection_revision,catalog_version_id,payload_hash,arguments_hash,preview_enc,expires_at) VALUES ($1,$2,$3,$4,'write','tool',$5,1,'catalog','payload','arguments','private-preview',now()+interval '10 minutes')`, [randomUUID(), owner, run, step, randomUUID()]);
    await client.query(`INSERT INTO research_compute_jobs(id,owner,run_id,request_key,request_hash,input_enc,kind,state,sandbox_id,max_runtime_ms) VALUES ($1,$2,$3,'compute','hash','private-input','statistics','provider_unknown','known-sandbox',120000)`, [randomUUID(), owner, run]);
    const receipts = async (): Promise<unknown> => ({ run: (await client.query('SELECT * FROM agent_runtime_runs')).rows,
      steps: (await client.query('SELECT * FROM agent_runtime_steps')).rows, invocations: (await client.query('SELECT * FROM agent_tool_invocations')).rows,
      budgets: (await client.query('SELECT * FROM agent_tool_budget_reservations')).rows, actions: (await client.query('SELECT * FROM tool_actions')).rows,
      compute: (await client.query('SELECT * FROM research_compute_jobs')).rows });
    const pending = await receipts();
    for (let pass = 0; pass < 2; pass++) for (const file of additions) await client.query(readFileSync(`scripts/db/${file}`, 'utf8'));
    assert.deepEqual(await ledger(), before);
    assert.deepEqual(await receipts(), pending, 'DDL must neither retry unknown work nor expire/approve pending actions');
    assert.deepEqual(await catalog(upgrade), await catalog(fresh));
    for (const table of ['agent_runtime_events', 'agent_tool_budget_events', 'agent_model_usage_corrections',
      'deep_agent_driver_checkpoints', 'paper_orders', 'paper_trades', 'strategy_signals']) {
      assert.equal((await client.query('SELECT count(*) FROM ' + quote(table))).rows[0].count, '0', table + ' must not receive implicit work');
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
