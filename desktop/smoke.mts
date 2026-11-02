import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
  log = createWriteStream(join(paths.logsDir, 'backend.log'), { flags: 'a' });
  server = spawn(process.execPath, [paths.serverEntry], {
    cwd: paths.resourceRoot,
    env: nestEnvironment(paths, secrets, database.connectionUrl, port),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout?.pipe(log, { end: false });
  server.stderr?.pipe(log, { end: false });
  await waitForHealth(origin, 45_000);
  const administrator = database.database.getPgClient('portfolio', '127.0.0.1');
  await administrator.connect();
  try {
    const count = await administrator.query('SELECT count(*)::int AS count FROM users');
    assert.equal(count.rows[0].count, 0, 'fresh desktop data must have no demo user');
  } finally {
    await administrator.end();
  }
  const status = await fetch(`${origin}/api/auth/registration-status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).registrationOpen, true);
  const anonymousAgents = await fetch(`${origin}/api/settings/local-agents/status`);
  assert.equal(anonymousAgents.status, 401, 'native agent settings require an authenticated account');
  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'desktop-smoke', password: secrets.jwtSecret, displayName: 'Desktop Smoke' }),
  });
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
  const localAgents = await fetch(`${origin}/api/settings/local-agents/status`, {
    headers: { Authorization: `Bearer ${firstUser.accessToken}` },
  });
  assert.equal(localAgents.status, 200);
  const localStatus = await localAgents.json() as { mode: string; items: { provider: string }[] };
  assert.equal(localStatus.mode, 'native', 'desktop exposes direct native execution');
  assert.deepEqual(localStatus.items.map((item) => item.provider).sort(), ['claude', 'codex']);
  const denied = await fetch(`${origin}/api/health`, { headers: { Origin: 'https://wrong.example' } });
  assert.equal(denied.status, 403);
  process.stdout.write('Desktop smoke: database, API, two registrations, native agent catalog/auth, and origin guard passed.\n');
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
