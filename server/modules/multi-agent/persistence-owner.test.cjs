const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const tables = Object.fromEntries(['agentRuns', 'agentEvidence', 'bullBearArguments', 'debateRecords',
  'agentRatings', 'riskGateResults', 'strategyRules', 'agentAuditLog', 'analysis', 'deepReport']
  .map(name => [name, { name, owner: `${name}.owner`, runId: `${name}.runId`, id: `${name}.id` }]));

function load(name) {
  const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  }).outputText;
  const exported = { exports: {} };
  const dependencies = {
    '@nestjs/common': { Injectable: () => target => target, Inject: () => () => undefined, Optional: () => () => undefined,
      Logger: class {}, BadRequestException: Error, NotFoundException: Error },
    '../../common/platform': { DRIZZLE_DATABASE: 'db' },
    'drizzle-orm': { eq: (a, b) => [a, b], and: (...conditions) => conditions, inArray: () => true },
    '@server/database/schema': tables,
    '../settings/settings.service': { SettingsService: class {} },
    '../settings/model-route.rules': { parseModelRoute: value => value },
  };
  new Function('require', 'module', 'exports', compiled)(id => {
    if (id === './analysis-report') return load('analysis-report.ts');
    if (dependencies[id]) return dependencies[id];
    throw new Error(`Unexpected dependency: ${id}`);
  }, exported, exported.exports);
  return exported.exports;
}

test('every pipeline insertion explicitly stamps owner and creator without platform database context', async () => {
  const writes = [];
  const db = {
    select: () => ({ from: table => ({ where: async () => table === tables.agentEvidence
      ? [{ id: 'fact', sourceName: 'Market Quote Provider', relevanceScore: '0.9' }] : [] }) }),
    insert: table => ({ values: data => {
      const rows = Array.isArray(data) ? data : [data];
      for (const row of rows) {
        assert.equal(row.owner, 'alice', `${table.name} must not rely on current_setting(app.user_id)`);
        assert.equal(row.createdBy, 'alice', `${table.name} creator must be explicit`);
        assert.notEqual(row.currentValue, 'null', 'numeric NULL must not become the string null');
      }
      writes.push({ table: table.name, rows });
      return { returning: async () => rows, onConflictDoUpdate: async () => undefined };
    } }),
  };
  const { MultiAgentService } = load('multi-agent.service.ts');
  const service = new MultiAgentService(db);
  service.ensureRunOwner = async () => undefined;
  for (const mapper of ['mapRun', 'mapEvidence', 'mapArgument', 'mapDebate', 'mapRating', 'mapRiskGate', 'mapAuditLog', 'mapStrategyRule']) {
    service[mapper] = value => value;
  }
  await service.createRun('alice', { ticker: 'AAPL', triggerType: 'manual', language: 'en' });
  await service.addEvidence('alice', 'run', [{ role: 'fundamental', evidenceType: 'price', title: 'Price', content: 'USD 100', fetchedAt: new Date().toISOString() }]);
  await service.addArgument('alice', 'run', { side: 'bull', argument: 'Fact', evidenceIds: ['fact'] });
  await service.addDebateRecord('alice', 'run', { round: 1, speaker: 'bull', content: 'Fact' });
  await service.saveRating('alice', 'run', { ticker: 'AAPL', rating: 'Watch', confidence: 'low', action: 'Observe' });
  await service.saveRiskGateResults('alice', 'run', [{ ruleName: 'Unknown metric', ruleType: 'hard', passed: false, currentValue: null, thresholdValue: null }]);
  await service.addAuditLog('alice', 'run', 'run_completed', {});
  await service.seedDefaultRules('alice');
  service.getRun = async () => ({ ticker: 'AAPL', language: 'en', evidence: [], arguments: [], debate: [], riskGate: [], rating: null });
  await service.savePipelineReport('alice', 'run', 'basic', null);
  assert.equal(writes.length, 9);
  assert.equal(writes.find(write => write.table === 'riskGateResults').rows[0].currentValue, null);
});

test('retry cleanup stays scoped to failed owner/run and refuses an already published report', async () => {
  const removed = [];
  let reportExists = false;
  const db = {
    select: () => ({ from: () => ({ where: async () => reportExists ? [{ id: 'report' }] : [] }) }),
    transaction: callback => callback({ delete: table => ({ where: async condition => { removed.push({ table: table.name, condition }); } }) }),
  };
  const { MultiAgentService } = load('multi-agent.service.ts');
  const service = new MultiAgentService(db);
  service.getRun = async () => ({ status: 'failed' });
  await service.resetFailedRunArtifacts('alice', 'failed-run');
  assert.equal(removed.length, 5);
  assert.ok(removed.every(item => JSON.stringify(item.condition).includes('alice') && JSON.stringify(item.condition).includes('failed-run')));
  assert.ok(!removed.some(item => ['deepReport', 'agentAuditLog'].includes(item.table)));
  reportExists = true;
  await assert.rejects(service.resetFailedRunArtifacts('alice', 'failed-run'), /report already exists/);
  assert.equal(removed.length, 5);
});
