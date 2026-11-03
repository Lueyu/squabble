import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

const companionPromise = import('./companion.mts').catch(() => null);
const code = 'a'.repeat(48);
const token = 'b'.repeat(64);
const deviceId = '11111111-1111-4111-8111-111111111111';

async function temporaryDirectory(): Promise<{ directory: string; remove: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'squabble-companion-'));
  return { directory, remove: async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  } };
}

test('pair links accept only exact loopback origins and a single valid code', async () => {
  const api = await companionPromise;
  assert.ok(api?.parsePairingLink);
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3001', 'https://[::1]:443']) {
    assert.equal(api.parsePairingLink(`squabble://pair?origin=${encodeURIComponent(origin)}&code=${code}`)?.code, code);
  }
  for (const origin of ['https://example.com', 'http://localhost.evil.test', 'http://127.1',
    'http://2130706433', 'http://127.0.0.2', 'http://user:password@localhost',
    'http://localhost/path', 'http://localhost/', 'http://localhost?x=1', 'http://localhost#x',
    'file://localhost', 'http://localhost:65536', 'http://localhost\\@evil.test']) {
    assert.equal(api.parsePairingLink(`squabble://pair?origin=${encodeURIComponent(origin)}&code=${code}`), null, origin);
  }
  for (const link of [`https://pair?origin=http%3A%2F%2Flocalhost&code=${code}`,
    `squabble://pair/other?origin=http%3A%2F%2Flocalhost&code=${code}`,
    `squabble://pair?origin=http%3A%2F%2Flocalhost&code=${code}&code=${code}`,
    `squabble://pair?origin=http%3A%2F%2Flocalhost&code=short`,
    `squabble://pair?origin=http%3A%2F%2Flocalhost&code=${code}&extra=1`]) {
    assert.equal(api.parsePairingLink(link), null);
  }
});

test('pairing requires confirmation and stores a private reusable token atomically', async () => {
  const api = await companionPromise;
  assert.ok(api?.LocalAgentCompanion);
  const temporary = await temporaryDirectory();
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.equal(request.url, '/api/local-agent-companion/pair');
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { code, name: 'Test computer' });
    response.end(JSON.stringify({ token, deviceId }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const helper = new api.LocalAgentCompanion({ dataDir: temporary.directory, name: 'Test computer', native: idleNative() });
  try {
    const link = `squabble://pair?origin=${encodeURIComponent(origin)}&code=${code}`;
    assert.equal(await helper.pair(link, async () => false), false);
    assert.equal(requests, 0);
    assert.equal(await helper.pair(link, async (shownOrigin) => {
      assert.equal(shownOrigin, origin); return true;
    }), true);
    assert.equal(requests, 1);
    assert.equal(helper.status.origin, origin);
    const saved = JSON.parse(await readFile(join(temporary.directory, 'pairing.json'), 'utf8'));
    assert.equal(saved.token, token);
    if (process.platform !== 'win32') assert.equal((await stat(join(temporary.directory, 'pairing.json'))).mode & 0o777, 0o600);
    const restored = new api.LocalAgentCompanion({ dataDir: temporary.directory, name: 'Test', native: idleNative() });
    await restored.restore();
    assert.equal(restored.status.origin, origin);
    await restored.stop();
  } finally {
    await helper.stop();
    await new Promise<void>((done) => server.close(() => done()));
    await temporary.remove();
  }
});

function idleNative() {
  return {
    detectNativeAgents: async () => [],
    openNativeLogin: async () => undefined,
    runNativeAgent: async () => ({ text: 'report', usageTokens: null }),
  };
}

async function fixture(overrides: { runNativeAgent?: ReturnType<typeof idleNative>['runNativeAgent'] } = {}) {
  const api = await companionPromise;
  assert.ok(api?.LocalAgentCompanion);
  const temporary = await temporaryDirectory();
  let now = 1_000;
  let response: object = { commands: [], cancelTaskIds: [] };
  let failure = 0;
  const sent: { updates: { id: string; state: string; text?: string }[] }[] = [];
  const helper = new api.LocalAgentCompanion({
    dataDir: temporary.directory, name: 'Test', native: { ...idleNative(), ...overrides }, now: () => now,
    fetch: async (url, options) => {
      assert.equal(options?.redirect, 'error');
      if (String(url).endsWith('/pair')) return Response.json({ token, deviceId });
      assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${token}`);
      sent.push(JSON.parse(String(options?.body)));
      if (failure) return new Response('', { status: failure });
      return Response.json(response);
    },
  });
  await helper.pair(`squabble://pair?origin=http%3A%2F%2Flocalhost%3A3000&code=${code}`, async () => true);
  return { helper, sent, temporary, response: (value: object) => { response = value; }, fail: (status: number) => { failure = status; },
    time: (value: number) => { now = value; } };
}

async function settle(): Promise<void> { await new Promise<void>((done) => setImmediate(done)); }

test('native research isolation failures preserve their actionable error code', async () => {
  const f = await fixture({ runNativeAgent: async () => { throw new Error('NATIVE_AGENT_TOOL_ISOLATION_FAILED'); } });
  try {
    f.response({ commands: [{ id: 'isolation-failure', kind: 'run', provider: 'codex', prompt: 'Research' }], cancelTaskIds: [] });
    await f.helper.pollOnce(); await settle();
    f.response({ commands: [], cancelTaskIds: [] }); await f.helper.pollOnce();
    assert.deepEqual(f.sent.at(-1)?.updates[0], {
      id: 'isolation-failure', state: 'failed', error: 'LOCAL_TOOL_ISOLATION_FAILED',
      progress: 'Native agent failed. Check its installation and sign-in before starting another task.',
    });
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('poll persists task IDs before launch, deduplicates delivery and preserves completed updates after failures', async () => {
  let runs = 0;
  const f = await fixture({ runNativeAgent: async () => { runs += 1; return { text: 'complete', usageTokens: null }; } });
  try {
    const command = { id: 'task-1', kind: 'run', provider: 'codex', prompt: 'Research' };
    f.response({ commands: [command, command], cancelTaskIds: [] });
    await f.helper.pollOnce();
    await settle();
    assert.equal(runs, 1);
    assert.ok(JSON.parse(await readFile(join(f.temporary.directory, 'pairing.json'), 'utf8')).processedTaskIds.includes('task-1'));
    f.fail(503);
    await f.helper.pollOnce();
    f.fail(0);
    await f.helper.pollOnce();
    assert.equal(runs, 1);
    assert.deepEqual(f.sent.at(-1)?.updates, f.sent.at(-2)?.updates);
    assert.equal(f.sent.at(-1)?.updates[0]?.state, 'completed');
    await f.helper.stop();
    const api = await companionPromise;
    assert.ok(api);
    let recoveryUpdates: { id: string; state: string }[] = [];
    const restored = new api.LocalAgentCompanion({ dataDir: f.temporary.directory, name: 'Test',
      native: { ...idleNative(), runNativeAgent: async () => { runs += 1; return { text: '', usageTokens: null }; } },
      fetch: async (_url, options) => {
        recoveryUpdates = JSON.parse(String(options?.body)).updates;
        return Response.json({ commands: [command], cancelTaskIds: [] });
      },
    });
    await restored.restore();
    await restored.pollOnce();
    assert.equal(runs, 1);
    assert.deepEqual(recoveryUpdates, [{ id: 'task-1', state: 'failed', progress: 'Desktop companion restarted. Start a new task.' }]);
    await restored.stop();
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('companion carries settings for all seven providers and refuses malformed overrides', async () => {
  const calls: unknown[][] = [];
  const f = await fixture({ runNativeAgent: async (...args: unknown[]) => {
    calls.push(args); return { text: 'complete', usageTokens: null };
  } });
  try {
    const providers = ['codex', 'claude', 'gemini', 'antigravity', 'opencode', 'kimi', 'doubao'];
    const agentSettings = { model: 'fixture/model', reasoningEffort: 'high' };
    f.response({ commands: providers.map((provider) => ({ id: `configured-${provider}`, kind: 'run', provider,
      prompt: 'Research', agentSettings })), cancelTaskIds: [] });
    await f.helper.pollOnce(); await settle();
    assert.deepEqual(calls.map((call) => call[0]), providers);
    assert.ok(calls.every((call) => JSON.stringify((call[2] as { agentSettings: unknown }).agentSettings) === JSON.stringify(agentSettings)));
    for (const invalid of [{ model: 7 }, { model: 'x'.repeat(161) }, { reasoningEffort: 'high\n' }, { executable: 'other' }]) {
      f.response({ commands: [{ id: 'invalid-settings', kind: 'run', provider: 'codex', prompt: 'Research', agentSettings: invalid }], cancelTaskIds: [] });
      await f.helper.pollOnce(); await settle();
      assert.equal(calls.length, 7);
      assert.equal(f.helper.status.state, 'offline');
    }
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('unconfirmed upstream cancellation remains failed with an actionable code', async () => {
  const f = await fixture({ runNativeAgent: async (...args: unknown[]) => {
    const { signal } = args[2] as { signal: AbortSignal };
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('NATIVE_AGENT_CANCEL_UNCONFIRMED');
  } });
  try {
    f.response({ commands: [{ id: 'uncertain', kind: 'run', provider: 'doubao', prompt: 'Research' }], cancelTaskIds: [] });
    await f.helper.pollOnce();
    f.response({ commands: [], cancelTaskIds: ['uncertain'] });
    await f.helper.pollOnce(); await settle(); await f.helper.pollOnce();
    assert.deepEqual(f.sent.at(-1)?.updates.map((update) => ({ id: update.id, state: update.state,
      error: (update as { error?: string }).error })),
    [{ id: 'uncertain', state: 'failed', error: 'LOCAL_DISPATCH_UNCERTAIN' }]);
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('native login requirements are returned as an actionable companion error', async () => {
  const f = await fixture({ runNativeAgent: async () => { throw new Error('NATIVE_AGENT_LOGIN_REQUIRED'); } });
  try {
    f.response({ commands: [{ id: 'login-needed', kind: 'run', provider: 'antigravity', prompt: 'Research' }], cancelTaskIds: [] });
    await f.helper.pollOnce(); await settle();
    f.response({ commands: [], cancelTaskIds: [] });
    await f.helper.pollOnce();
    assert.equal((f.sent.at(-1)?.updates[0] as { error?: string }).error, 'LOCAL_LOGIN_REQUIRED');
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('cancellation and provider concurrency do not block companion heartbeat', async () => {
  const signals: AbortSignal[] = [];
  const f = await fixture({ runNativeAgent: async (...args: unknown[]) => {
    const options = args[2] as { signal: AbortSignal };
    signals.push(options.signal);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  } });
  try {
    f.response({ commands: [
      { id: 'first', kind: 'run', provider: 'codex', prompt: 'Research' },
      { id: 'second', kind: 'run', provider: 'codex', prompt: 'Research' },
    ], cancelTaskIds: [] });
    await f.helper.pollOnce();
    await settle();
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);
    f.response({ commands: [], cancelTaskIds: ['first'] });
    await f.helper.pollOnce();
    await settle();
    assert.equal(signals[0].aborted, true);
    await f.helper.pollOnce();
    assert.ok(f.sent.some((request) => request.updates.some((update) => update.id === 'second' && update.state === 'failed')));
    assert.ok(f.sent.at(-1)?.updates.some((update) => update.id === 'first' && update.state === 'cancelled'));
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('revocation aborts work and forgets its token', async () => {
  let signal: AbortSignal | undefined;
  const f = await fixture({ runNativeAgent: async (...args: unknown[]) => {
    signal = (args[2] as { signal: AbortSignal }).signal;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('token secret'))));
  } });
  try {
    f.response({ commands: [{ id: 'task', kind: 'run', provider: 'claude', prompt: 'Research' }], cancelTaskIds: [] });
    await f.helper.pollOnce();
    await settle();
    f.fail(401);
    await f.helper.pollOnce();
    assert.equal(signal?.aborted, true);
    assert.equal(f.helper.status.state, 'unpaired');
    await assert.rejects(readFile(join(f.temporary.directory, 'pairing.json')), { code: 'ENOENT' });
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('network loss beyond thirty seconds aborts native work without retrying the task', async () => {
  let signal: AbortSignal | undefined;
  const f = await fixture({ runNativeAgent: async (...args: unknown[]) => {
    signal = (args[2] as { signal: AbortSignal }).signal;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  } });
  try {
    f.response({ commands: [{ id: 'task', kind: 'run', provider: 'codex', prompt: 'Research' }], cancelTaskIds: [] });
    await f.helper.pollOnce();
    await settle();
    f.fail(503);
    f.time(32_000);
    await f.helper.pollOnce();
    assert.equal(signal?.aborted, true);
    assert.equal(f.helper.status.state, 'offline');
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('pairing never follows a redirect or stores credentials for a redirected server', async () => {
  const api = await companionPromise;
  assert.ok(api?.LocalAgentCompanion);
  const temporary = await temporaryDirectory();
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: 'https://example.com/' }); response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const helper = new api.LocalAgentCompanion({ dataDir: temporary.directory, name: 'Test', native: idleNative() });
  try {
    await assert.rejects(helper.pair(`squabble://pair?origin=${encodeURIComponent(origin)}&code=${code}`, async () => true), /pair/i);
    assert.equal(helper.status.state, 'unpaired');
    await assert.rejects(readFile(join(temporary.directory, 'pairing.json')), { code: 'ENOENT' });
  } finally {
    await helper.stop();
    await new Promise<void>((done) => server.close(() => done()));
    await temporary.remove();
  }
});

test('a pairing response cannot replace the origin approved in the native dialog', async () => {
  const api = await companionPromise;
  assert.ok(api);
  const temporary = await temporaryDirectory();
  const helper = new api.LocalAgentCompanion({ dataDir: temporary.directory, name: 'Test', native: idleNative(),
    fetch: async () => Response.json({ token, deviceId, origin: 'https://example.com' }) });
  try {
    await helper.pair(`squabble://pair?origin=http%3A%2F%2Flocalhost%3A3000&code=${code}`, async () => true);
    assert.equal(helper.status.origin, 'http://localhost:3000');
    assert.equal(JSON.parse(await readFile(join(temporary.directory, 'pairing.json'), 'utf8')).origin, 'http://localhost:3000');
  } finally { await helper.stop(); await temporary.remove(); }
});

test('shutdown ignores commands from an in-flight poll response', async () => {
  const api = await companionPromise;
  assert.ok(api);
  const temporary = await temporaryDirectory();
  let finishPoll: (() => void) | undefined;
  const gate = new Promise<void>((done) => { finishPoll = done; });
  let runs = 0;
  const helper = new api.LocalAgentCompanion({ dataDir: temporary.directory, name: 'Test',
    native: { ...idleNative(), runNativeAgent: async () => { runs += 1; return { text: '', usageTokens: null }; } },
    fetch: async (url) => {
      if (String(url).endsWith('/pair')) return Response.json({ token, deviceId });
      await gate;
      return Response.json({ commands: [{ id: 'after-stop', kind: 'run', provider: 'codex', prompt: 'Research' }], cancelTaskIds: [] });
    },
  });
  try {
    await helper.pair(`squabble://pair?origin=http%3A%2F%2Flocalhost%3A3000&code=${code}`, async () => true);
    const poll = helper.pollOnce();
    const stop = helper.stop();
    finishPoll?.();
    await Promise.all([poll, stop]);
    assert.equal(runs, 0);
  } finally { finishPoll?.(); await helper.stop(); await temporary.remove(); }
});

test('shutdown while a native pairing dialog is open cannot pair or restart the helper', async () => {
  const api = await companionPromise;
  assert.ok(api);
  const temporary = await temporaryDirectory();
  let releaseDialog: (() => void) | undefined;
  const dialog = new Promise<void>((done) => { releaseDialog = done; });
  let requests = 0;
  const helper = new api.LocalAgentCompanion({ dataDir: temporary.directory, name: 'Test', native: idleNative(),
    fetch: async () => { requests += 1; return Response.json({ token, deviceId }); } });
  try {
    const pairing = helper.pair(`squabble://pair?origin=http%3A%2F%2Flocalhost%3A3000&code=${code}`,
      async () => { await dialog; return true; });
    await helper.stop();
    releaseDialog?.();
    assert.equal(await pairing, false);
    assert.equal(requests, 0);
    assert.equal(helper.status.state, 'unpaired');
  } finally { releaseDialog?.(); await helper.stop(); await temporary.remove(); }
});

test('a command cancelled before delivery remains cancelled on subsequent delivery', async () => {
  let runs = 0;
  const f = await fixture({ runNativeAgent: async () => { runs += 1; return { text: '', usageTokens: null }; } });
  try {
    const command = { id: 'already-cancelled', kind: 'run', provider: 'codex', prompt: 'Research' };
    f.response({ commands: [command], cancelTaskIds: [command.id] });
    await f.helper.pollOnce();
    f.response({ commands: [command], cancelTaskIds: [] });
    await f.helper.pollOnce();
    assert.equal(runs, 0);
    assert.equal(f.sent.at(-1)?.updates[0]?.state, 'cancelled');
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('oversized reports fail with a generic message and updates stay within protocol batch limits', async () => {
  const f = await fixture({ runNativeAgent: async () => ({ text: 'x'.repeat(512_001), usageTokens: null }) });
  try {
    f.response({ commands: Array.from({ length: 20 }, (_, index) => ({
      id: `task-${index}`, kind: 'run', provider: 'codex', prompt: 'Research',
    })), cancelTaskIds: [] });
    await f.helper.pollOnce();
    await settle();
    f.response({ commands: [], cancelTaskIds: [] });
    await f.helper.pollOnce();
    assert.equal(f.sent.at(-1)?.updates.length, 16);
    assert.ok(f.sent.at(-1)?.updates.every((update) => update.state === 'failed' && update.text === undefined));
    await f.helper.pollOnce();
    assert.equal(f.sent.at(-1)?.updates.length, 4);
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('report limits measure UTF-8 bytes and serialized poll batches fit the server body limit', async () => {
  let report = '中'.repeat(180_000);
  const f = await fixture({ runNativeAgent: async () => ({ text: report, usageTokens: null }) });
  try {
    f.response({ commands: [{ id: 'utf8', kind: 'run', provider: 'codex', prompt: 'Research' }], cancelTaskIds: [] });
    await f.helper.pollOnce();
    await settle();
    f.response({ commands: [], cancelTaskIds: [] });
    await f.helper.pollOnce();
    assert.equal(f.sent.at(-1)?.updates[0]?.state, 'failed');
    report = 'x'.repeat(400_000);
    f.response({ commands: Array.from({ length: 3 }, (_, index) => ({
      id: `large-${index}`, kind: 'run', provider: 'codex', prompt: 'Research',
    })), cancelTaskIds: [] });
    await f.helper.pollOnce();
    await settle();
    f.response({ commands: [], cancelTaskIds: [] });
    await f.helper.pollOnce();
    assert.equal(f.sent.at(-1)?.updates.length, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(f.sent.at(-1))) <= 900_000);
    await f.helper.pollOnce();
    assert.equal(f.sent.at(-1)?.updates.length, 1);
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});

test('an individually oversized serialized update becomes failed instead of retrying a rejected body', async () => {
  const f = await fixture({ runNativeAgent: async () => ({ text: '\u0001'.repeat(200_000), usageTokens: null }) });
  try {
    f.response({ commands: [{ id: 'escaped-output', kind: 'run', provider: 'codex', prompt: 'Research' }], cancelTaskIds: [] });
    await f.helper.pollOnce();
    await settle();
    f.response({ commands: [], cancelTaskIds: [] });
    await f.helper.pollOnce();
    assert.equal(f.sent.at(-1)?.updates[0]?.state, 'failed');
    assert.ok(Buffer.byteLength(JSON.stringify(f.sent.at(-1))) <= 900_000);
    await f.helper.pollOnce();
    assert.equal(f.sent.at(-1)?.updates.length, 0);
  } finally { await f.helper.stop(); await f.temporary.remove(); }
});
