import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export interface DesktopSecrets {
  databasePassword: string;
  jwtSecret: string;
  settingsEncryptionKey: string;
}

export interface DesktopPaths {
  databaseDir: string;
  secretsFile: string;
  serverPortFile: string;
  logsDir: string;
  schemaFile: string;
  serverEntry: string;
  resourceRoot: string;
}

export function desktopPaths(resourceRoot: string, dataRoot: string): DesktopPaths {
  return {
    databaseDir: join(dataRoot, 'postgres'),
    secretsFile: join(dataRoot, 'secrets.json'),
    serverPortFile: join(dataRoot, 'server-port'),
    logsDir: join(dataRoot, 'logs'),
    schemaFile: join(resourceRoot, 'scripts', 'db', '01_schema.sql'),
    serverEntry: join(resourceRoot, 'dist', 'server', 'main.js'),
    resourceRoot,
  };
}

function validSecrets(value: unknown): value is DesktopSecrets {
  if (!value || typeof value !== 'object') return false;
  const secrets = value as Record<string, unknown>;
  const values: unknown[] = [secrets.databasePassword, secrets.jwtSecret, secrets.settingsEncryptionKey];
  return values.every((item: unknown) => typeof item === 'string' && /^[0-9a-f]{64}$/u.test(item))
    && new Set(values).size === 3;
}

export async function loadOrCreateSecrets(file: string): Promise<DesktopSecrets> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    const existing: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!validSecrets(existing)) throw new Error('Invalid desktop secrets file');
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw new Error('Invalid desktop secrets file', { cause: error });
      throw error;
    }
  }

  const secrets: DesktopSecrets = {
    databasePassword: randomBytes(32).toString('hex'),
    jwtSecret: randomBytes(32).toString('hex'),
    settingsEncryptionKey: randomBytes(32).toString('hex'),
  };
  try {
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(secrets)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    return secrets;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (validSecrets(existing)) return existing;
      throw new Error('Invalid desktop secrets file');
    }
    throw error;
  }
}

export async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not allocate loopback port');
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function portAvailable(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    return true;
  } catch (error) {
    if (['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function loadOrCreateServerPort(file: string): Promise<number> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    const existing: number = Number((await readFile(file, 'utf8')).trim());
    if (Number.isInteger(existing) && existing >= 1024 && existing <= 65535
      && await portAvailable(existing)) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const replacement: number = await allocateLoopbackPort();
  await writeFile(file, `${replacement}\n`, { mode: 0o600 });
  return replacement;
}

export async function waitForHealth(origin: string, timeoutMs: number): Promise<void> {
  const deadline: number = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response: Response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const body: unknown = await response.json();
        if (body && typeof body === 'object' && 'status' in body && body.status === 'ok') return;
      }
    } catch {
      // Startup may not have opened the listener yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Squabble backend did not become healthy in time');
}

export function nestEnvironment(
  paths: DesktopPaths,
  secrets: DesktopSecrets,
  databaseUrl: string,
  serverPort: number,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: String(serverPort),
    SQUABBLE_DESKTOP_ORIGIN: `http://127.0.0.1:${serverPort}`,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: secrets.jwtSecret,
    SETTINGS_ENCRYPTION_KEY: secrets.settingsEncryptionKey,
    REGISTER_ENABLED: 'true',
    AGENT_GATEWAY_ENABLED: 'false',
    TRUST_PROXY: 'false',
    LOG_DIR: paths.logsDir,
  };
}

async function controlBinary(): Promise<string> {
  const packageName: string = process.platform === 'win32'
    ? '@embedded-postgres/windows-x64'
    : process.arch === 'arm64' ? '@embedded-postgres/darwin-arm64' : '@embedded-postgres/darwin-x64';
  const binaries: unknown = await import(packageName);
  if (!binaries || typeof binaries !== 'object' || !('pg_ctl' in binaries)
    || typeof binaries.pg_ctl !== 'string') {
    throw new Error('Bundled PostgreSQL control binary is missing');
  }
  return binaries.pg_ctl;
}

async function samePath(left: string, right: string): Promise<boolean> {
  const [normalizedLeft, normalizedRight] = await Promise.all([realpath(left), realpath(right)]);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function releaseExistingCluster(paths: DesktopPaths, secrets: DesktopSecrets): Promise<void> {
  let pidFile: string;
  try {
    pidFile = await readFile(join(paths.databaseDir, 'postmaster.pid'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const [pidText, dataDirectory, , portText] = pidFile.split(/\r?\n/u);
  const pid = Number(pidText);
  const port = Number(portText);
  if (!Number.isInteger(pid) || pid <= 0 || !dataDirectory || !(await samePath(dataDirectory, paths.databaseDir))
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Existing desktop PostgreSQL PID file does not match its private data directory');
  }

  const client = new pg.Client({
    host: '127.0.0.1', port, database: 'postgres', user: 'squabble',
    password: secrets.databasePassword, connectionTimeoutMillis: 2_000, ssl: false,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const result = await client.query('SHOW data_directory');
    const activeDirectory: unknown = result.rows[0]?.data_directory;
    if (typeof activeDirectory !== 'string' || !(await samePath(activeDirectory, paths.databaseDir))) {
      throw new Error('Existing PostgreSQL process uses another data directory');
    }
  } catch (error) {
    if (!connected && ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return; // The PID file is stale; PostgreSQL removes it during startup.
    }
    throw error;
  } finally {
    if (connected) await client.end();
  }
  const pgCtl = await controlBinary();
  await promisify(execFile)(pgCtl, ['-D', paths.databaseDir, '-m', 'fast', '-w', 'stop'], {
    windowsHide: true, timeout: 20_000,
  });
}

async function applyBaseSchema(database: EmbeddedPostgres, schemaFile: string): Promise<void> {
  const administrator = database.getPgClient('postgres', '127.0.0.1');
  await administrator.connect();
  try {
    const present = await administrator.query("SELECT 1 FROM pg_database WHERE datname = 'portfolio'");
    if (present.rowCount === 0) await administrator.query('CREATE DATABASE portfolio');
  } finally {
    await administrator.end();
  }

  const portfolio = database.getPgClient('portfolio', '127.0.0.1');
  await portfolio.connect();
  try {
    const migrations = (await readdir(dirname(schemaFile)))
      .map((name) => ({ name, version: Number(/^([0-9]{2})_.*\.sql$/u.exec(name)?.[1] ?? 0) }))
      .filter(({ version }) => version >= 3)
      .sort((left, right) => left.version - right.version);
    for (let version = 3; version <= (migrations.at(-1)?.version ?? 2); version += 1) {
      if (!migrations.some((migration) => migration.version === version)) {
        throw new Error(`Missing desktop database migration ${version}`);
      }
    }
    const marker = await portfolio.query("SELECT to_regclass('public.desktop_installation') AS name");
    let installedVersion: number;
    if (marker.rows[0]?.name) {
      const version = await portfolio.query('SELECT version FROM desktop_installation');
      installedVersion = version.rows[0]?.version;
      if (!Number.isInteger(installedVersion) || installedVersion < 1
        || installedVersion > (migrations.at(-1)?.version ?? 1)) {
        throw new Error('Unsupported desktop database schema version');
      }
    } else {
      const schema: string = await readFile(schemaFile, 'utf8');
      await portfolio.query('BEGIN');
      try {
        await portfolio.query(schema);
        await portfolio.query('CREATE TABLE desktop_installation (version integer PRIMARY KEY)');
        await portfolio.query('INSERT INTO desktop_installation (version) VALUES (1)');
        await portfolio.query('COMMIT');
      } catch (error) {
        await portfolio.query('ROLLBACK');
        throw error;
      }
      installedVersion = 1;
    }
    for (const migration of migrations) {
      if (migration.version <= installedVersion) continue;
      const sql = await readFile(join(dirname(schemaFile), migration.name), 'utf8');
      await portfolio.query('BEGIN');
      try {
        await portfolio.query(sql);
        await portfolio.query('UPDATE desktop_installation SET version = $1', [migration.version]);
        await portfolio.query('COMMIT');
      } catch (error) {
        await portfolio.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await portfolio.end();
  }
}

export interface DesktopDatabase {
  database: EmbeddedPostgres;
  connectionUrl: string;
  stop(): Promise<void>;
}

export function formatDatabaseStartupError(
  error: unknown,
  postgresOutput: string,
  secrets: DesktopSecrets,
  exitCode?: number | null,
): Error {
  const reason = error === undefined ? 'PostgreSQL process exited before readiness'
    : error instanceof Error ? error.message : String(error);
  const code = exitCode == null ? '' : ` (exit code ${exitCode})`;
  const output = postgresOutput.trim().slice(-4_000) || '(no PostgreSQL output captured)';
  let message = `Desktop database startup failed: ${reason}${code}\nPostgreSQL output:\n${output}`;
  for (const secret of Object.values(secrets)) message = message.replaceAll(secret, '[redacted]');
  return new Error(message, { cause: error });
}

export async function startDesktopDatabase(paths: DesktopPaths, secrets: DesktopSecrets): Promise<DesktopDatabase> {
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  const log = createWriteStream(join(paths.logsDir, 'postgres.log'), { flags: 'a', mode: 0o600 });
  log.on('error', () => undefined);
  let recentOutput = '';
  const writeLog = (message: string): void => {
    recentOutput = (recentOutput + message).slice(-8_000);
    log.write(message);
  };
  const port: number = await allocateLoopbackPort();
  const database = new EmbeddedPostgres({
    databaseDir: paths.databaseDir,
    port,
    user: 'squabble',
    password: secrets.databasePassword,
    authMethod: 'scram-sha-256',
    persistent: true,
    autoRehydrateSymlinks: false,
    initdbFlags: ['--encoding=UTF8'],
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories='],
    onLog: writeLog,
    onError: (error: unknown) => { writeLog(`${String(error)}\n`); },
  });
  let started = false;
  const stop = async (): Promise<void> => {
    if (!started) return;
    started = false;
    try {
      const pgCtl: string = await controlBinary();
      await promisify(execFile)(pgCtl, ['-D', paths.databaseDir, '-m', 'fast', '-w', 'stop'], {
        windowsHide: true,
        timeout: 20_000,
      });
      Reflect.set(database, 'process', undefined);
    } finally {
      log.end();
    }
  };
  try {
    try {
      await stat(join(paths.databaseDir, 'PG_VERSION'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await database.initialise();
    }
    await releaseExistingCluster(paths, secrets);
    await database.start();
    started = true;
    await applyBaseSchema(database, paths.schemaFile);
    const connectionUrl = `postgres://squabble:${encodeURIComponent(secrets.databasePassword)}@127.0.0.1:${port}/portfolio`;
    return { database, connectionUrl, stop };
  } catch (error) {
    const postgresProcess = Reflect.get(database, 'process') as { exitCode?: number | null } | undefined;
    const exitCode = postgresProcess?.exitCode;
    if (started) await stop();
    else {
      Reflect.set(database, 'process', undefined);
      log.end();
    }
    throw formatDatabaseStartupError(error, recentOutput, secrets, exitCode);
  }
}
