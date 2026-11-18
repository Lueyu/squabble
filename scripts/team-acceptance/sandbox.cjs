const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Socket } = require('node:net');
const postgres = require('postgres');
const { installProviders } = require('./providers.cjs');

const root = resolve(__dirname, '../..');
const built = (path) => require(resolve(root, 'dist/server', path));

function sandboxUrl(raw) {
  assert.ok(raw, 'Set SQU_ACCEPTANCE_DATABASE_URL to the dedicated acceptance database');
  const url = URL.parse(raw);
  assert.ok(url && ['postgres:', 'postgresql:'].includes(url.protocol) &&
    url.host === '127.0.0.1:55491' && url.pathname === '/squ_acceptance_test' &&
    url.username && !url.search && !url.hash,
  'Expected a PostgreSQL URL for 127.0.0.1:55491/squ_acceptance_test without parameters');
  return url;
}

function restrictSockets(ports) {
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function (options, ...rest) {
    const target = Array.isArray(options) ? options[0] : options;
    const host = typeof target === 'object' ? target.host : rest[0];
    const port = typeof target === 'object' ? target.port : target;
    assert.ok(host === '127.0.0.1' && ports.has(Number(port)), 'Acceptance blocked an unexpected socket connection');
    return connect.call(this, options, ...rest);
  };
  return () => { Socket.prototype.connect = connect; };
}

function configureEnvironment(url, dataDirectory) {
  const osVariables = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|USERPROFILE|USERDOMAIN|USERNAME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|TMP|TEMP|TMPDIR|LANG|LC_ALL|PLAYWRIGHT_BROWSERS_PATH)$/iu;
  for (const key of Object.keys(process.env)) {
    if (!osVariables.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DATABASE_URL: url.href,
    DB_POOL_MAX: '4',
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: '0',
    AUTH_MODE: 'account',
    REGISTER_ENABLED: 'true',
    JWT_SECRET: randomBytes(32).toString('hex'),
    SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    SQUABBLE_SIMPLE_EXPERIENCE: 'true',
    TEAM_WORKSPACE_ENABLED: 'true',
    TEAM_RESEARCH_ENABLED: 'true',
    PAPER_TRADING_ENABLED: 'true',
    LOCAL_AGENTS_MODE: 'companion',
    LOCAL_AGENTS_DATA_DIR: dataDirectory,
  });
}

async function startSandbox(rawUrl, output) {
  assert.equal(resolve(process.cwd()), root, 'Run the harness from its own checkout');
  assert.ok(existsSync(resolve(root, 'dist/client/index.html')), 'Run npm run build:web first');
  assert.ok(existsSync(resolve(root, 'dist/server/main.js')), 'Run npm run build:web first');
  const url = sandboxUrl(rawUrl);
  const schema = 'acceptance_' + randomBytes(8).toString('hex');
  const dataDirectory = resolve(output, 'private');
  mkdirSync(dataDirectory, { recursive: true });
  url.searchParams.set('search_path', schema);
  url.searchParams.set('client_min_messages', 'warning');
  configureEnvironment(url, dataDirectory);
  const ports = new Set([55491]);
  const releaseSockets = restrictSockets(ports);
  const providers = installProviders();
  const sql = postgres(url.href, { max: 1, connect_timeout: 4, onnotice: () => {} });
  let app;
  let database;
  let schemaCreated = false;

  async function close() {
    try {
      await app?.close();
    } finally {
      try {
        await database?.$client.end({ timeout: 5 });
        if (schemaCreated) await sql`drop schema ${sql(schema)} cascade`;
      } finally {
        await sql.end({ timeout: 5 });
        providers.restore();
        releaseSockets();
      }
    }
  }

  try {
    const [identity] = await sql`select current_database() as name, host(inet_server_addr()) as address, inet_server_port() as port`;
    assert.deepEqual({ ...identity }, { name: 'squ_acceptance_test', address: '127.0.0.1', port: 55491 });
    await sql`create schema ${sql(schema)}`;
    schemaCreated = true;
    const [location] = await sql`select current_schema() as name`;
    assert.equal(location.name, schema);
    await sql.unsafe(readFileSync(resolve(root, 'scripts/db/01_schema.sql'), 'utf8'));

    require('reflect-metadata');
    const { NestFactory } = require('@nestjs/core');
    const { DRIZZLE_DATABASE } = built('common/platform/database.provider.js');
    const { TeamRunScheduler } = built('modules/team-runs/team-run.scheduler.js');
    const { StrategyScheduler } = built('modules/paper-trading/strategy.scheduler.js');
    const { PortfolioValuationScheduler } = built('modules/experience/portfolio-valuation.scheduler.js');
    const { StrategyService } = built('modules/paper-trading/strategy.service.js');
    const { TradingMarketService } = built('modules/paper-trading/trading-market.service.js');
    const create = NestFactory.create.bind(NestFactory);
    const jobs = [TeamRunScheduler, StrategyScheduler, PortfolioValuationScheduler];
    const originalInitializers = jobs.map(job => job.prototype.onModuleInit);
    // The test advances these three jobs explicitly. Council and commission delivery keep their real lifecycles.
    jobs.forEach(job => { job.prototype.onModuleInit = () => {}; });
    let timer;
    try {
      await new Promise((ready, fail) => {
        timer = setTimeout(() => fail(new Error('Built server did not start within 30 seconds')), 30_000);
        NestFactory.create = async (module, options) => {
          try {
            app = await create(module, { ...options, abortOnError: false, logger: ['error', 'warn'] });
            database = app.get(DRIZZLE_DATABASE);
            const server = app.getHttpServer();
            server.once('error', fail);
            server.once('listening', () => {
              ports.add(server.address().port);
              ready();
            });
            return app;
          } catch (error) {
            fail(error);
            throw error;
          }
        };
        require(resolve(root, 'dist/server/main.js'));
      });
    } finally {
      clearTimeout(timer);
      NestFactory.create = create;
      jobs.forEach((job, index) => { job.prototype.onModuleInit = originalInitializers[index]; });
    }
    const [appIdentity] = await database.$client`select current_schema() as name`;
    assert.equal(appIdentity.name, schema, 'The built application must use the per-run schema');
    return {
      origin: await app.getUrl(), sql, providers, close,
      runs: app.get(TeamRunScheduler),
      valuation: app.get(PortfolioValuationScheduler),
      strategy: app.get(StrategyService),
      markets: app.get(TradingMarketService),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { sandboxUrl, startSandbox };
