#!/usr/bin/env node
'use strict';

/**
 * dev.js — 本地一键开发启动器（npm run dev）：同时监督 NestJS watch 服务端与 Vite 前端。
 *
 * 职责边界：
 *  - createDevSupervisor：读 .env/.env.local、校验端口与超时参数；用会话文件+启动锁实现
 *    "替换式重启"（发现同根旧会话就整树终止）；清理被占端口；清掉 server/shared 构建产物；
 *    监督子进程崩溃按指数退避重启（上限 MAX_RESTART_COUNT）。
 *  - loadDevelopmentEnv / cleanServerBuild 作为可导出的纯工具一并导出，供 scripts/dev.spec.cjs 单测。
 * 上下游：
 *  - 上游（谁启动）：开发者手动 `npm run dev`（package.json "dev" script）；进程内工具被
 *    scripts/dev.spec.cjs 复用。
 *  - 下游（启动谁/连接什么）：node_modules/@nestjs/cli 的 `nest start --watch`（SERVER_PORT，默认 3000）
 *    与 node_modules/vite 的 `vite --config vite.config.ts --force`（CLIENT_DEV_PORT，默认 8080）；
 *    轮询 /api/health 与前端首页判断就绪。
 * 关键约定：
 *  - 进程管理细节（快照/端口回收/整树终止）都在 scripts/dev-processes.cjs。
 *  - 会话文件 node_modules/.cache/squabble-dev.json + 同名 .lock（硬链接原子加锁）只允许一个
 *    监督者运行；日志写入 logs/dev.std.log（各子进程另有 *.std.log）。
 *  - SIGINT/SIGTERM/SIGHUP 与启动失败都会走 stop()：先停子进程再删会话文件与锁。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { parse } = require('dotenv');
const {
  processSnapshot,
  sameProcess,
  terminateTree,
  stopOwnedChild,
  reclaimPorts,
} = require('./dev-processes.cjs');

function loadDevelopmentEnv(projectRoot, parentEnv = process.env) {
  const env = { ...parentEnv };
  for (const filename of ['.env.local', '.env']) {
    const file = path.join(projectRoot, filename);
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(parse(fs.readFileSync(file)))) {
      if (env[key] === undefined) env[key] = value;
    }
  }
  return env;
}

function cleanServerBuild(projectRoot) {
  const root = fs.realpathSync(projectRoot);
  for (const name of ['server', 'shared', 'tsconfig.node.tsbuildinfo']) {
    const target = path.join(root, 'dist', name);
    if (!fs.existsSync(target)) continue;
    const relative = path.relative(root, fs.realpathSync(target));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`Build path escapes project: ${target}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function port(value, fallback, name) {
  const text = String(value || fallback);
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(number) || number < 1 || number > 65535)
    throw new Error(`Invalid ${name} port: ${text}`);
  return number;
}

function createDevSupervisor({
  projectRoot = path.resolve(__dirname, '..'),
  env: parentEnv = process.env,
} = {}) {
  const root = path.resolve(projectRoot);
  const env = loadDevelopmentEnv(root, parentEnv);
  const serverPort = port(env.SERVER_PORT, 3000, 'SERVER_PORT');
  const clientPort = port(env.CLIENT_DEV_PORT, 8080, 'CLIENT_DEV_PORT');
  if (serverPort === clientPort)
    throw new Error('SERVER_PORT and CLIENT_DEV_PORT must be different.');
  Object.assign(env, {
    NODE_ENV: 'development',
    SERVER_PORT: String(serverPort),
    CLIENT_DEV_PORT: String(clientPort),
  });
  const readyTimeout = Number(env.DEV_READY_TIMEOUT || 120000);
  const restartLimit = Number(env.MAX_RESTART_COUNT || 5);
  const restartDelay = Number(env.RESTART_DELAY || 2) * 1000;
  if (
    ![readyTimeout, restartLimit, restartDelay].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    throw new Error(
      'DEV_READY_TIMEOUT, MAX_RESTART_COUNT and RESTART_DELAY must be positive numbers.',
    );
  }
  const sessionPath = path.join(root, 'node_modules', '.cache', 'squabble-dev.json');
  const lockPath = `${sessionPath}.lock`;
  const token = randomUUID();
  const abort = new AbortController();
  const children = new Map();
  const logs = new Map();
  let session;
  let stopping = false;
  let stopPromise;
  let pendingWrites = 0;
  let releaseLock;

  function log(message, name = 'main') {
    const line = `[${new Date().toISOString()}] [${name}] ${message}\n`;
    for (const key of ['dev.std', name === 'main' ? 'dev' : `${name}.std`]) {
      const fd = logs.get(key);
      if (fd !== undefined) fs.writeSync(fd, line);
    }
    if (pendingWrites < 1000) {
      pendingWrites++;
      try {
        fs.write(1, line, () => pendingWrites--);
      } catch {
        pendingWrites--;
      }
    }
  }

  function readSession(file = sessionPath) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  async function lockStartup(identity) {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    // 以硬链接原子地挂上完整记录：读锁方永远不会看到空锁文件。
    const candidate = `${lockPath}.${token}`;
    fs.writeFileSync(candidate, JSON.stringify({ ...identity, token }), { flag: 'wx' });
    try {
      const deadline = Date.now() + 60000;
      while (!stopping) {
        try {
          fs.linkSync(candidate, lockPath);
          return () => {
            if (readSession(lockPath)?.token === token) fs.unlinkSync(lockPath);
          };
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        const owner = readSession(lockPath);
        if (
          owner &&
          !sameProcess(owner, await processSnapshot()) &&
          readSession(lockPath)?.token === owner.token
        ) {
          fs.unlinkSync(lockPath);
          continue;
        }
        if (Date.now() > deadline)
          throw new Error('Another development startup is still running. Retry when it finishes.');
        await delay(200, undefined, { signal: abort.signal }).catch((error) => {
          if (error.name !== 'AbortError') throw error;
        });
      }
    } finally {
      fs.unlinkSync(candidate);
    }
  }
  function saveSession() {
    if (readSession()?.token !== token)
      throw new Error('This development session was replaced by another startup.');
    writeSession();
  }
  function writeSession() {
    const pending = `${sessionPath}.${token}.tmp`;
    fs.writeFileSync(pending, JSON.stringify(session));
    fs.renameSync(pending, sessionPath);
  }
  async function recordChildren() {
    const rows = await processSnapshot();
    for (const child of children.values()) {
      const record = rows.find((row) => row.pid === child.pid);
      if (record && !child.identity)
        child.identity = { pid: record.pid, startedAt: record.startedAt };
    }
    session.children = [...children.values()].map((child) => child.identity).filter(Boolean);
    if (!stopping) saveSession();
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    abort.abort();
    stopPromise = (async () => {
      log('Stopping this development session...');
      const rows = await processSnapshot();
      for (const child of children.values()) {
        await stopOwnedChild(child, rows);
      }
      if (readSession()?.token === token) fs.unlinkSync(sessionPath);
      releaseLock?.();
      log('All development processes stopped.');
      for (const fd of logs.values()) fs.closeSync(fd);
      logs.clear();
    })();
    return stopPromise;
  }

  async function supervise(name, args) {
    let failures = 0;
    while (!stopping) {
      const started = Date.now();
      const child = spawn(process.execPath, args, {
        cwd: root,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.set(name, child);
      const exited = new Promise((resolve) => {
        child.once('exit', (code) => resolve(code ?? 1));
        child.once('error', (error) => {
          log(error.message, name);
          resolve(1);
        });
      });
      for (const stream of [child.stdout, child.stderr]) {
        readline
          .createInterface({ input: stream, crlfDelay: Infinity })
          .on('line', (line) => log(line, name));
      }
      log(`Started PID ${child.pid}`, name);
      await recordChildren();
      const code = await exited;
      if (stopping) return;
      // 死掉的 watcher 可能遗留后代进程；只清理它自己那一棵树。
      await stopOwnedChild(child);
      children.delete(name);
      failures = Date.now() - started > 60000 ? 1 : failures + 1;
      if (failures >= restartLimit)
        throw new Error(
          `${name} exited with code ${code}; restart limit reached. See logs/${name}.std.log.`,
        );
      const wait = Math.min(restartDelay * 2 ** (failures - 1), 8000);
      log(`Exited (${code}); restarting in ${wait / 1000}s`, name);
      await delay(wait, undefined, { signal: abort.signal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  }

  async function waitUntilReady() {
    const deadline = Date.now() + readyTimeout;
    while (!stopping && Date.now() < deadline) {
      try {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(1500)]);
        const backend = await fetch(`http://127.0.0.1:${serverPort}/api/health`, { signal });
        const health = backend.ok ? await backend.json() : null;
        const frontend = await fetch(`http://127.0.0.1:${clientPort}/`, { signal });
        await frontend.arrayBuffer();
        if (health?.status === 'ok' && frontend.ok) return;
      } catch {
        if (stopping) return;
      }
      await delay(300, undefined, { signal: abort.signal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    }
    if (!stopping)
      throw new Error(
        'Development startup timed out. Check server/client logs and DATABASE_URL before retrying.',
      );
  }

  async function start() {
    try {
      const logDir = path.resolve(root, env.LOG_DIR || 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      for (const name of ['dev.std', 'dev', 'server.std', 'client.std'])
        logs.set(name, fs.openSync(path.join(logDir, `${name}.log`), 'a'));
      log(`Starting Squabble from ${root}`);
      const rows = await processSnapshot();
      const identity = rows.find((row) => row.pid === process.pid);
      if (!identity?.startedAt)
        throw new Error('Cannot identify the development supervisor process.');
      releaseLock = await lockStartup({ pid: identity.pid, startedAt: identity.startedAt });
      if (stopping) {
        releaseLock?.();
        return;
      }
      const previous = readSession();
      if (previous?.root === root) {
        for (const record of [previous, ...(previous.children || [])]) {
          const current = await processSnapshot();
          if (sameProcess(record, current)) {
            log(`Stopping previous development session PID ${record.pid}`);
            await terminateTree(record, current);
          }
        }
      }
      if (stopping) return;
      session = { root, token, pid: process.pid, startedAt: identity.startedAt, children: [] };
      // 先写会话占位、再回收端口：即便对手是仍在编译中的旧启动也能被替换。
      writeSession();
      await reclaimPorts([serverPort, clientPort], log);
      if (stopping) return;
      saveSession();
      cleanServerBuild(root);
      log('Cleared server build output; Vite will refresh its dependency cache.');
      const jobs = Promise.all([
        supervise('server', [
          path.join(root, 'node_modules/@nestjs/cli/bin/nest.js'),
          'start',
          '--watch',
        ]),
        supervise('client', [
          path.join(root, 'node_modules/vite/bin/vite.js'),
          '--config',
          path.join(root, 'vite.config.ts'),
          '--force',
        ]),
      ]);
      // 持有启动锁期间完成子进程记录。此刻起第二个启动可以替换整个会话，即使尚未就绪。
      const recorded = recordChildren();
      await Promise.race([recorded, jobs]);
      releaseLock();
      await Promise.race([waitUntilReady(), jobs]);
      if (!stopping) {
        log(
          `Ready: http://127.0.0.1:${clientPort} (development UI; API: http://127.0.0.1:${serverPort}/api)`,
        );
        log(`Press Ctrl+C to stop. Logs: ${path.join(logDir, 'dev.std.log')}`);
      }
      await jobs;
    } catch (error) {
      await stop();
      throw error;
    }
  }
  return { start, stop };
}

if (require.main === module) {
  const supervisor = createDevSupervisor();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () =>
      supervisor.stop().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      }),
    );
  }
  supervisor.start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createDevSupervisor, loadDevelopmentEnv, cleanServerBuild };
