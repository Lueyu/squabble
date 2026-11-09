const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { randomUUID } = require('node:crypto');
const { drizzle } = require('drizzle-orm/postgres-js');
const postgres = require('postgres');
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  if (!fs.existsSync(file)) return {};
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
  } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((id) => {
    if (id === '../../common/platform') return { DRIZZLE_DATABASE: 'db' };
    return id.startsWith('.') ? load(path.resolve(path.dirname(file), `${id}.ts`)) : require(id);
  }, mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const { ResearchToolsBudgetService } = load(path.join(__dirname, 'research-tools-budget.service.ts'));
const url = process.env.COUNCIL_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;
const client = url ? postgres(url, { max: 6, onnotice: () => undefined }) : null;
const db = client ? drizzle(client) : null;
const owner = randomUUID();
const other = randomUUID();
before(async () => {
  if (!client) return;
  await client.unsafe(fs.readFileSync('scripts/db/11_research_tools.sql', 'utf8'));
  for (const id of [owner, other]) await client`insert into users(id,username,password_hash)
    values(${id},${'tool-' + id.slice(0, 18)},${'not-a-login-hash'})`;
});
after(async () => {
  if (!client) return;
  await client`delete from users where id = ${owner} or id = ${other}`;
  await client.end();
});
test('paid research has a persistent reservation service', () => {
  assert.equal(typeof ResearchToolsBudgetService, 'function');
});
dbTest('concurrent paid requests cannot cross the per-task limit and other owners stay isolated', async () => {
  const service = new ResearchToolsBudgetService(db);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.reserve(owner, 'parallel-task')));
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 2);
  assert.ok(results.filter((item) => item.status === 'rejected').every((item) => /TASK_LIMIT/.test(item.reason.message)));
  const own = results.find((item) => item.status === 'fulfilled').value;
  await service.settle(other, own, 'succeeded');
  const [row] = await client`select status from research_tool_usage where id = ${own}`;
  assert.equal(row.status, 'reserved');
  await service.reserve(other, 'parallel-task');
});
dbTest('daily paid requests use UTC boundaries and failed attempts still consume bounded slots', async () => {
  const service = new ResearchToolsBudgetService(db);
  await client`delete from research_tool_usage where owner = ${owner}`;
  await client`insert into research_tool_usage(owner,task_id,status,created_at)
    select ${owner},'old-' || n,'failed',date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 second'
    from generate_series(1,20) n`;
  const ids = [];
  for (let index = 0; index < 20; index++) ids.push(await service.reserve(owner, `today-${index}`));
  await service.settle(owner, ids[0], 'failed');
  await assert.rejects(service.reserve(owner, 'one-too-many'), /DAILY_LIMIT/);
});
