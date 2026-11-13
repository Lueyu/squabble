/**
 * Resolve the compiled application's Nest providers without bootstrapping jobs.
 * Requires an explicitly supplied disposable database with the base schema.
 * Run through test:wiring so decorator metadata comes from the production build.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const databaseUrl = process.env.WIRING_TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'WIRING_TEST_DATABASE_URL must point to a disposable test database.');
  const compiled = path.resolve(__dirname, '../dist/server');
  assert.ok(fs.existsSync(path.join(compiled, 'app.module.js')), 'Run npm run build:server first.');

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squabble-module-wiring-'));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    LOCAL_AGENTS_DATA_DIR: temporaryRoot,
    NODE_ENV: 'test',
    AUTH_MODE: 'account',
    SQUABBLE_SIMPLE_EXPERIENCE: 'false',
    JWT_SECRET: 'fictional-module-wiring-secret-not-for-running-an-instance',
    SETTINGS_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
  });

  require('reflect-metadata');
  const { NestFactory, ModulesContainer } = require('@nestjs/core');
  const { AppModule } = require(path.join(compiled, 'app.module'));
  const { DRIZZLE_DATABASE } = require(path.join(compiled, 'common/platform/database.provider'));
  const { PortfolioResearchRouteService } = require(path.join(compiled, 'modules/research-routing/portfolio-research-route.service'));
  const { ResearchRoutingModule } = require(path.join(compiled, 'modules/research-routing/research-routing.module'));
  const { EvidenceService } = require(path.join(compiled, 'modules/research-core/evidence.service'));
  const { PortfolioContextService } = require(path.join(compiled, 'modules/research-core/portfolio-context.service'));
  const toolingProviders = [
    ['teams/teams.service', 'TeamsService'],
    ['teams/team-version.service', 'TeamVersionService'],
    ['teams/team-commission.service', 'TeamCommissionService'],
    ['teams/team-commission.worker', 'TeamCommissionWorker'],
    ['teams/team-decision.service', 'TeamDecisionService'],
    ['teams/team-runtime-adapter', 'TeamRuntimeAdapter'],
    ['paper-trading/portfolio-assets.service', 'PortfolioAssetsService'],
    ['experience/portfolio-valuation.scheduler', 'PortfolioValuationScheduler'],
    ['portfolio-history/portfolio-intraday-reference.service', 'PortfolioIntradayReferenceService'],
    ['telemetry/telemetry-diagnostics.service', 'TelemetryDiagnosticsService'],
    ['local-agents/local-agents.service', 'LocalAgentsService'],
    ['research-runtime/runtime-journal.service', 'RuntimeJournalService'],
    ['research-runtime/research-runtime.service', 'ResearchRuntimeService'],
    ['research-runtime/drivers/deep-agents.driver', 'DeepAgentsDriver'],
    ['tool-connections/tool-connections.service', 'ToolConnectionsService'],
    ['tool-actions/tool-actions.service', 'ToolActionsService'],
    ['research-artifacts/research-artifacts.service', 'ResearchArtifactsService'],
    ['data-library/data-dataset.service', 'DataDatasetService'],
    ['research-compute/research-compute.service', 'ResearchComputeService'],
    ['data-library/browser/browser-research.module', 'BrowserResearchService'],
  ].map(([modulePath, name]) => require(path.join(compiled, 'modules', modulePath))[name]);

  let app;
  const deadline = setTimeout(() => {
    console.error('Module wiring check exceeded 30 seconds.');
    process.exit(1);
  }, 30_000);
  try {
    // Do not call init(), listen() or createApplicationContext(): they run
    // lifecycle hooks that schedule work. This check only resolves providers.
    app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
    const route = app.get(PortfolioResearchRouteService);
    assert.equal(route, app.select(ResearchRoutingModule).get(PortfolioResearchRouteService, { strict: true }));

    const modules = [...app.get(ModulesContainer).values()];
    for (const token of [PortfolioResearchRouteService, EvidenceService, PortfolioContextService, ...toolingProviders]) {
      const owners = modules.filter(module => module.providers.has(token));
      assert.equal(owners.length, 1, `${token.name} must have exactly one provider owner.`);
      assert.ok(app.get(token), `${token.name} must resolve in the application.`);
    }
    console.log('Module wiring passed: compiled providers resolve with one owner; jobs were not bootstrapped.');
  } finally {
    try {
      if (app) {
        const database = app.get(DRIZZLE_DATABASE);
        try { await app.close(); } finally { await database.$client.end(); }
      }
    } finally {
      clearTimeout(deadline);
      // Only remove the directory created by this invocation, never an input
      // environment path or the user's persistent native-agent directory.
      const expectedPrefix = path.join(os.tmpdir(), 'squabble-module-wiring-');
      assert.ok(path.resolve(temporaryRoot).startsWith(path.resolve(expectedPrefix)));
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error);
  // A failed provider factory can leave a pool alive before Nest returns an
  // application handle. This isolated CLI must still finish with a failure.
  process.exit(1);
});
