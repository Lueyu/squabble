'use strict';
const net = require('node:net');

const FIXED_ROUTES = Object.freeze({ docling: Object.freeze({ host: 'docling', port: 5002 }),
  sandbox: Object.freeze({ host: 'sandbox', port: 8093 }) });
const LIMITS = Object.freeze({ maxConnections: 32, highWaterMark: 64 * 1024, connectMs: 5000, idleMs: 30000, lifetimeMs: 120000 });

/** Trusted deployment/test parameters only; no protocol, environment or CLI value selects a destination. */
function createForwarder(service, { connect = destination => net.createConnection(destination), ...limits } = {}) {
  if (!Object.hasOwn(FIXED_ROUTES, service)) throw Error('FIXED_SERVICE_REQUIRED');
  const route = FIXED_ROUTES[service], config = { ...LIMITS, ...limits }, active = new Set();
  let closing;
  const server = net.createServer({ allowHalfOpen: true, highWaterMark: config.highWaterMark }, client => {
    if (active.size >= config.maxConnections) { client.destroy(); return; }
    let upstream, connectTimer, lifetime;
    const abort = () => { client.destroy(); upstream?.destroy(); };
    active.add(abort);
    client.on('error', abort);
    client.once('close', () => { clearTimeout(connectTimer); clearTimeout(lifetime); active.delete(abort); upstream?.destroy(); });
    client.setTimeout(config.idleMs, abort);
    lifetime = setTimeout(abort, config.lifetimeMs); lifetime.unref();
    try {
      upstream = connect({ ...route, allowHalfOpen: true, highWaterMark: config.highWaterMark });
      upstream.on('error', abort);
      upstream.once('connect', () => clearTimeout(connectTimer));
      upstream.once('close', () => {
        // Normal EOF must flush pending response bytes before the caller closes.
        if (!upstream.readableEnded) client.destroy();
      });
      upstream.setTimeout(config.idleMs, abort);
      connectTimer = setTimeout(abort, config.connectMs); connectTimer.unref();
      client.pipe(upstream); upstream.pipe(client);
    } catch { abort(); }
  });
  return { server, close: () => closing ??= new Promise(resolve => {
    for (const abort of active) abort();
    server.close(() => resolve());
  }) };
}

async function startManagedRelays() {
  const relays = Object.keys(FIXED_ROUTES).map(service => ({ service, ...createForwarder(service) }));
  const close = () => Promise.all(relays.map(relay => relay.close()));
  try {
    await Promise.all(relays.map(({ service, server }) => new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(FIXED_ROUTES[service].port, '0.0.0.0', resolve);
    })));
  } catch (error) { await close(); throw error; }
  return { close };
}
if (require.main === module) {
  startManagedRelays().then(relays => {
    const stop = () => { void relays.close().then(() => { process.exitCode = 0; }); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    process.stdout.write('Source-host fixed tool relay ready on ports 5002 and 8093.\n');
  }).catch(() => { process.stderr.write('SOURCE_HOST_RELAY_START_FAILED\n'); process.exitCode = 1; });
}
module.exports = { FIXED_ROUTES, LIMITS, createForwarder, startManagedRelays };
