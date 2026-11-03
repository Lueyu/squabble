import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const runtimePromise = import('./runtime.mts').catch(() => null);

async function removeTestDirectory(directory: string): Promise<void> {
  const root = resolve(tmpdir()) + sep;
  if (!resolve(directory).startsWith(root)) throw new Error('Test directory escaped temporary root');
  await rm(directory, { recursive: true, force: true });
}

async function stopTestCluster(directory: string): Promise<void> {
  let pidFile: string;
  try {
    pidFile = await readFile(join(directory, 'postgres', 'postmaster.pid'), 'utf8');
  } catch {
    return;
  }
  const pid = Number(pidFile.split('\n')[0]);
  const nativePackage = process.platform === 'win32' ? '@embedded-postgres/windows-x64'
    : process.arch === 'arm64' ? '@embedded-postgres/darwin-arm64' : '@embedded-postgres/darwin-x64';
  const binaries = await import(nativePackage) as { pg_ctl: string };
  try {
    await promisify(execFile)(binaries.pg_ctl, ['-D', join(directory, 'postgres'), '-m', 'fast', '-w', 'stop'], {
      windowsHide: true, timeout: 20_000,
    });
  } catch (error) {
    try {
      process.kill(pid, 0);
    } catch (lookupError) {
      if ((lookupError as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw lookupError;
    }
    throw new Error('Private test PostgreSQL process is still running', { cause: error });
  }
}

test('desktop paths keep mutable data apart from packaged resources', async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.desktopPaths);
  const paths = runtime.desktopPaths('C:\\Program Files\\Squabble\\resources\\app', 'C:\\Users\\alice\\AppData\\Roaming\\Squabble');
  assert.equal(paths.databaseDir, join('C:\\Users\\alice\\AppData\\Roaming\\Squabble', 'postgres'));
  assert.equal(paths.secretsFile, join('C:\\Users\\alice\\AppData\\Roaming\\Squabble', 'secrets.json'));
  assert.equal(paths.schemaFile, join('C:\\Program Files\\Squabble\\resources\\app', 'scripts', 'db', '01_schema.sql'));
  assert.equal(paths.serverEntry, join('C:\\Program Files\\Squabble\\resources\\app', 'dist', 'server', 'main.js'));
});

test('desktop secrets are independent and stable across restarts', async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.loadOrCreateSecrets);
  const directory = await mkdtemp(join(tmpdir(), 'squabble-desktop-secrets-'));
  try {
    const file = join(directory, 'private', 'secrets.json');
    const first = await runtime.loadOrCreateSecrets(file);
    const second = await runtime.loadOrCreateSecrets(file);
    assert.deepEqual(second, first);
    assert.match(first.databasePassword, /^[0-9a-f]{64}$/u);
    assert.match(first.jwtSecret, /^[0-9a-f]{64}$/u);
    assert.match(first.settingsEncryptionKey, /^[0-9a-f]{64}$/u);
    assert.equal(new Set(Object.values(first)).size, 3);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), first);
  } finally {
    await removeTestDirectory(directory);
  }
});

test('desktop rejects damaged secrets instead of rotating the database password', async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.loadOrCreateSecrets);
  const directory = await mkdtemp(join(tmpdir(), 'squabble-desktop-secrets-'));
  try {
    const file = join(directory, 'secrets.json');
    await writeFile(file, '{"databasePassword":"short"}');
    await assert.rejects(runtime.loadOrCreateSecrets(file), /secret/i);
  } finally {
    await removeTestDirectory(directory);
  }
});

test('desktop startup errors retain PostgreSQL diagnostics without exposing secrets', async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.formatDatabaseStartupError);
  const secrets = {
    databasePassword: 'a'.repeat(64), jwtSecret: 'b'.repeat(64), settingsEncryptionKey: 'c'.repeat(64),
  };
  const failure = runtime.formatDatabaseStartupError(undefined,
    `FATAL: missing library\npassword=${secrets.databasePassword}\n`, secrets, 2);
  assert.match(failure.message, /PostgreSQL process exited before readiness/u);
  assert.match(failure.message, /FATAL: missing library/u);
  assert.match(failure.message, /exit code 2/u);
  for (const secret of Object.values(secrets)) assert.ok(!failure.message.includes(secret));
});

test('desktop server environment binds both services to loopback and keeps registration open', async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.nestEnvironment);
  const paths = runtime.desktopPaths('C:\\Squabble', 'C:\\SquabbleData');
  const environment = runtime.nestEnvironment(paths, {
    databasePassword: 'a'.repeat(64), jwtSecret: 'b'.repeat(64), settingsEncryptionKey: 'c'.repeat(64),
  }, 'postgres://squabble:secret@127.0.0.1:5432/portfolio', 41234);
  assert.equal(environment.SERVER_HOST, '127.0.0.1');
  assert.equal(environment.SERVER_PORT, '41234');
  assert.equal(environment.REGISTER_ENABLED, 'true');
  assert.equal(environment.SQUABBLE_DESKTOP_ORIGIN, 'http://127.0.0.1:41234');
  assert.equal(environment.NODE_ENV, 'production');
  assert.equal(environment.JWT_SECRET, 'b'.repeat(64));
  assert.equal(environment.LOCAL_AGENTS_MODE, 'native');
  assert.equal(environment.LOCAL_AGENTS_DATA_DIR, join('C:\\SquabbleData', 'local-agents'));
});

test('embedded PostgreSQL creates a clean portfolio and reuses it after a clean stop', { timeout: 120_000 }, async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.startDesktopDatabase);
  const directory = await mkdtemp(join(tmpdir(), 'squabble-desktop-db-'));
  const paths = runtime.desktopPaths(resolve('.'), directory);
  const secrets = await runtime.loadOrCreateSecrets(paths.secretsFile);
  let first: Awaited<ReturnType<typeof runtime.startDesktopDatabase>> | undefined;
  let second: Awaited<ReturnType<typeof runtime.startDesktopDatabase>> | undefined;
  try {
    first = await runtime.startDesktopDatabase(paths, secrets);
    const client = first.database.getPgClient('portfolio', '127.0.0.1');
    await client.connect();
    try {
      const users = await client.query('SELECT count(*)::int AS count FROM users');
      assert.equal(users.rows[0].count, 0);
      const migration = await client.query('SELECT version FROM desktop_installation');
      assert.equal(migration.rows[0].version, 18);
      const latestColumn = await client.query("SELECT enabled FROM llm_budget_settings LIMIT 0");
      assert.deepEqual(latestColumn.rows, []);
      const strategyTables = await client.query(`SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN
          ('strategy_tasks', 'strategy_plans', 'strategy_signals', 'strategy_runtime', 'strategy_outbox', 'strategy_protections')
        ORDER BY table_name`);
      assert.deepEqual(strategyTables.rows.map((row: { table_name: string }) => row.table_name),
        ['strategy_outbox', 'strategy_plans', 'strategy_protections', 'strategy_runtime', 'strategy_signals', 'strategy_tasks']);
      const protectionColumns = await client.query(`SELECT column_name, data_type, column_default
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'strategy_protections'
          AND column_name IN ('stop_loss_price', 'version') ORDER BY column_name`);
      assert.deepEqual(protectionColumns.rows, [
        { column_name: 'stop_loss_price', data_type: 'numeric', column_default: null },
        { column_name: 'version', data_type: 'integer', column_default: '1' },
      ]);
      await client.query('CREATE TABLE desktop_persistence_probe (value text NOT NULL)');
      await client.query("INSERT INTO desktop_persistence_probe (value) VALUES ('saved')");
      await client.query(`WITH profile AS (
        INSERT INTO builder_profiles (owner, config) VALUES ('desktop-native-probe', '{}') RETURNING id
      ), session AS (
        INSERT INTO council_sessions (owner, profile_id, profile_version, profile_snapshot, ticker)
        SELECT 'desktop-native-probe', id, 1, '{}', 'DEMO' FROM profile RETURNING id
      ) INSERT INTO council_reports
        (owner, session_id, version, revision, decision, summary, dissent, next_review_condition, evidence, engine)
        SELECT 'desktop-native-probe', id, 1, 1, 'wait', 'Fixture report', '[]', 'Fixture review', '[]', 'local'
        FROM session`);
      await client.query(`INSERT INTO strategy_outbox (owner, profile_id, event_key, payload, delivered_channel_ids)
        SELECT 'desktop-native-probe', id, 'desktop-migration-16-probe', '{"event":"strategy_error"}', '["fixture-channel"]'
        FROM builder_profiles WHERE owner = 'desktop-native-probe'`);
    } finally {
      await client.end();
    }
    await first.stop();
    first = undefined;
    await assert.rejects(stat(join(paths.databaseDir, 'postmaster.pid')), { code: 'ENOENT' });

    const pidFile = join(paths.databaseDir, 'postmaster.pid');
    await writeFile(pidFile, `123\n${directory}\n0\n5432\n`);
    await assert.rejects(runtime.startDesktopDatabase(paths, secrets), /private data directory/u);
    await rm(pidFile);

    second = await runtime.startDesktopDatabase(paths, secrets);
    const reopened = second.database.getPgClient('portfolio', '127.0.0.1');
    await reopened.connect();
    try {
      const rows = await reopened.query('SELECT value FROM desktop_persistence_probe');
      assert.equal(rows.rows[0].value, 'saved');
      // The backend also reapplies additive migrations at startup.
      await reopened.query(await readFile(join(resolve('.'), 'scripts', 'db', '14_a2a_agents.sql'), 'utf8'));
      await reopened.query(await readFile(join(resolve('.'), 'scripts', 'db', '15_native_agents.sql'), 'utf8'));
      await reopened.query(await readFile(join(resolve('.'), 'scripts', 'db', '16_daily_strategy.sql'), 'utf8'));
      const report = await reopened.query("SELECT engine FROM council_reports WHERE owner = 'desktop-native-probe'");
      assert.equal(report.rows[0].engine, 'local');
      const delivery = await reopened.query(`SELECT state, attempts, payload, delivered_channel_ids
        FROM strategy_outbox WHERE event_key = 'desktop-migration-16-probe'`);
      assert.deepEqual(delivery.rows, [{ state: 'pending', attempts: 0,
        payload: { event: 'strategy_error' }, delivered_channel_ids: ['fixture-channel'] }]);
    } finally {
      await reopened.end();
    }
    await second.stop();
    second = undefined;
    second = await runtime.startDesktopDatabase(paths, secrets);
    const restarted = second.database.getPgClient('portfolio', '127.0.0.1');
    await restarted.connect();
    try {
      const report = await restarted.query("SELECT engine FROM council_reports WHERE owner = 'desktop-native-probe'");
      assert.equal(report.rows[0].engine, 'local');
      const delivery = await restarted.query(`SELECT delivered_channel_ids FROM strategy_outbox
        WHERE event_key = 'desktop-migration-16-probe'`);
      assert.deepEqual(delivery.rows, [{ delivered_channel_ids: ['fixture-channel'] }]);
    } finally { await restarted.end(); }
  } finally {
    await second?.stop();
    await first?.stop();
    await removeTestDirectory(directory);
  }
});

test('desktop recovers a private PostgreSQL cluster after its owner is force killed', { timeout: 120_000 }, async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.startDesktopDatabase);
  const directory = await mkdtemp(join(tmpdir(), 'squabble-desktop-crash-'));
  const paths = runtime.desktopPaths(resolve('.'), directory);
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('desktop/crash-child.helper.ts'), directory], {
    cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  const childExited = new Promise<void>((done) => {
    child.once('exit', () => done());
    child.once('error', () => done());
  });
  let childError: Error | undefined;
  child.once('error', (error) => { childError = error; });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  let recovered: Awaited<ReturnType<typeof runtime.startDesktopDatabase>> | undefined;
  try {
    const ready = join(directory, 'ready');
    for (let attempt = 0; attempt < 600; attempt += 1) {
      try { await stat(ready); break; } catch { /* startup in progress */ }
      if (childError) throw childError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Crash child exited early: ${stderr}`);
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    await stat(ready);
    const oldPostmaster = Number((await readFile(join(paths.databaseDir, 'postmaster.pid'), 'utf8')).split('\n')[0]);
    assert.ok(oldPostmaster > 0);
    assert.equal(child.kill('SIGKILL'), true);
    await childExited;
    assert.ok((await stat(join(paths.databaseDir, 'postmaster.pid'))).isFile());

    const secrets = await runtime.loadOrCreateSecrets(paths.secretsFile);
    recovered = await runtime.startDesktopDatabase(paths, secrets);
    const client = recovered.database.getPgClient('portfolio', '127.0.0.1');
    await client.connect();
    try {
      const version = await client.query('SELECT version FROM desktop_installation');
      assert.equal(version.rows[0].version, 18);
    } finally {
      await client.end();
    }
  } finally {
    await recovered?.stop();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await stopTestCluster(directory);
    await removeTestDirectory(directory);
  }
});

test('desktop reclaims an active private PostgreSQL cluster before starting another', { timeout: 120_000 }, async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.startDesktopDatabase);
  const directory = await mkdtemp(join(tmpdir(), 'squabble-desktop-orphan-'));
  const paths = runtime.desktopPaths(resolve('.'), directory);
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('desktop/crash-child.helper.ts'), directory], {
    cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  const childExited = new Promise<void>((done) => {
    child.once('exit', () => done());
    child.once('error', () => done());
  });
  let childError: Error | undefined;
  child.once('error', (error) => { childError = error; });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  let recovered: Awaited<ReturnType<typeof runtime.startDesktopDatabase>> | undefined;
  try {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      try { await stat(join(directory, 'ready')); break; } catch { /* startup in progress */ }
      if (childError) throw childError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Orphan owner exited early: ${stderr}`);
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    await stat(join(directory, 'ready'));
    const secrets = await runtime.loadOrCreateSecrets(paths.secretsFile);
    recovered = await runtime.startDesktopDatabase(paths, secrets);
    const client = recovered.database.getPgClient('portfolio', '127.0.0.1');
    await client.connect();
    try {
      const version = await client.query('SELECT version FROM desktop_installation');
      assert.equal(version.rows[0].version, 18);
    } finally {
      await client.end();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.race([childExited, new Promise<void>((done) => setTimeout(done, 5_000))]);
    await recovered?.stop();
    await stopTestCluster(directory);
    await removeTestDirectory(directory);
  }
});

test('allocated port is available on IPv4 loopback', async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.allocateLoopbackPort);
  const port = await runtime.allocateLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 0);
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('desktop keeps its web origin across launches and replaces a taken port', async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.loadOrCreateServerPort);
  const directory = await mkdtemp(join(tmpdir(), 'squabble-desktop-port-'));
  try {
    const file = join(directory, 'server-port');
    const first = await runtime.loadOrCreateServerPort(file);
    assert.equal(await runtime.loadOrCreateServerPort(file), first);
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(first, '127.0.0.1', resolve));
    try {
      const replacement = await runtime.loadOrCreateServerPort(file);
      assert.notEqual(replacement, first);
      assert.equal(Number((await readFile(file, 'utf8')).trim()), replacement);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  } finally {
    await removeTestDirectory(directory);
  }
});

test('readiness waits for a healthy API response', async () => {
  const runtime = await runtimePromise;
  assert.ok(runtime?.waitForHealth);
  let checks = 0;
  const server = createHttpServer((_request, response) => {
    checks += 1;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(checks < 2 ? { status: 'starting' } : { status: 'ok' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await runtime.waitForHealth(`http://127.0.0.1:${port}`, 3_000);
    assert.ok(checks >= 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
