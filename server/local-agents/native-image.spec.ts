import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeRuntime } from './native';
import * as validation from './native-image';
import { MAX_NATIVE_IMAGE_BYTES, type NativeAgentImage } from '../../shared/native-image.interface';

const image: NativeAgentImage = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOBsAAAAASUVORK5CYII=' };

test('image boundary accepts canonical supported images and rejects invalid or oversized attachments', () => {
  assert.deepEqual(validation.validateNativeImage(image), image);
  for (const invalid of [null, {}, { ...image, filename: '../escape.png' }, { ...image, mimeType: 'text/plain' },
    { ...image, data: `data:image/png;base64,${image.data}` }, { ...image, data: image.data + '\n' },
    { ...image, data: Buffer.from('not an image').toString('base64') }, { ...image, mimeType: 'image/jpeg' },
    { ...image, data: Buffer.alloc(MAX_NATIVE_IMAGE_BYTES + 1).toString('base64') }]) {
    assert.throws(() => validation.validateNativeImage(invalid), { message: 'NATIVE_AGENT_INVALID_IMAGE' });
  }
});

for (const provider of ['codex', 'opencode'] as const) test(`${provider} passes an actual private image file and removes it after completion`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-image-fixture-'));
  const script = join(root, 'fixture.cjs');
  await writeFile(script, `const fs=require('node:fs');const args=process.argv.slice(2);
    if(args.includes('mcp')){console.log('[]');process.exit(0)}
    let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
      const imagePath=args[args.indexOf('${provider === 'codex' ? '--image' : '--file'}')+1];
      fs.writeFileSync(${JSON.stringify(join(root, 'capture.json'))},JSON.stringify({args,prompt,cwd:process.cwd(),imagePath,image:fs.readFileSync(imagePath).toString('base64'),env:process.env}));
      ${provider === 'codex' ? `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"holdings":[]}'}}));console.log(JSON.stringify({type:'turn.completed'}));` : `console.log(JSON.stringify({type:'text',part:{text:'{"holdings":[]}'}}));console.log(JSON.stringify({type:'step_finish',part:{reason:'stop',tokens:{input:1,output:1}}}));`}
    });`);
  const runtime = createNativeRuntime({ commandResolver: () => ({ executable: process.execPath, prefixArgs: [script] }), env: {}, home: root });
  try {
    await runtime.runNativeAgent(provider, 'Extract the attached screenshot', { root: join(root, 'work'), image,
      signal: new AbortController().signal, onProgress: () => undefined });
    const captured = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
    assert.equal(captured.image, image.data);
    assert.equal(captured.prompt.includes(image.data), false);
    assert.equal(captured.args.includes('--search'), false);
    assert.equal(captured.imagePath, join(captured.cwd, 'attachment.png'));
    if (provider === 'codex') assert.equal(captured.args[captured.args.indexOf('--sandbox') + 1], 'read-only');
    else assert.deepEqual(JSON.parse(captured.env.OPENCODE_PERMISSION), { '*': 'deny' });
    await assert.rejects(readFile(captured.imagePath), { code: 'ENOENT' });
    assert.deepEqual((await readdir(root)).sort(), ['capture.json', 'fixture.cjs']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['failure', 'cancel'] as const) test(`image workspace is removed after ${mode}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'squabble-image-stop-'));
  const script = join(root, 'fixture.cjs');
  await writeFile(script, `const fs=require('node:fs');const args=process.argv.slice(2);
    if(args.includes('mcp')){console.log('[]');process.exit(0)}
    const attachment=args[args.indexOf('--image')+1];fs.writeFileSync(${JSON.stringify(join(root, 'started'))},attachment);
    ${mode === 'failure' ? 'process.exit(2)' : 'setInterval(()=>{},1000)'};`);
  const runtime = createNativeRuntime({ commandResolver: () => ({ executable: process.execPath, prefixArgs: [script] }), env: {}, home: root });
  const controller = new AbortController();
  const running = runtime.runNativeAgent('codex', 'Extract', { root: join(root, 'work'), image,
    signal: controller.signal, onProgress: () => undefined });
  const rejected = assert.rejects(running, { message: mode === 'failure' ? 'NATIVE_AGENT_FAILED' : 'NATIVE_AGENT_CANCELLED' });
  try {
    let path = '';
    for (let attempt = 0; attempt < 200 && !path; attempt++) {
      path = await readFile(join(root, 'started'), 'utf8').catch(() => '');
      if (!path) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(path);
    if (mode === 'cancel') { assert.equal((await readFile(path)).toString('base64'), image.data); controller.abort(); }
    await rejected;
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally { controller.abort(); await rejected; await rm(root, { recursive: true, force: true }); }
});

test('runtime rejects unsupported image providers before invoking any CLI', async () => {
  let resolved = false;
  const runtime = createNativeRuntime({ commandResolver: () => { resolved = true; return null; } });
  await assert.rejects(runtime.runNativeAgent('claude', 'Extract', { root: 'unused', image,
    signal: new AbortController().signal, onProgress: () => undefined }), { message: 'NATIVE_AGENT_IMAGE_UNSUPPORTED' });
  assert.equal(resolved, false);
});
