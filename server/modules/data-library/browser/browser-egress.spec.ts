import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { BrowserEgressProxy, connectPublicTunnel } from './browser-egress';

async function exchange(port: number, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('fixture timeout')));
    socket.on('connect', () => socket.write(input));
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n')) { socket.destroy(); resolve(data); }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
  });
}

test('CONNECT rejects missing auth, HTTP, IP literals and private DNS before transport', async () => {
  let connections = 0;
  const proxy = await BrowserEgressProxy.create({
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    connect: async () => { connections++; throw new Error('must not dial'); },
  });
  try {
    const auth = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`;
    assert.match(await exchange(proxy.port, 'CONNECT public.site:443 HTTP/1.1\r\nHost: public.site\r\n\r\n'), /407/u);
    for (const target of ['public.site:80', '127.0.0.1:443', 'private.site:443']) {
      assert.match(await exchange(proxy.port, `CONNECT ${target} HTTP/1.1\r\n${auth}\r\n`), /403/u);
    }
    assert.match(await exchange(proxy.port, `GET http://public.site/ HTTP/1.1\r\nHost: public.site\r\n${auth}\r\n`), /403/u);
    assert.equal(connections, 0);
  } finally { await proxy.close(); }
});

test('CONNECT pins the validated IP and closes active sockets when the byte budget is exceeded', async () => {
  const fixture = createServer(socket => { socket.write(Buffer.alloc(256)); });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixturePort = (fixture.address() as AddressInfo).port;
  let pinned = '';
  const proxy = await BrowserEgressProxy.create({
    maxBytes: 64,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: async address => {
      pinned = address.address;
      return new Promise<Duplex>(resolve => {
        const socket = connect(fixturePort, '127.0.0.1', () => resolve(socket));
      });
    },
  });
  try {
    const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
    await exchange(proxy.port, `CONNECT public.site:443 HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    assert.equal(pinned, '93.184.216.34');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(proxy.failure?.code, 'RESPONSE_TOO_LARGE');
  } finally { await proxy.close(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
});

test('upstream CONNECT uses only validated IP and keeps proxy credentials out of the tunnel', async () => {
  let connectHeader = '';
  let targetBytes = '';
  const fixture = createServer(socket => {
    socket.once('data', chunk => {
      connectHeader = chunk.toString();
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      socket.on('data', bytes => { targetBytes += bytes.toString(); socket.end(); });
    });
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as AddressInfo).port;
  const socket = await connectPublicTunnel(
    { address: '93.184.216.34', family: 4 }, 443, new AbortController().signal,
    new URL(`http://upstream-user:upstream-secret@127.0.0.1:${port}`),
  );
  socket.write('target request');
  await new Promise<void>(resolve => socket.on('close', resolve));
  assert.match(connectHeader, /^CONNECT 93[.]184[.]216[.]34:443 HTTP\/1[.]1/u);
  assert.match(connectHeader, /Proxy-Authorization: Basic /u);
  assert.equal(targetBytes, 'target request');
  assert.doesNotMatch(targetBytes, /upstream|Authorization/u);
  await new Promise<void>(resolve => fixture.close(() => resolve()));
});

test('CONNECT budget and cancellation close the proxy without opening further tunnels', async () => {
  const proxy = await BrowserEgressProxy.create({
    maxConnects: 1,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: async () => { throw new Error('offline fixture'); },
  });
  const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
  const request = `CONNECT public.site:443 HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`;
  await exchange(proxy.port, request);
  await exchange(proxy.port, request);
  assert.equal(proxy.failure?.code, 'BLOCKED');
  await proxy.close();
});

test('cancelling an upstream CONNECT closes the pending network socket without exposing its authentication', async () => {
  let received = '';
  let connected: (() => void) | undefined;
  let closed: (() => void) | undefined;
  const connecting = new Promise<void>(resolve => { connected = resolve; });
  const closing = new Promise<void>(resolve => { closed = resolve; });
  const fixture = createServer(socket => {
    socket.on('data', data => { received += data.toString(); connected!(); });
    socket.on('close', () => closed!());
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as AddressInfo).port;
  const controller = new AbortController();
  const pending = connectPublicTunnel({ address: '93.184.216.34', family: 4 }, 443, controller.signal,
    new URL(`http://fixture-user:fixture-secret@127.0.0.1:${port}`));
  await connecting;
  controller.abort();
  await assert.rejects(pending, error => {
    assert.equal((error as Error).message, 'CANCELLED');
    assert.doesNotMatch(String(error), /fixture-user|fixture-secret/u);
    return true;
  });
  await closing;
  assert.match(received, /^CONNECT 93[.]184[.]216[.]34:443/u);
  await new Promise<void>(resolve => fixture.close(() => resolve()));
});

test('malformed private upstream credentials fail as a safe configuration error', async () => {
  await assert.rejects(connectPublicTunnel({ address: '93.184.216.34', family: 4 }, 443,
    new AbortController().signal, new URL('http://bad%ZZ:fixture-secret@127.0.0.1:1234')), { code: 'UNAVAILABLE' });
});
