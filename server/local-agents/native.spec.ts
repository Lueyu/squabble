import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createNativeRuntime } from './native';
import { nativeChildEnv } from './environment';
import { resolveNativeCommand } from './resolver';
import { buildLoginCommand } from './login';
import { NativeEventCollector } from './events';

const fixtureBody = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-cli 1.2.3'); process.exit(0); }
if (args.includes('status')) {
  const state = fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth-state'), 'utf8');
  if (state === 'hang') { setInterval(() => {}, 1000); }
  else {
    const ready = state === 'ready' || state === 'pretty';
    console.log(args.includes('auth') ? JSON.stringify({loggedIn: ready}, null, state === 'pretty' ? 2 : undefined) : ready ? 'ready' : state);
    process.exit(ready ? 0 : 1);
  }
} else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => prompt += chunk);
  process.stdin.on('end', () => {
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'capture.json'), JSON.stringify({args, prompt, env:process.env}));
    const mode = fs.readFileSync(path.join(process.env.CODEX_HOME, 'run-mode'), 'utf8');
    const emit = event => console.log(JSON.stringify(event));
    if (mode === 'hang') { setInterval(() => {}, 1000); return; }
    if (mode === 'overflow') { console.log('x'.repeat(100000)); return; }
    if (mode === 'failure') { console.error('PRIVATE_TOKEN_DO_NOT_EXPOSE'); process.exit(3); }
    if (mode === 'incomplete') { emit({type:'item.completed',item:{type:'agent_message',text:'Partial'}}); return; }
    if (args.includes('-p')) {
      emit({type:'assistant',message:{content:[{type:'text',text:'Interim'}]}});
      emit({type:'result',subtype: mode === 'protocol_failure' ? 'error_during_execution' : 'success',
        is_error:mode === 'protocol_failure', result:'Research complete', usage:{input_tokens:3,output_tokens:5,cache_read_input_tokens:2}});
    } else {
      emit({type:'item.started',item:{type:'web_search'}});
      emit({type:'item.completed',item:{type:'agent_message',text:'Research complete'}});
      emit({type:mode === 'protocol_failure' ? 'turn.failed' : 'turn.completed',usage:{input_tokens:3,output_tokens:5}});
    }
  });
}
`;

async function fixture(run: (value: {root: string; runtime: ReturnType<typeof createNativeRuntime>}) => Promise<void>,
  limits: { authTimeoutMs?: number; runTimeoutMs?: number; maxOutputBytes?: number } = {}): Promise<void> {
  const root: string = await mkdtemp(join(tmpdir(), 'squabble-native-'));
  const bin: string = join(root, 'bin');
  await mkdir(bin);
  for (const [provider, pkg, entry] of [
    ['codex', '@openai/codex', 'bin/codex.js'], ['claude', '@anthropic-ai/claude-code', 'cli.js'],
  ]) {
    const packageRoot: string = join(bin, 'node_modules', pkg);
    const script: string = join(packageRoot, entry);
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, fixtureBody);
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: pkg, bin: {[provider]: entry} }));
    // Exercise Windows npm shims even on Unix by explicitly selecting win32 in the resolver.
    await writeFile(join(bin, `${provider}.cmd`), `@echo off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\${pkg.replaceAll('/', '\\')}\\${entry.replaceAll('/', '\\')}" %*`);
  }
  await writeFile(join(root, 'auth-state'), 'ready');
  await writeFile(join(root, 'run-mode'), 'success');
  const runtime = createNativeRuntime({
    env: { PATH: bin, CODEX_HOME: root, HOME: root, USERPROFILE: root,
      JWT_SECRET: 'jwt-fixture', SQUABBLE_COMPANION_TOKEN: 'companion-fixture', DATABASE_URL:'database-fixture' },
    platform: 'win32', home: root, nodeExecutable: process.execPath, fallbackDirectories: [], ...limits,
  });
  try { await run({root, runtime}); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('native research uses stdin, inherited auth home and fixed safe Codex argv without app secrets', async () => {
  await fixture(async ({root, runtime}) => {
    const prompt: string = 'Research "AAPL"; $(touch should-not-run) & more';
    const progress: string[] = [];
    const result = await runtime.runNativeAgent('codex', prompt, {
      root, signal: new AbortController().signal, onProgress: (text: string) => progress.push(text),
    });
    assert.deepEqual(result, {text:'Research complete',usageTokens:8});
    const captured = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
    assert.equal(captured.prompt, prompt);
    assert.equal(captured.args.includes(prompt), false);
    assert.ok(captured.args.indexOf('--search') < captured.args.indexOf('exec'));
    assert.equal(captured.args[captured.args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(captured.args.includes('--ignore-user-config'), false);
    assert.equal(captured.env.CODEX_HOME, root);
    assert.equal(captured.env.JWT_SECRET, undefined);
    assert.equal(captured.env.SQUABBLE_COMPANION_TOKEN, undefined);
    assert.equal(captured.env.DATABASE_URL, undefined);
    assert.ok(progress.length > 0);
  });
});

test('Claude preserves subscription login and restricts actual tools, preferring its final result', async () => {
  await fixture(async ({root, runtime}) => {
    const result = await runtime.runNativeAgent('claude', 'Research', {
      root, signal:new AbortController().signal, onProgress:() => undefined,
    });
    assert.deepEqual(result, {text:'Research complete',usageTokens:10});
    const {args} = JSON.parse(await readFile(join(root, 'capture.json'), 'utf8'));
    assert.equal(args.includes('--bare'), false);
    assert.equal(args.includes('--dangerously-skip-permissions'), false);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read,Glob,Grep');
    assert.ok(args.includes('--strict-mcp-config'));
  });
});

test('discovery returns readiness without executing research or exposing credentials', async () => {
  await fixture(async ({root,runtime}) => {
    const agents = await runtime.detectNativeAgents();
    assert.deepEqual(agents.map((agent) => agent.state), ['ready','ready']);
    assert.ok(agents.every((agent) => agent.version === 'fixture-cli 1.2.3'));
    await assert.rejects(readFile(join(root,'capture.json')));
    await writeFile(join(root,'auth-state'), 'not logged in');
    assert.deepEqual((await runtime.detectNativeAgents()).map((agent) => agent.state), ['login_required','login_required']);
  });
});

test('absent native tools are not installed and cannot execute', async () => {
  const runtime = createNativeRuntime({env:{PATH:''},home:join(tmpdir(),'squabble-nonexistent-home'),fallbackDirectories:[]});
  assert.deepEqual((await runtime.detectNativeAgents()).map((agent) => agent.state),['not_installed','not_installed']);
  await assert.rejects(runtime.runNativeAgent('codex','hello',{root:tmpdir(),signal:new AbortController().signal,onProgress:()=>undefined}),/NATIVE_AGENT_NOT_INSTALLED/);
  await assert.rejects(runtime.openNativeLogin('codex'),/NATIVE_AGENT_NOT_INSTALLED/);
});

test('authentication timeouts are bounded and reported as errors, not absent installations', async () => {
  await fixture(async ({root,runtime}) => {
    await writeFile(join(root,'auth-state'),'hang');
    assert.deepEqual((await runtime.detectNativeAgents()).map((agent) => agent.state),['error','error']);
  }, {authTimeoutMs:150});
});

test('cancelled and timed out research terminate their child and never return partial success', async () => {
  await fixture(async ({root,runtime}) => {
    await writeFile(join(root,'run-mode'),'hang');
    const controller = new AbortController();
    const result = runtime.runNativeAgent('codex','hello',{root,signal:controller.signal,onProgress:()=>undefined});
    setTimeout(() => controller.abort(),150);
    await assert.rejects(result,/NATIVE_AGENT_CANCELLED/);
    await assert.rejects(runtime.runNativeAgent('codex','hello',{root,signal:new AbortController().signal,onProgress:()=>undefined}),/NATIVE_AGENT_TIMEOUT/);
  }, {runTimeoutMs:400});
});

test('oversized output and provider failures cannot leak stderr or return a false completion', async () => {
  await fixture(async ({root,runtime}) => {
    for (const [mode,code] of [['overflow','NATIVE_AGENT_OUTPUT_LIMIT'],['failure','NATIVE_AGENT_FAILED'],['incomplete','NATIVE_AGENT_INCOMPLETE'],['protocol_failure','NATIVE_AGENT_FAILED']]) {
      await writeFile(join(root,'run-mode'),mode);
      await assert.rejects(runtime.runNativeAgent('codex','hello',{root,signal:new AbortController().signal,onProgress:()=>undefined}),
        (error: Error) => error.message.includes(code) && !error.message.includes('PRIVATE_TOKEN'));
    }
    await writeFile(join(root,'run-mode'),'protocol_failure');
    await assert.rejects(runtime.runNativeAgent('claude','hello',{root,signal:new AbortController().signal,onProgress:()=>undefined}),/NATIVE_AGENT_FAILED/);
  },{maxOutputBytes:8192});
});

test('child environment preserves native provider identity while excluding application and Node injection secrets', () => {
  const env = nativeChildEnv({PATH:'bin',HOME:'home',CODEX_HOME:'codex-home',CLAUDE_CONFIG_DIR:'claude-home',
    OPENAI_API_KEY:'provider-key',ANTHROPIC_AUTH_TOKEN:'provider-token',HTTP_PROXY:'proxy',
    NODE_OPTIONS:'--require evil',ELECTRON_RUN_AS_NODE:'1',SETTINGS_ENCRYPTION_KEY:'app-key',COMPANION_TOKEN:'private',CUSTOM_PASSWORD:'private'});
  assert.equal(env.OPENAI_API_KEY,'provider-key');
  assert.equal(env.CLAUDE_CONFIG_DIR,'claude-home');
  assert.equal(env.HTTP_PROXY,'proxy');
  for (const key of ['NODE_OPTIONS','ELECTRON_RUN_AS_NODE','SETTINGS_ENCRYPTION_KEY','COMPANION_TOKEN','CUSTOM_PASSWORD']) assert.equal(env[key],undefined);
});

test('resolver respects PATH precedence and refuses arbitrary Windows scripts', async () => {
  const root: string = await mkdtemp(join(tmpdir(),'squabble-resolver-'));
  try {
    const first: string = join(root,'first');
    const second: string = join(root,'second');
    await mkdir(first); await mkdir(second);
    await writeFile(join(first,'codex.exe'),'fixture');
    await writeFile(join(second,'codex.exe'),'fixture');
    const options = {env:{PATH:`${first};${second}`},platform:'win32' as const,home:root,fallbackDirectories:[]};
    assert.equal(resolveNativeCommand('codex',options)?.executable,resolve(first,'codex.exe'));
    await writeFile(join(first,'claude.cmd'),'@echo stole-data');
    assert.equal(resolveNativeCommand('claude',options),null);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('Unix resolver supports executable files and login command quotes executable paths as data', async () => {
  const root: string = await mkdtemp(join(tmpdir(),'squabble-unix-resolver-'));
  try {
    const path: string = join(root,'codex');
    await writeFile(path,'#!/bin/sh\nexit 0'); await chmod(path,0o755);
    const spec = resolveNativeCommand('codex',{env:{PATH:''},platform:'linux',home:root,fallbackDirectories:[root]});
    assert.equal(spec?.executable,path);
    const command = buildLoginCommand('claude',{executable:"/tmp/it's a tool",prefixArgs:['cli.js']},'linux');
    assert.equal(command,"'/tmp/it'\\''s a tool' 'cli.js' 'auth' 'login'");
    const windows = buildLoginCommand('codex',{executable:"C:\\it's a tool\\codex.exe",prefixArgs:[]},'win32');
    assert.equal(windows,"& 'C:\\it''s a tool\\codex.exe' 'login'");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('Unix npm wrappers use an explicit Node executable even when the GUI PATH has no node', async () => {
  await fixture(async ({root}) => {
    const path: string = join(root,'bin','codex');
    await writeFile(path,'#!/usr/bin/env node\n'); await chmod(path,0o755);
    const spec = resolveNativeCommand('codex',{env:{PATH:''},platform:'linux',home:root,
      fallbackDirectories:[join(root,'bin')],nodeExecutable:process.execPath});
    assert.equal(spec?.executable,process.execPath);
    assert.deepEqual(spec?.prefixArgs,[join(root,'bin','node_modules','@openai','codex','bin','codex.js')]);
  });
});

test('already cancelled, oversized and empty prompts never start a provider process', async () => {
  await fixture(async ({root,runtime}) => {
    const controller = new AbortController(); controller.abort();
    const run = {root,signal:controller.signal,onProgress:()=>undefined};
    await assert.rejects(runtime.runNativeAgent('codex','hello',run),/NATIVE_AGENT_CANCELLED/);
    for (const prompt of ['', 'x'.repeat(256*1024+1)]) {
      await assert.rejects(runtime.runNativeAgent('codex',prompt,{...run,signal:new AbortController().signal}),/NATIVE_AGENT_INVALID_PROMPT/);
    }
    await assert.rejects(readFile(join(root,'capture.json')));
  });
});

test('Claude readiness accepts the native pretty-printed auth status JSON', async () => {
  await fixture(async ({root,runtime}) => {
    await writeFile(join(root,'auth-state'),'pretty');
    assert.deepEqual((await runtime.detectNativeAgents()).map((agent) => agent.state),['ready','ready']);
  });
});

test('invalid or incomplete usage remains unknown instead of manufacturing a zero total', () => {
  for (const usage of [{input_tokens:3}, {input_tokens:-1,output_tokens:4}, {input_tokens:3,output_tokens:'4'},
    {input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:3}]) {
    const events = new NativeEventCollector('codex',()=>undefined);
    events.read(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Report'}}));
    events.read(JSON.stringify({type:'turn.completed',usage}));
    assert.equal(events.result().usageTokens,null);
  }
  const claude = new NativeEventCollector('claude',()=>undefined);
  claude.read(JSON.stringify({type:'result',subtype:'success',result:'Report',usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:-1}}));
  assert.equal(claude.result().usageTokens,null);
});

test('final report removes common secret formats and progress uses stable English text', () => {
  const progress: string[] = [];
  const events = new NativeEventCollector('codex',(text: string) => progress.push(text));
  events.read(JSON.stringify({type:'item.started',item:{type:'web_search'}}));
  events.read(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Report Bearer abcdefghijklmnopqrstuvwxyz sk-proj-abcdefghijklmnopqrstuvwx'}}));
  events.read(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));
  assert.equal(events.result().usageTokens,0);
  assert.equal(events.result().text.includes('abcdefghijklmnopqrstuvwxyz'),false);
  assert.equal(events.result().text.includes('sk-proj-'),false);
  assert.deepEqual(progress,['Searching sources…','Preparing research results…']);
});

test('research creates a private task cwd and removes it after success and failure', async () => {
  await fixture(async ({root,runtime}) => {
    for (const mode of ['success','failure']) {
      await writeFile(join(root,'run-mode'),mode);
      const taskRoot: string = join(root,'workspaces',mode);
      const promise = runtime.runNativeAgent('codex','research',{root:taskRoot,signal:new AbortController().signal,onProgress:()=>undefined});
      if (mode === 'success') await promise;
      else await assert.rejects(promise,/NATIVE_AGENT_FAILED/);
      await assert.rejects(readdir(taskRoot));
    }
  });
});

test('login reports a missing native terminal instead of claiming login started', async () => {
  await fixture(async ({root}) => {
    const path: string = join(root,'bin','codex');
    await writeFile(path,'#!/usr/bin/env node\n'); await chmod(path,0o755);
    const runtime = createNativeRuntime({env:{PATH:''},platform:'linux',home:root,
      fallbackDirectories:[join(root,'bin')],nodeExecutable:process.execPath});
    await assert.rejects(runtime.openNativeLogin('codex'),/NATIVE_LOGIN_TERMINAL_UNAVAILABLE/);
  });
});
