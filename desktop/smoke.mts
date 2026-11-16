/**
 * smoke.mts — 桌面端烟测脚本（npm run desktop:smoke）：临时数据目录里把"数据库+后端 API"整体拉起，
 * 校验全新桌面的首启契约后清理退出。
 *
 * 职责边界：
 *  - 在 OS 临时目录建数据根，复用 runtime.mjs 启动内嵌 PostgreSQL 与后端子进程。
 *  - 依次断言：users 表为空、注册开放、本地 Agent 设置匿名 401、首/第二个用户均可注册且 id 不同、
 *    本地 Agent 目录（native 模式与 provider 清单）、错误 Origin 被回环护栏 403 拒绝。
 *  - finally 里停后端（5 秒超时）、关日志、停数据库，并校验临时目录未逃逸后删除。
 * 上下游：
 *  - 上游（谁调用）：npm script desktop:smoke（"npm run build && tsx desktop/smoke.mts"）；
 *    打包烟测另见 desktop/main.mts 的 SQUABBLE_DESKTOP_SMOKE=1 分支。
 *  - 下游（连接什么）：本机临时目录中的内嵌 PostgreSQL 与后端 HTTP（127.0.0.1 随机端口）。
 * 关键约定：
 *  - 进程模型：脚本自身是测试进程，后端 NestJS 是它 spawn 的子进程；与 desktop/main.mts 的
 *    Electron 烟测分支互不影响。
 *  - import 全部取自 ./runtime.mjs（tsc 构建产物），与主程序运行路径一致。
 *  - 该文件被 desktop/tsconfig.json 排除（不进 dist），只能经 tsx 直接运行。
 */
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
  // 在临时数据根里准备机密、启动数据库，并以与桌面主进程完全相同的环境变量 spawn 后端。
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
  // 全新桌面数据必须没有演示用户：直接查库数 users 行数。
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
  assert.equal(
    anonymousAgents.status,
    401,
    'native agent settings require an authenticated account',
  );
  // 首个与第二个用户都能注册且 id 互不相同（桌面注册不因首用户而关闭）。
  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'desktop-smoke',
      password: secrets.jwtSecret,
      displayName: 'Desktop Smoke',
    }),
  });
  assert.equal(registered.status, 201, 'the first desktop user can create an account');
  const open = await fetch(`${origin}/api/auth/registration-status`);
  assert.equal(
    (await open.json()).registrationOpen,
    true,
    'desktop registration remains open after the first user',
  );
  const second = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'desktop-second',
      password: secrets.jwtSecret,
      displayName: 'Second Desktop User',
    }),
  });
  assert.equal(second.status, 201, 'a second desktop user can create an account');
  const secondUser = (await second.json()) as { user: { id: string } };
  const firstUser = (await registered.json()) as { user: { id: string }; accessToken: string };
  assert.notEqual(secondUser.user.id, firstUser.user.id, 'desktop accounts remain distinct');
  // 登录后的本地 Agent 状态：native 模式 + 固定的 provider 目录清单。
  const localAgents = await fetch(`${origin}/api/settings/local-agents/status`, {
    headers: { Authorization: `Bearer ${firstUser.accessToken}` },
  });
  assert.equal(localAgents.status, 200);
  const localStatus = (await localAgents.json()) as { mode: string; items: { provider: string }[] };
  assert.equal(localStatus.mode, 'native', 'desktop exposes direct native execution');
  assert.deepEqual(localStatus.items.map((item) => item.provider).sort(), [
    'antigravity',
    'claude',
    'codex',
    'doubao',
    'gemini',
    'kimi',
    'opencode',
  ]);
  // 回环护栏：来自错误 Origin 的 API 请求必须被 403 拒绝。
  const denied = await fetch(`${origin}/api/health`, {
    headers: { Origin: 'https://wrong.example' },
  });
  assert.equal(denied.status, 403);
  process.stdout.write(
    'Desktop smoke: database, API, two registrations, native agent catalog/auth, and origin guard passed.\n',
  );
} finally {
  // 无论成败都要收尾：停后端（5 秒兜底）→ 关日志 → 停数据库 → 校验目录未逃逸后删除临时数据根。
  if (server) {
    const child = server;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  }
  log?.end();
  await database?.stop();
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
    throw new Error('Smoke directory escaped temporary root');
  await rm(directory, { recursive: true, force: true });
}
