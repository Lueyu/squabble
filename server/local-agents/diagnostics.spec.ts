import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNativeRuntime } from './native';
import type { NativeDiagnosticEvent } from '../../shared/local-agent-diagnostics.interface';
import { safeExecutionFailure } from './failures';
import { NativeEventCollector } from './events';

async function fixture(script: string, run: (runtime: ReturnType<typeof createNativeRuntime>, root: string) => Promise<void>, timeout = 2000) {
  const root = await mkdtemp(join(tmpdir(), 'squabble-diagnostics-'));
  const runtime = createNativeRuntime({ home: root, env: {}, runTimeoutMs: timeout,
    commandResolver: () => ({ executable: process.execPath, prefixArgs: ['-e', script, '--'] }) });
  try { await run(runtime, root); } finally { await rm(root, { recursive: true, force: true }); }
}
const success = `console.error('PRIVATE_STDERR');console.log(JSON.stringify({type:'result',subtype:'success',result:'report',usage:{input_tokens:1,output_tokens:2}}))`;

test('runtime reports preflight, actual process spawn, first output and result counters without content', async () => {
  await fixture(success, async (runtime, root) => {
    const events: NativeDiagnosticEvent[] = [];
    assert.deepEqual(await runtime.runNativeAgent('claude', 'PRIVATE_PROMPT', { root, signal: new AbortController().signal,
      onProgress: () => undefined, onDiagnostic: event => events.push(event) }), { text: 'report', usageTokens: 3 });
    assert.deepEqual(events.map(event => `${event.stage}:${event.status}`), ['preflight:running', 'preflight:succeeded', 'process:running', 'output:running', 'process:succeeded', 'result:succeeded']);
    assert.equal(events.at(-1)?.terminalEvent, true);
    assert.equal(events.at(-1)?.exitCode, 0);
    assert.ok(Number(events.at(-1)?.outputBytes) > 0);
    assert.ok(Number(events.at(-1)?.stderrBytes) > 0);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|report|--output-format/);
  });
});
test('runtime entry with invalid configuration never claims process spawn', async () => {
  await fixture(success, async (runtime, root) => {
    const events: NativeDiagnosticEvent[] = [];
    await assert.rejects(runtime.runNativeAgent('claude', 'prompt', { root, signal: new AbortController().signal,
      agentSettings: { model: '\u0000' }, onProgress: () => undefined, onDiagnostic: event => events.push(event) }), /INVALID_CONFIGURATION/);
    assert.deepEqual(events.map(event => event.stage), ['preflight', 'preflight']);
    assert.equal(events[1].code, 'LOCAL_INVALID_CONFIGURATION');
  });
});
test('preflight CLI probes never claim research process spawn or output', async () => {
  const script = `if(process.argv.includes('mcp'))console.log('[]');else{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'report'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}}))}`;
  await fixture(script, async (runtime, root) => {
    const events: NativeDiagnosticEvent[] = [];
    const result = await runtime.runNativeAgent('codex', 'prompt', { root, signal: new AbortController().signal,
      onProgress: () => undefined, onDiagnostic: event => events.push(event) });
    assert.equal(result.text, 'report');
    assert.equal(events.filter(event => event.stage === 'process' && event.status === 'running').length, 1);
    assert.equal(events.filter(event => event.stage === 'output').length, 1);
    assert.equal(events.findIndex(event => event.stage === 'process'), 2);
  });
});
test('all observation callbacks are isolated from successful execution', async () => {
  await fixture(success, async (runtime, root) => {
    assert.equal((await runtime.runNativeAgent('claude', 'prompt', { root, signal: new AbortController().signal,
      onProgress: () => { throw new Error('observer'); }, onEvent: () => { throw new Error('observer'); },
      onDiagnostic: () => { throw new Error('observer'); } })).text, 'report');
  });
});
test('asynchronous observer rejections cannot escape the native execution', async () => {
  await fixture(success, async (runtime, root) => {
    assert.equal((await runtime.runNativeAgent('claude', 'prompt', { root, signal: new AbortController().signal,
      onProgress: async () => { throw new Error('observer'); }, onEvent: async () => { throw new Error('observer'); },
      onDiagnostic: async () => { throw new Error('observer'); } })).text, 'report');
  });
});
test('a successful Kimi process never invents a protocol terminal event', () => {
  const collector = new NativeEventCollector('kimi', () => undefined);
  collector.read(JSON.stringify({ role: 'assistant', content: 'report' })); collector.completeProcess();
  assert.equal(collector.result().text, 'report'); assert.equal(collector.terminalEvent, false);
});
test('a failed spawn never claims a running process and preserves launch failure evidence', async () => {
  const runtime = createNativeRuntime({ commandResolver: () => ({ executable: join(tmpdir(), 'missing-squabble-fixture-executable'), prefixArgs: [] }) });
  const events: NativeDiagnosticEvent[] = [];
  await assert.rejects(runtime.runNativeAgent('claude', 'prompt', { root: tmpdir(), signal: new AbortController().signal,
    onProgress: () => undefined, onDiagnostic: event => events.push(event) }), error => {
    const failure = safeExecutionFailure(error); assert.equal(failure.code, 'LOCAL_LAUNCH_FAILED'); assert.equal(failure.exitCode, -1); return true;
  });
  assert.equal(events.some(event => event.stage === 'process' && event.status === 'running'), false);
});
test('OpenCode primary transport diagnostics retain network failure before a hung CLI timeout', async () => {
  await fixture(`console.error('level=ERROR service=llm small=false message="stream error" error="ECONNREFUSED PRIVATE"');setInterval(()=>{},1000)`, async (runtime, root) => {
    await assert.rejects(runtime.runNativeAgent('opencode', 'prompt', { root, signal: new AbortController().signal,
      onProgress: () => undefined }), error => {
      assert.equal(safeExecutionFailure(error).code, 'LOCAL_NETWORK_UNAVAILABLE'); return true;
    });
  }, 1000);
});
test('ordinary assistant prose cannot turn an unrelated process error into a network failure', async () => {
  const script = `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Research discusses proxy voting rules and a timeout in a sporting event.'}]}}));console.error('Invalid provider configuration');process.exitCode=3`;
  await fixture(script, async (runtime, root) => {
    const events: NativeDiagnosticEvent[] = [];
    await assert.rejects(runtime.runNativeAgent('claude', 'prompt', { root, signal: new AbortController().signal,
      onProgress: () => undefined, onDiagnostic: event => events.push(event) }), error => {
      const failure = safeExecutionFailure(error); assert.equal(failure.code, 'LOCAL_TASK_FAILED');
      assert.equal(failure.exitCode, 3); return true;
    });
    assert.equal(events.at(-1)?.code, 'LOCAL_TASK_FAILED');
  });
});
for (const [script, code, terminalEvent] of [
  [`console.error('ECONNREFUSED PRIVATE');process.exitCode=3`, 'LOCAL_NETWORK_UNAVAILABLE', false],
  [`console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'fetch failed PRIVATE'}))`, 'LOCAL_NETWORK_UNAVAILABLE', false],
  [`console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'partial'}]}}))`, 'LOCAL_PROTOCOL_INCOMPLETE', false],
  [`console.log(JSON.stringify({type:'result',subtype:'success',result:''}))`, 'LOCAL_PROTOCOL_INCOMPLETE', true],
  [`setInterval(()=>{},1000)`, 'LOCAL_TIMEOUT', false],
] as const) test(`runtime retains structured ${code} evidence`, async () => {
  await fixture(script, async (runtime, root) => {
    const events: NativeDiagnosticEvent[] = [];
    await assert.rejects(runtime.runNativeAgent('claude', 'prompt', { root, signal: new AbortController().signal,
      onProgress: () => undefined, onDiagnostic: event => events.push(event) }), error => {
      const failure = safeExecutionFailure(error);
      assert.equal(failure.code, code); assert.equal(failure.terminalEvent, terminalEvent);
      assert.equal(failure.stage, 'runtime'); assert.ok(Number.isInteger(failure.exitCode));
      return true;
    });
    assert.equal(events.at(-1)?.code, code);
  }, code === 'LOCAL_TIMEOUT' ? 100 : 2000);
});
