const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { parseWindowsListeners, planListenerCleanup, sameProcess, terminateTree, processSnapshot, stopOwnedChild } = require('./dev-processes.cjs');
const { createDevSupervisor, loadDevelopmentEnv, cleanServerBuild } = require('./dev.js');

test('Windows cleanup selects only listeners on the exact configured TCP ports', () => {
  const rows = `
    TCP    127.0.0.1:8080   0.0.0.0:0       LISTENING     100
    TCP    [::1]:8080       [::]:0          LISTENING     100
    TCP    0.0.0.0:3000     0.0.0.0:0       LISTENING     200
    TCP    127.0.0.1:8080   127.0.0.1:55000 ESTABLISHED   300
    TCP    127.0.0.1:18080  0.0.0.0:0       LISTENING     400
    UDP    0.0.0.0:8080     *:*                           500
  `;
  assert.deepEqual(parseWindowsListeners(rows, [3000, 8080]), [100, 200]);
});

test('cleanup stops the old supervisor so it cannot restart its port listeners', () => {
  const processes = [
    { pid: 10, parentPid: 1, command: 'node C:\\squabble\\scripts\\dev.js' },
    { pid: 20, parentPid: 10, command: 'node nest.js start --watch' },
    { pid: 30, parentPid: 20, command: 'node dist/server/main.js' },
    { pid: 40, parentPid: 10, command: 'node vite.js' },
    { pid: 50, parentPid: 1, command: 'node unrelated.js' },
    { pid: 90, parentPid: 1, command: 'node current.js' },
  ];
  assert.deepEqual(planListenerCleanup([30, 40], processes, 90), [10]);
  assert.throws(() => planListenerCleanup([90], processes, 90), /current|ancestor/i);
});

test('development env respects shell overrides and parses .env.local before .env', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'squabble-dev-env-'));
  try {
    writeFileSync(path.join(root, '.env'), 'SERVER_PORT=3000\nCLIENT_DEV_PORT=8080\nVALUE="quoted # value"\n');
    writeFileSync(path.join(root, '.env.local'), 'SERVER_PORT=3100\nCLIENT_DEV_PORT=8180\n');
    const env = loadDevelopmentEnv(root, { SERVER_PORT: '3200' });
    assert.equal(env.SERVER_PORT, '3200');
    assert.equal(env.CLIENT_DEV_PORT, '8180');
    assert.equal(env.VALUE, 'quoted # value');
  } finally { removeFixture(root); }
});

test('fresh server builds preserve desktop and client artifacts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'squabble-dev-clean-'));
  try {
    for (const folder of ['server', 'shared', 'client', 'desktop']) {
      mkdirSync(path.join(root, 'dist', folder), { recursive: true });
      writeFileSync(path.join(root, 'dist', folder, 'keep.txt'), folder);
    }
    writeFileSync(path.join(root, 'dist', 'tsconfig.node.tsbuildinfo'), 'stale');
    cleanServerBuild(root);
    assert.equal(existsSync(path.join(root, 'dist/server')), false);
    assert.equal(existsSync(path.join(root, 'dist/shared')), false);
    assert.equal(existsSync(path.join(root, 'dist/tsconfig.node.tsbuildinfo')), false);
    assert.equal(readFileSync(path.join(root, 'dist/client/keep.txt'), 'utf8'), 'client');
    assert.equal(readFileSync(path.join(root, 'dist/desktop/keep.txt'), 'utf8'), 'desktop');
  } finally { removeFixture(root); }
});

test('build cleanup rejects a dist directory pointing outside the project', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'squabble-dev-link-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'squabble-dev-outside-'));
  try {
    mkdirSync(path.join(outside, 'server'));
    writeFileSync(path.join(outside, 'server/keep.txt'), 'keep');
    symlinkSync(outside, path.join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => cleanServerBuild(root), /escapes project/);
    assert.equal(readFileSync(path.join(outside, 'server/keep.txt'), 'utf8'), 'keep');
  } finally {
    unlinkSync(path.join(root, 'dist'));
    removeFixture(root);
    removeFixture(outside);
  }
});

test('stale process identities cannot target a reused PID', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    const rows = await processSnapshot();
    const record = rows.find(row => row.pid === child.pid);
    assert.ok(record?.startedAt);
    const stale = { ...record, startedAt: 'not-the-same-process' };
    assert.equal(sameProcess(stale, rows), false);
    assert.equal(sameProcess({ pid: child.pid }, rows), false);
    await terminateTree(stale, rows);
    assert.equal(child.exitCode, null);
    process.kill(child.pid, 0);
  } finally { await terminateTree(child.pid); }
});

test('POSIX cleanup retains ownership of grandchildren after the watcher exits', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const serverPort = await freePort();
  const worker = `require('node:net').createServer().listen(${serverPort}, '127.0.0.1')`;
  const watcher = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {stdio:'ignore'}); setTimeout(() => process.exit(0), 700);`;
  const child = spawn(process.execPath, ['-e', watcher], { detached: true, stdio: 'ignore' });
  try {
    await until(() => child.exitCode !== null, () => 'watcher exit');
    assert.equal(await canBind(serverPort), false);
    await stopOwnedChild(child);
    await until(() => canBind(serverPort), () => 'orphaned listener cleanup');
  } finally { await stopOwnedChild(child); }
});

test('invalid or overlapping ports fail before starting or cleaning processes', () => {
  assert.throws(() => createDevSupervisor({ env: { SERVER_PORT: '3000;whoami' } }), /port/i);
  assert.throws(() => createDevSupervisor({ env: { SERVER_PORT: '8080', CLIENT_DEV_PORT: '8080' } }), /different/i);
});

test('restarts, legacy port owners and concurrent starts leave one fresh session and preserve other ports', { timeout: 120000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'squabble-dev-restart-'));
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  const [serverPort, clientPort, otherPort] = ports;
  const script = path.resolve(__dirname, 'dev.js');
  const fixture = `
    const { createDevSupervisor } = require(${JSON.stringify(script)});
    const supervisor = createDevSupervisor({ projectRoot: ${JSON.stringify(root)} });
    process.on('message', async message => { if (message === 'stop') { await supervisor.stop(); process.exit(0); } });
    supervisor.start().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const worker = `
    require('node:http').createServer((req,res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({status:'ok',pid:process.pid,revision:require('node:fs').readFileSync('revision.txt','utf8')}));
    }).listen(Number(process.env.SERVER_PORT), '127.0.0.1');
  `;
  const nest = `
    const {spawn} = require('node:child_process');
    function run() { const worker = spawn(process.execPath, ['worker.cjs'], {stdio:'inherit',windowsHide:true}); worker.on('exit', () => setTimeout(run,50)); }
    run();
  `;
  const vite = worker.replaceAll('SERVER_PORT', 'CLIENT_DEV_PORT');
  const files = {
    'scripts/dev.js': fixture, 'worker.cjs': worker, 'node_modules/@nestjs/cli/bin/nest.js': nest,
    'node_modules/vite/bin/vite.js': vite, 'revision.txt': 'old',
    '.env.local': `SERVER_PORT=${serverPort}\nCLIENT_DEV_PORT=${clientPort}\nDEV_READY_TIMEOUT=20000\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  const other = net.createServer().listen(otherPort, '127.0.0.1');
  const children = [];
  const launch = () => {
    const env = { ...process.env };
    delete env.SERVER_PORT; delete env.CLIENT_DEV_PORT; delete env.LOG_DIR;
    const child = spawn(process.execPath, ['scripts/dev.js'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.output = '';
    child.stdout.on('data', chunk => { child.output += chunk; });
    child.stderr.on('data', chunk => { child.output += chunk; });
    children.push(child);
    return child;
  };
  try {
    const first = launch();
    await until(() => first.output.includes('Ready:'), () => first.output);
    const original = await readServer(serverPort);
    writeFileSync(path.join(root, 'revision.txt'), 'new');
    const second = launch();
    await until(() => second.output.includes('Ready:'), () => second.output);
    const current = await readServer(serverPort);
    assert.equal(current.revision, 'new');
    assert.notEqual(current.pid, original.pid);
    await until(() => first.exitCode !== null || first.signalCode !== null, () => first.output);
    assert.equal((await readServer(clientPort)).revision, 'new');
    assert.equal(other.listening, true);
    await delay(1200);
    assert.equal((await readServer(serverPort)).pid, current.pid, 'old cleanup must not kill the replacement');
    // Simulate a pre-upgrade supervisor with no session record, then overlap two
    // launches. The lock must keep a superseded startup from killing the winner.
    unlinkSync(path.join(root, 'node_modules/.cache/squabble-dev.json'));
    const concurrent = [launch(), launch()];
    const alive = () => concurrent.filter(child => child.exitCode === null && child.signalCode === null);
    await until(() => alive().length === 1 && alive()[0].output.includes('Ready:'), () => concurrent.map(child => child.output).join('\n'));
    const winner = alive()[0];
    assert.equal((await readServer(clientPort)).revision, 'new');
    assert.equal(other.listening, true);
    winner.send('stop');
    await until(() => winner.exitCode !== null, () => winner.output);
    assert.equal(await canBind(serverPort), true);
    assert.equal(await canBind(clientPort), true);
    assert.equal(other.listening, true);
  } finally {
    for (const child of children) if (child.connected) child.send('stop');
    await until(() => children.every(child => child.exitCode !== null || child.signalCode !== null), () => children.map(child => child.output).join('\n'));
    await new Promise(resolve => other.close(resolve));
    removeFixture(root);
  }
});

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function canBind(port) {
  const server = net.createServer();
  return new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
async function readServer(port) { return (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); }
async function until(predicate, details) {
  const deadline = Date.now() + 45000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${details()}`);
    await delay(100);
  }
}
function removeFixture(root) {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  rmSync(root, { recursive: true, force: true });
}
