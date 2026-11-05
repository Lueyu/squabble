import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const api = import('./companion.mts');
const image = { mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOBsAAAAASUVORK5CYII=' };
const code = 'a'.repeat(48); const token = 'b'.repeat(64); const deviceId = '11111111-1111-4111-8111-111111111111';
const command = { id: 'image-task', kind: 'run', provider: 'codex', prompt: 'Extract', hasImage: true, image };

async function fixture(imageInput: boolean | undefined, run: (context: {
  helper: InstanceType<(Awaited<typeof api>)['LocalAgentCompanion']>;
  setResponse: (response: unknown) => void; calls: unknown[]; updates: Array<{ state: string; error?: string; progress?: string }>;
  root: string;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'squabble-companion-image-'));
  const { LocalAgentCompanion } = await api;
  let response: unknown = { commands: [], cancelTaskIds: [] };
  const calls: unknown[] = []; const updates: Array<{ state: string; error?: string; progress?: string }> = [];
  const helper = new LocalAgentCompanion({ dataDir: root, name: 'Test', native: {
    detectNativeAgents: async () => [{ provider: 'codex', state: 'ready', name: 'Codex', loginCommand: 'codex login', installUrl: 'https://example.test', imageInput }],
    openNativeLogin: async () => undefined,
    runNativeAgent: async (_provider, _prompt, options) => { calls.push(options.image); options.onProgress(image.data);
      options.onEvent?.({ id: 'unsafe', at: new Date().toISOString(), kind: 'summary', status: 'succeeded', summary: image.data });
      return { text: '[]', usageTokens: null }; },
  }, fetch: async (url, options) => {
    if (String(url).endsWith('/pair')) return Response.json({ token, deviceId });
    const body = JSON.parse(String(options?.body)); updates.push(...body.updates);
    return Response.json(response);
  } });
  try {
    await helper.pair(`squabble://pair?origin=http%3A%2F%2Flocalhost%3A3000&code=${code}`, async () => true);
    await helper.pollOnce(); await new Promise<void>(resolve => setImmediate(resolve));
    await run({ helper, setResponse: value => { response = value; }, calls, updates, root });
  } finally { await helper.stop(); await rm(root, { recursive: true, force: true }); }
}

test('companion forwards a validated image without persisting or echoing attachment bytes', async () => fixture(true, async context => {
  context.setResponse({ commands: [command], cancelTaskIds: [] });
  await context.helper.pollOnce(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(context.calls, [image]);
  context.setResponse({ commands: [], cancelTaskIds: [] }); await context.helper.pollOnce();
  assert.equal(JSON.stringify(context.updates).includes(image.data), false);
  assert.equal((await readFile(join(context.root, 'pairing.json'), 'utf8')).includes(image.data), false);
}));

for (const imageInput of [false, undefined]) test(`companion rejects image when current runtime capability is ${imageInput}`, async () => fixture(imageInput, async context => {
  context.setResponse({ commands: [command], cancelTaskIds: [] }); await context.helper.pollOnce();
  await new Promise<void>(resolve => setImmediate(resolve));
  context.setResponse({ commands: [], cancelTaskIds: [] }); await context.helper.pollOnce();
  assert.deepEqual(context.calls, []);
  assert.ok(context.updates.some(update => update.error === 'LOCAL_IMAGE_UNSUPPORTED'));
}));

test('companion refuses missing or invalid image payloads without starting a text-only run', async () => fixture(true, async context => {
  context.setResponse({ commands: [{ ...command, image: undefined }], cancelTaskIds: [] }); await context.helper.pollOnce();
  await new Promise<void>(resolve => setImmediate(resolve));
  context.setResponse({ commands: [], cancelTaskIds: [] }); await context.helper.pollOnce();
  assert.ok(context.updates.some(update => update.error === 'LOCAL_INVALID_INPUT'));
  context.setResponse({ commands: [{ ...command, id: 'invalid-image', image: { ...image, data: 'c2VjcmV0' } }], cancelTaskIds: [] });
  await context.helper.pollOnce(); assert.deepEqual(context.calls, []);
}));

test('companion accepts bounded image responses larger than the old 2 MiB ceiling', async () => fixture(true, async context => {
  const bytes = Buffer.alloc(2 * 1024 * 1024); Buffer.from(image.data, 'base64').copy(bytes);
  const large = { ...image, data: bytes.toString('base64') };
  context.setResponse({ commands: [{ ...command, image: large }], cancelTaskIds: [] });
  await context.helper.pollOnce(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(context.calls, [large]);
}));
