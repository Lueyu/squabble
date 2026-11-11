const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const { createForwarder, FIXED_ROUTES, LIMITS } = require('./source-host-relay.cjs');
const deadline = (promise, milliseconds = 3000) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(Error('Fixture deadline')), milliseconds); timer.unref();
})]);
async function waitFor(predicate) {
  const expires = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= expires) throw Error('Fixture peer deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function listening(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function fixture(handler, options = {}) {
  const sockets = new Set();
  const upstream = net.createServer({ allowHalfOpen: true }, socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); handler(socket); });
  const port = await listening(upstream);
  const destinations = [];
  const relay = createForwarder('docling', { ...options, connect: destination => {
    destinations.push(destination); return net.createConnection({ ...destination, host: '127.0.0.1', port });
  } });
  const relayPort = await listening(relay.server);
  return { relay, upstream, destinations, port: relayPort, close: async () => { await relay.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => upstream.close(resolve)); } };
}
function client(port) { const value = net.createConnection({ host: '127.0.0.1', port }); value.on('error', () => {}); value.resume(); return value; }

test('relay routes are fixed and protocol bytes/half-close survive backpressure', { timeout: 10000 }, async () => {
  assert.deepEqual(FIXED_ROUTES, { docling: { host: 'docling', port: 5002 }, sandbox: { host: 'sandbox', port: 8093 } });
  assert.throws(() => createForwarder('http://arbitrary-target.invalid'), /FIXED_SERVICE_REQUIRED/);
  const request = Buffer.alloc(256 * 1024, 0xa5), response = Buffer.concat([Buffer.from('fictional-token\0'), Buffer.alloc(2 * 1024 * 1024, 0x5a)]);
  let received;
  const value = await fixture(socket => {
    const chunks = []; socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => { received = Buffer.concat(chunks); socket.end(response); });
  });
  try {
    const socket = client(value.port), chunks = [];
    socket.pause(); socket.on('data', chunk => chunks.push(chunk));
    socket.end(request); setTimeout(() => socket.resume(), 60);
    await deadline(once(socket, 'close'));
    assert.deepEqual(received, request); assert.deepEqual(Buffer.concat(chunks), response);
    assert.equal(value.destinations.length, 1);
    assert.equal(value.destinations[0].host, 'docling'); assert.equal(value.destinations[0].port, 5002);
    assert.equal(value.destinations[0].allowHalfOpen, true);
    assert.equal(value.destinations[0].highWaterMark, LIMITS.highWaterMark);
  } finally { await value.close(); }
});

test('client cancellation and relay shutdown close the original upstream connection', { timeout: 10000 }, async () => {
  const peers = []; const value = await fixture(socket => { socket.on('error', () => {}); socket.on('end', () => socket.end()); socket.resume(); peers.push(socket); });
  try {
    const first = client(value.port); await once(first, 'connect');
    await waitFor(() => peers.length > 0);
    const cancelled = once(peers[0], 'close'); first.destroy(); await deadline(cancelled);
    const second = client(value.port); await once(second, 'connect');
    await waitFor(() => peers.length >= 2);
    const closed = Promise.all([once(second, 'close'), once(peers[1], 'close')]); await value.relay.close(); await deadline(closed);
    assert.equal(peers.every(socket => socket.destroyed), true);
  } finally { await value.close(); }
});

test('connection admission, idle time and total lifetime are bounded', { timeout: 10000 }, async () => {
  const peers = []; const value = await fixture(socket => { socket.on('data', () => {}); socket.on('error', () => {}); socket.on('end', () => socket.end()); peers.push(socket); },
    { maxConnections: 2, idleMs: 150, lifetimeMs: 500 });
  try {
    const first = client(value.port), second = client(value.port); await Promise.all([once(first, 'connect'), once(second, 'connect')]);
    await waitFor(() => peers.length >= 2);
    const third = client(value.port); const denied = once(third, 'close'); await deadline(denied);
    assert.equal(value.destinations.length, 2);
    const idle = once(second, 'close'), lifetime = once(first, 'close');
    const keepalive = setInterval(() => { if (!first.destroyed) first.write('x'); }, 40);
    try { await deadline(idle); assert.equal(first.destroyed, false); await deadline(lifetime); }
    finally { clearInterval(keepalive); }
  } finally { await value.close(); }
});

test('upstream connection failure closes the waiting caller', { timeout: 10000 }, async () => {
  const refusal = net.createServer(); const unused = await listening(refusal); await new Promise(resolve => refusal.close(resolve));
  const relay = createForwarder('sandbox', { connect: destination => net.createConnection({ ...destination, host: '127.0.0.1', port: unused }) });
  const port = await listening(relay.server);
  try { const socket = client(port); await deadline(once(socket, 'close')); }
  finally { await relay.close(); }
});

test('source-host publishes only fixed relay ports while engines retain internal isolation', () => {
  const config = JSON.parse(execFileSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.source.yml', '-f', 'deploy/compose.source-host.yml', 'config', '--format', 'json'], { encoding: 'utf8' }));
  assert.deepEqual(config.services.docling.ports ?? [], []); assert.deepEqual(config.services.sandbox.ports ?? [], []);
  assert.deepEqual(Object.keys(config.services.docling.networks), ['tools']); assert.deepEqual(Object.keys(config.services.sandbox.networks), ['tools']);
  const relay = config.services['source-host-relay']; assert.ok(relay);
  assert.equal(relay.user, '1000:1000'); assert.equal(relay.read_only, true); assert.deepEqual(relay.cap_drop, ['ALL']);
  assert.equal(Number(relay.mem_limit), 67108864); assert.ok(relay.pids_limit <= 64);
  assert.deepEqual(Object.keys(relay.networks).sort(), ['default', 'tools']);
  assert.deepEqual(relay.ports.map(item => [item.host_ip, item.published, item.target]), [['127.0.0.1', '5002', 5002], ['127.0.0.1', '8093', 8093]]);
  assert.equal(relay.volumes.length, 1); assert.equal(relay.volumes[0].read_only, true);
  assert.ok(relay.volumes[0].source.replaceAll('\\', '/').endsWith('deploy/source-host-relay.cjs'));
  assert.ok(!JSON.stringify(relay).includes('docker.sock')); assert.ok(!JSON.stringify(relay).includes('credentials:'));
  for (const name of ['DATABASE_URL', 'JWT_SECRET', 'SETTINGS_ENCRYPTION_KEY']) assert.equal(relay.environment?.[name], undefined);
});

test('relay health checks use actual Docling and broker metadata protocols', async () => {
  const config = JSON.parse(execFileSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.source.yml', '-f', 'deploy/compose.source-host.yml', 'config', '--format', 'json'], { encoding: 'utf8' }));
  const code = config.services['source-host-relay'].healthcheck.test.at(-1);
  async function probe(document, broker) {
    let exitCode;
    await vm.runInNewContext(code, { process: { exit: code => { exitCode = code; } }, fetch: async url => {
      assert.ok(['http://127.0.0.1:5002/health', 'http://127.0.0.1:8093/health'].includes(url));
      return { ok: true, json: async () => url.includes(':5002/') ? document : broker };
    } });
    return exitCode;
  }
  assert.equal(await probe({ ready: true, modelsVerified: true }, { status: 'ready' }), 0);
  assert.equal(await probe({ ready: false, modelsVerified: false }, { status: 'ready' }), 1);
  assert.equal(await probe({ ready: true, modelsVerified: false }, { status: 'ready' }), 1);
  assert.equal(await probe({ ready: true, modelsVerified: true }, { status: 'unavailable' }), 1);
});
