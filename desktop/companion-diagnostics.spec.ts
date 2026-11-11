import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalAgentCompanion, type NativeRuntime } from './companion.mts';

for (const legacy of [false, true]) test(`Companion carries fixed native evidence and never replays work (legacy=${legacy})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-companion-diagnostics-'));
  const token = 'b'.repeat(64); const id = '11111111-1111-4111-8111-111111111111';
  let runs = 0; let commands = true;
  const polls: Array<{ updates: Array<Record<string, unknown>> }> = [];
  const native: NativeRuntime = { detectNativeAgents: async () => [], openNativeLogin: async () => undefined,
    runNativeAgent: async (_provider, _prompt, options) => {
      runs++;
      options.onDiagnostic?.({ id: 'spawn', stage: 'process', status: 'running', at: new Date().toISOString() });
      throw Object.assign(new Error('NATIVE_AGENT_NETWORK_FAILED'), { failure: { code: 'LOCAL_NETWORK_UNAVAILABLE',
        stage: 'runtime', exitCode: 3, outputBytes: 0, stderrBytes: 20, terminalEvent: false, recoveries: ['retry_member'], stderr: 'PRIVATE_STDERR' } });
    } };
  const helper = new LocalAgentCompanion({ dataDir: root, name: 'Fixture', native, fetch: async (url, options) => {
    if (String(url).endsWith('/pair')) return Response.json({ token, deviceId: id });
    const body = JSON.parse(String(options?.body)); polls.push(body);
    if (legacy && body.updates.some((row: Record<string, unknown>) => row.diagnostics || row.failure || row.error === 'LOCAL_NETWORK_UNAVAILABLE')) return new Response('', { status: 400 });
    return Response.json({ commands: commands ? [{ id, provider: 'claude', kind: 'run', prompt: 'PRIVATE_PROMPT' }] : [], cancelTaskIds: [] });
  } });
  try {
    await helper.pair(`squabble://pair?origin=http%3A%2F%2Flocalhost%3A3000&code=${'a'.repeat(48)}`, async () => true);
    await helper.pollOnce(); await new Promise<void>(done => setImmediate(done)); commands = false;
    await helper.pollOnce();
    const full = polls.find(body => body.updates.some(row => row.failure))?.updates[0];
    assert.ok(full); assert.equal(full.error, 'LOCAL_NETWORK_UNAVAILABLE');
    assert.deepEqual(full.failure, { code: 'LOCAL_NETWORK_UNAVAILABLE', stage: 'runtime', exitCode: 3, outputBytes: 0,
      stderrBytes: 20, terminalEvent: false, recoveries: ['retry_member'] });
    assert.equal((full.diagnostics as Array<{ id: string }>)[0].id, 'spawn');
    assert.doesNotMatch(JSON.stringify(polls), /PRIVATE|stderr"|prompt"/);
    assert.equal(helper.status.state, 'connected'); await helper.pollOnce();
    assert.deepEqual(polls.at(-1)?.updates, []); assert.equal(runs, 1);
  } finally { await helper.stop(); await rm(root, { recursive: true, force: true }); }
});

test('a silent Companion run advertises adapter coverage before public output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-companion-silence-'));
  const id = '11111111-1111-4111-8111-111111111111'; let first = true;
  let finish: (value: { text: string; usageTokens: null }) => void = () => undefined;
  const polls: Array<{ updates: Array<Record<string, unknown>> }> = [];
  const helper = new LocalAgentCompanion({ dataDir: root, name: 'Fixture', native: { detectNativeAgents: async () => [],
    openNativeLogin: async () => undefined, runNativeAgent: async () => new Promise(resolve => { finish = resolve; }) },
  fetch: async (url, options) => {
    if (String(url).endsWith('/pair')) return Response.json({ token: 'b'.repeat(64), deviceId: id });
    polls.push(JSON.parse(String(options?.body)));
    const commands = first ? [{ id, provider: 'claude', kind: 'run', prompt: 'Research' }] : []; first = false;
    return Response.json({ commands, cancelTaskIds: [] });
  } });
  try {
    await helper.pair(`squabble://pair?origin=http%3A%2F%2Flocalhost%3A3000&code=${'a'.repeat(48)}`, async () => true);
    await helper.pollOnce(); await helper.pollOnce();
    assert.equal(polls.at(-1)?.updates[0]?.activityCapability, 'tools');
    assert.equal(polls.at(-1)?.updates[0]?.state, 'running');
  } finally { finish({ text: 'report', usageTokens: null }); await helper.stop(); await rm(root, { recursive: true, force: true }); }
});
