import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  desktopPaths,
  loadOrCreateSecrets,
  loadOrCreateServerPort,
  nestEnvironment,
  startDesktopDatabase,
  waitForHealth,
} from './runtime.mjs';

const directory = await mkdtemp(join(tmpdir(), 'squabble-desktop-smoke-'));
const paths = desktopPaths(resolve('.'), directory);
let database: Awaited<ReturnType<typeof startDesktopDatabase>> | null = null;
let server: ReturnType<typeof spawn> | null = null;
let log: ReturnType<typeof createWriteStream> | null = null;

try {
  const secrets = await loadOrCreateSecrets(paths.secretsFile);
  database = await startDesktopDatabase(paths, secrets);
  const port = await loadOrCreateServerPort(paths.serverPortFile);
  const origin = `http://127.0.0.1:${port}`;
  const environment = nestEnvironment(paths, secrets, database.connectionUrl, port);
  // This disposable database must never inherit a personal workspace selection.
  environment.LOCAL_WORKSPACE_USER_ID = '';
  const localMode = environment.AUTH_MODE === 'local';
  log = createWriteStream(join(paths.logsDir, 'backend.log'), { flags: 'a' });
  server = spawn(process.execPath, [paths.serverEntry], {
    cwd: paths.resourceRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout?.pipe(log, { end: false });
  server.stderr?.pipe(log, { end: false });
  try {
    await Promise.race([
      waitForHealth(origin, 45_000),
      new Promise<never>((_resolve, reject) => {
        server?.once('error', reject);
        server?.once('exit', (code) => reject(new Error(`Smoke backend exited during startup: ${code}`)));
      }),
    ]);
  } catch (error) {
    let diagnostic = (await readFile(join(paths.logsDir, 'backend.log'), 'utf8')).slice(-8_000);
    for (const secret of Object.values(secrets)) diagnostic = diagnostic.replaceAll(secret, '[redacted]');
    throw new Error(`Desktop smoke backend startup failed:\n${diagnostic}`, { cause: error });
  }
  const administrator = database.database.getPgClient('portfolio', '127.0.0.1');
  await administrator.connect();
  try {
    const users = await administrator.query('SELECT username FROM users');
    assert.deepEqual(users.rows, localMode ? [{ username: 'local-workspace' }] : [],
      'fresh desktop data has only its internal local identity, or no account-mode users');
  } finally {
    await administrator.end();
  }
  const mode = await fetch(`${origin}/api/auth/mode`);
  assert.equal(mode.status, 200);
  assert.equal((await mode.json()).mode, environment.AUTH_MODE);
  const status = await fetch(`${origin}/api/auth/registration-status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).registrationOpen, !localMode);
  const profile = await fetch(`${origin}/api/auth/me`);
  assert.equal(profile.status, localMode ? 200 : 401, 'only local mode opens a workspace without a token');
  const anonymousAgents = await fetch(`${origin}/api/settings/local-agents/status`);
  assert.equal(anonymousAgents.status, localMode ? 200 : 401,
    'local workspace native settings are accessible without a Squabble account');
  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'desktop-smoke', password: secrets.jwtSecret, displayName: 'Desktop Smoke' }),
  });
  let localAgents = anonymousAgents;
  if (localMode) {
    assert.equal(registered.status, 403, 'local workspace mode disables account registration');
  } else {
    assert.equal(registered.status, 201, 'the first desktop user can create an account');
    const open = await fetch(`${origin}/api/auth/registration-status`);
    assert.equal((await open.json()).registrationOpen, true, 'desktop registration remains open after the first user');
    const second = await fetch(`${origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'desktop-second', password: secrets.jwtSecret, displayName: 'Second Desktop User' }),
    });
    assert.equal(second.status, 201, 'a second desktop user can create an account');
    const secondUser = await second.json() as { user: { id: string } };
    const firstUser = await registered.json() as { user: { id: string }; accessToken: string };
    assert.notEqual(secondUser.user.id, firstUser.user.id, 'desktop accounts remain distinct');
    localAgents = await fetch(`${origin}/api/settings/local-agents/status`, {
      headers: { Authorization: `Bearer ${firstUser.accessToken}` },
    });
  }
  assert.equal(localAgents.status, 200);
  const localStatus = await localAgents.json() as { mode: string; items: { provider: string }[] };
  assert.equal(localStatus.mode, 'native', 'desktop exposes direct native execution');
  assert.deepEqual(localStatus.items.map((item) => item.provider).sort(),
    ['antigravity', 'claude', 'codex', 'doubao', 'gemini', 'kimi', 'opencode']);
  const denied = await fetch(`${origin}/api/health`, { headers: { Origin: 'https://wrong.example' } });
  assert.equal(denied.status, 403);
  process.stdout.write(`Desktop smoke: database, API, ${localMode ? 'local workspace entry' : 'two account registrations'}, native agent catalog, and origin guard passed.\n`);
} finally {
  if (server) {
    const child = server;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  }
  log?.end();
  await database?.stop();
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Smoke directory escaped temporary root');
  await rm(directory, { recursive: true, force: true });
}
