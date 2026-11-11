import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
test('fresh and genuine baseline60 upgrades agree after replay, preserving legacy ledger without invented team ownership', {skip:!process.env.TEAM_TEST_DATABASE_URL},async()=>{
  const url=process.env.TEAM_TEST_DATABASE_URL!,suffix=randomUUID().replaceAll('-',''),freshName='teams_fresh_'+suffix,upgradeName='teams_upgrade_'+suffix;
  const admin=postgres(url,{max:1,onnotice:()=>undefined}),fresh=postgres(url,{max:1,onnotice:()=>undefined,connection:{search_path:freshName}}),upgrade=postgres(url,{max:1,onnotice:()=>undefined,connection:{search_path:upgradeName}});
  try{
    await admin.unsafe('CREATE SCHEMA '+freshName);await admin.unsafe('CREATE SCHEMA '+upgradeName);
    const base=readFileSync('scripts/db/01_schema.sql','utf8'),migration=readFileSync('scripts/db/61_teams.sql','utf8');
    await fresh.unsafe(base);
    const baseline=base.split('-- 61_teams.sql')[0];assert.ok(!baseline.includes('CREATE TABLE IF NOT EXISTS teams ('),'upgrade fixture must really predate teams');
    await upgrade.unsafe(baseline);
    assert.equal((await upgrade`SELECT to_regclass('teams') AS relation`)[0].relation,null);
    const owner=randomUUID();await upgrade`INSERT INTO users(id,username,password_hash) VALUES(${owner},'legacy-fixture','unused')`;
    const [account]=await upgrade`INSERT INTO paper_accounts(owner,name,is_active,bot_enabled,cash_balance) VALUES(${owner},'Legacy running',true,true,12345.67) RETURNING *`;
    const before=await upgrade`SELECT id,owner,name,is_active,bot_enabled,cash_balance FROM paper_accounts WHERE id=${account.id}`;
    await upgrade.unsafe(migration);await upgrade.unsafe(migration);await fresh.unsafe(migration);
    assert.deepEqual(await upgrade`SELECT id,owner,name,is_active,bot_enabled,cash_balance FROM paper_accounts WHERE id=${account.id}`,before);
    assert.equal(Number((await upgrade`SELECT count(*) AS count FROM teams`)[0].count),0);
    assert.equal(Number((await upgrade`SELECT count(*) AS count FROM team_account_bindings`)[0].count),0);
    assert.equal(Number((await upgrade`SELECT count(*) AS count FROM team_commission_jobs`)[0].count),0);
    async function catalog(client:ReturnType<typeof postgres>){
      const columns=await client`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND (table_name LIKE 'team%' OR table_name IN ('council_research_tasks','council_sessions','portfolio_combination_drafts','portfolio_combination_previews','portfolio_combination_revisions')) ORDER BY table_name,ordinal_position`;
      const indexes=await client`SELECT c.relname,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid WHERE t.relnamespace=current_schema()::regnamespace AND (t.relname LIKE 'team%' OR t.relname IN ('council_research_tasks','council_sessions')) ORDER BY c.relname`;
      const value=JSON.stringify({columns,indexes});return JSON.parse(value.replaceAll(freshName,'fixture_schema').replaceAll(upgradeName,'fixture_schema'));
    }
    assert.deepEqual(await catalog(upgrade),await catalog(fresh));
    const [identity]=await upgrade`SELECT pg_get_expr(indpred,indrelid) AS predicate FROM pg_index WHERE indexrelid=to_regclass('council_research_tasks_cycle_key_idx')`;
    assert.match(identity.predicate,/work_key IS NULL/);
    await upgrade.unsafe(readFileSync('scripts/db/18_research_workflow.sql','utf8'));
    assert.deepEqual(await catalog(upgrade),await catalog(fresh),'legacy migration replay cannot reinstate full task-kind uniqueness');
  }finally{await fresh.end();await upgrade.end();await admin.unsafe('DROP SCHEMA IF EXISTS '+freshName+' CASCADE');await admin.unsafe('DROP SCHEMA IF EXISTS '+upgradeName+' CASCADE');await admin.end();}
});
