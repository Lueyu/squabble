import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeRuntime } from './native';
import type { ResearchActivity } from '../../shared/research-events.interface';
import type { LocalAgentProvider } from '../../shared/local-agents.interface';

const fixtureBody: string = String.raw`
const fs = require('node:fs'); const path = require('node:path');
const provider = process.argv[2], args = process.argv.slice(3), root = process.env.CODEX_HOME;
const emit = value => console.log(JSON.stringify(value));
const mode = fs.readFileSync(path.join(root,'mode'),'utf8');
fs.appendFileSync(path.join(root,'calls'), JSON.stringify(args)+'\n');
if (args.includes('--version')) console.log(mode === 'old' ? '0.1.0' : provider === 'codex' ? 'codex-cli 0.104.0' : '2.1.221 (Claude Code)');
else if (args.includes('mcp') && args.includes('list')) {
  const overrides = args.filter((arg,i)=>args[i-1]==='-c');
  const added = overrides.find(arg=>/^mcp_servers\.squabble_.*\.url=/.test(arg));
  const name = added?.split('.')[1];
  emit([{name:'unrelated',enabled:mode==='unsafe'||!overrides.includes('mcp_servers.unrelated.enabled=false')},
    ...(name ? [{name,enabled:true}] : [])]);
} else {
 let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',x=>input+=x);
 process.stdin.on('end',async()=>{
  try {
   let url, token;
   if(provider==='claude') {
    const config=JSON.parse(args[args.indexOf('--mcp-config')+1]);
    const server=Object.values(config.mcpServers)[0]; url=server?.url;
    if(server) token=server.headers.Authorization.replace(/\$\{([^}]+)\}/g,(_,name)=>process.env[name]).slice(7);
   } else {
    const value=args.find(arg=>/^mcp_servers\.squabble_.*\.url=/.test(arg));
    url=value && JSON.parse(value.slice(value.indexOf('=')+1));
    token=process.env.SQUABBLE_RESEARCH_MCP_TOKEN;
   }
   let report='Snapshot report';
   if(url) {
    const rpc=async(method,params={},id=1)=>(await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id,method,params})})).json();
    await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
    const list=await rpc('tools/list'); if(list.result.tools[0].name!=='squabble_quote') throw Error('missing tool');
    const called=await rpc('tools/call',{name:'squabble_quote',arguments:{ticker:'TEST'}},3);
    report='Quote '+called.result.structuredContent.data.price;
   }
   fs.writeFileSync(path.join(root,'capture'),JSON.stringify({args,input,url,token,env:process.env}));
   if(provider==='claude') emit({type:'result',subtype:'success',result:report});
   else {emit({type:'item.completed',item:{type:'agent_message',text:report}});emit({type:'turn.completed'});}
  }catch { process.exitCode=1; }
 });
}
`;

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider} subprocess actually invokes the private MCP tools and removes its bridge afterwards`, async () => {
    const root: string = await mkdtemp(join(tmpdir(), 'squabble-mcp-run-'));
    try {
      await writeFile(join(root, 'fixture.cjs'), fixtureBody); await writeFile(join(root, 'mode'), 'success');
      const runtime = createNativeRuntime({ home: root, env: { CODEX_HOME: root, HOME: root, JWT_SECRET: 'PRIVATE_APP_TOKEN' },
        commandResolver: (selected: LocalAgentProvider) => ({ executable: process.execPath, prefixArgs: [join(root, 'fixture.cjs'), selected] }) });
      const activity: ResearchActivity[] = []; let count: number = 0;
      const report = await runtime.runNativeAgent(provider, 'Research TEST', { root: join(root, 'tasks'), signal: new AbortController().signal,
        onProgress: () => undefined, onEvent: event => activity.push(event), researchTools: {
          snapshot: 'shared dated evidence', descriptors: [{ name: 'squabble_quote', description: 'Quote', inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }],
          call: async request => { count++; assert.equal(request.name, 'squabble_quote'); return { status: 'succeeded', data: { price: 42 }, sources: [], asOf: '2026-11-03', truncated: false }; },
        } });
      assert.equal(report.text, 'Quote 42'); assert.equal(count, 1);
      const capture = JSON.parse(await readFile(join(root, 'capture'), 'utf8'));
      assert.equal(capture.env.JWT_SECRET, undefined); assert.ok(capture.input.includes('shared dated evidence'));
      assert.equal(JSON.stringify(activity).includes(capture.token), false);
      assert.equal(capture.args.some((arg: string) => arg.includes(capture.token)), false);
      if (provider === 'codex') {
        assert.ok(capture.args.includes('mcp_servers.unrelated.enabled=false'));
        assert.ok(capture.args.includes('features.plugins=false'));
        assert.ok(capture.args.includes('read-only'));
      } else {
        assert.ok(capture.args.includes('--strict-mcp-config')); assert.ok(capture.args.includes('dontAsk'));
        assert.match(capture.args[capture.args.indexOf('--allowedTools') + 1], /mcp__squabble_/u);
      }
      await assert.rejects(fetch(capture.url)); await assert.rejects(readdir(join(root, 'tasks')));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('old version uses a snapshot; unverifiable Codex MCP isolation fails closed before model execution', async () => {
  const root: string = await mkdtemp(join(tmpdir(), 'squabble-mcp-fallback-'));
  try {
    await writeFile(join(root, 'fixture.cjs'), fixtureBody);
    const runtime = createNativeRuntime({ home: root, env: { CODEX_HOME: root, HOME: root },
      commandResolver: () => ({ executable: process.execPath, prefixArgs: [join(root, 'fixture.cjs'), 'codex'] }) });
    for (const mode of ['old', 'unsafe']) {
      await writeFile(join(root, 'mode'), mode);
      const activity: ResearchActivity[] = [];
      const execution = runtime.runNativeAgent('codex', 'Research TEST', { root: join(root, 'tasks'), signal: new AbortController().signal,
        onProgress: () => undefined, onEvent: event => activity.push(event), researchTools: {
          snapshot: 'dated fallback evidence', descriptors: [{ name: 'squabble_quote', description: 'Quote', inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }],
          call: async () => { throw new Error('must not run'); },
        } });
      if (mode === 'unsafe') {
        await assert.rejects(execution, /NATIVE_AGENT_TOOL_ISOLATION_FAILED/u);
        const calls: string[][] = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.ok(calls.at(-1)?.includes('list'));
        continue;
      }
      const report = await execution;
      assert.equal(report.text, 'Snapshot report');
      const capture = JSON.parse(await readFile(join(root, 'capture'), 'utf8'));
      assert.equal(capture.url, undefined); assert.equal(capture.env.SQUABBLE_RESEARCH_MCP_TOKEN, undefined);
      assert.ok(capture.input.includes('dated fallback evidence'));
      assert.ok(capture.args.includes('mcp_servers.unrelated.enabled=false'));
      assert.ok(activity.some(event => event.kind === 'capability' && event.status === 'unavailable'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancelling a native run aborts its active MCP call and disposes the task workspace', async () => {
  const root: string = await mkdtemp(join(tmpdir(), 'squabble-mcp-cancel-'));
  try {
    await writeFile(join(root, 'fixture.cjs'), fixtureBody); await writeFile(join(root, 'mode'), 'success');
    const runtime = createNativeRuntime({ home: root, env: { CODEX_HOME: root, HOME: root },
      commandResolver: () => ({ executable: process.execPath, prefixArgs: [join(root, 'fixture.cjs'), 'codex'] }) });
    const cancellation = new AbortController(); let signal: AbortSignal | undefined;
    await assert.rejects(runtime.runNativeAgent('codex', 'Research TEST', { root: join(root, 'tasks'), signal: cancellation.signal,
      onProgress: () => undefined, researchTools: { snapshot: '', descriptors: [{ name: 'squabble_quote', description: 'Quote', inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }],
        call: async (_request, incoming) => { signal = incoming; cancellation.abort(); return new Promise(() => undefined); },
      } }), /NATIVE_AGENT_CANCELLED/u);
    assert.equal(signal?.aborted, true);
    await assert.rejects(readdir(join(root, 'tasks')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
