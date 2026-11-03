import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeRuntime, type NativeRuntimeOptions } from './native';
import { NativeEventCollector } from './events';
import { LOCAL_AGENT_PROVIDERS, type LocalAgentProvider } from '../../shared/local-agents.interface';
import { kimiMetadata, parseModels } from './metadata';

const body: string = `
const fs = require('node:fs'); const path = require('node:path');
const provider = process.argv[2]; const args = process.argv.slice(3); const root = process.env.CODEX_HOME;
const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8');
const emit = value => console.log(JSON.stringify(value));
fs.appendFileSync(path.join(root,'calls'), JSON.stringify({provider,args})+'\\n');
if (args.includes('--version')) { console.log(provider === 'kimi' ? 'kimi-code 0.40.0' : provider+' 1.5.0'); }
else if(args.includes('--help')) { console.log('--model --effort --variant --agent-file --output-format --input-format --config --mode'); }
else if (provider === 'codex' && args.join(' ') === 'login status') { console.log('Logged in using ChatGPT'); }
else if (provider === 'claude' && args.join(' ') === 'auth status') { emit({loggedIn:true}); }
else if (provider === 'antigravity' && args.includes('models')) {
  if(args.indexOf('--output-format')>args.indexOf('models')) { process.exitCode=1; console.error('flags provided but not defined: -output-format'); }
  else emit({status:'SUCCESS',command:{name:'models',data:{models:[{id:'gemini-research',label:'Gemini Research',supported_efforts:['low','high']}]}}});
}
else if (provider === 'antigravity' && args.includes('/usage')) { emit({usage:{remaining:1}}); }
else if (provider === 'opencode' && args.includes('models')) { console.log('openai/research'); emit({id:'research',providerID:'openai',name:'Research',variants:{high:{},low:{}}}); }
else if (provider === 'opencode' && args.includes('auth')) { console.log('1 credentials'); }
else if (provider === 'kimi' && args.includes('doctor')) { console.log('config.toml: OK'); }
else if (provider === 'doubao' && args.includes('models')) { emit({models:[{id:'1',name:'Research Model',available:true,modes:['work']}]}); }
else if (provider === 'doubao' && args.includes('status') && !args.includes('sessions')) { emit({platform:'headless',loggedIn:mode!=='logged-out',loginRequired:mode==='logged-out'}); }
else if (provider === 'doubao' && args.includes('create')) {
  fs.writeFileSync(path.join(root,'capture-'+provider),JSON.stringify({args,env:process.env,cwd:process.cwd()}));
  if(mode==='missing-receipt') emit({status:'running',accepted:true,reply:null});
  else emit({conversationId:'conversation-1',runId:'run-1',status:'running',accepted:true,reply:null});
}
else if (provider === 'doubao' && args.includes('stop')) { emit({stopped:mode!=='stop-failure',status:'cancelled'}); }
else if (provider === 'doubao' && args.includes('wait')) {
  if(mode==='hang'||mode==='stop-failure') setInterval(()=>{},1000);
  else emit({conversationId:'conversation-1',runId:'run-1',status:mode==='waiting-input'?'waiting_input':'completed',reply:{role:'assistant',text:'Research complete'}});
}
else {
  let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',x=>input+=x);
  process.stdin.on('end',()=>{
    const files = {};
    const visit = dir => { for(const entry of fs.readdirSync(dir,{withFileTypes:true})) { const file=path.join(dir,entry.name); if(entry.isDirectory())visit(file); else files[path.relative(process.cwd(),file)] = fs.readFileSync(file,'utf8'); }};
    visit(process.cwd());
    fs.writeFileSync(path.join(root,'capture-'+provider),JSON.stringify({args,input,env:process.env,cwd:process.cwd(),files}));
    if(mode==='hang') { setInterval(()=>{},1000); return; }
    if(mode==='failure') { console.error('private credential'); process.exitCode=1; return; }
    if(provider==='codex') { emit({type:'item.completed',item:{type:'agent_message',text:'Research complete'}}); emit({type:'turn.completed',usage:{input_tokens:2,output_tokens:3}}); }
    if(provider==='claude') emit({type:'result',subtype:'success',result:'Research complete',usage:{input_tokens:2,output_tokens:3}});
    if(provider==='gemini') { emit({type:'tool_use',tool_name:'google_web_search'}); emit({type:'message',role:'assistant',content:'Research complete',delta:true}); emit({type:'result',status:'success',stats:{input_tokens:2,output_tokens:3,total_tokens:5}}); }
    if(provider==='antigravity') { emit({event:'step_update',step_update:{step_type:'tool',tool_name:'search_web'}}); emit({event:'result',result:{status:'SUCCESS',response:'Research complete',usage:{input_tokens:2,output_tokens:3,total_tokens:5}}}); }
    if(provider==='opencode') { emit({type:'text',part:{text:'Research complete'}}); emit({type:'step_finish',part:{reason:'stop',tokens:{input:2,output:3,reasoning:0,cache:{read:0,write:0}}}}); }
    if(provider==='kimi') { emit({role:'assistant',content:'Research complete',usage:{input_tokens:2,output_tokens:3}}); }
  });
}
`;

async function fixture(run: (value: {root:string; runtime:ReturnType<typeof createNativeRuntime>}) => Promise<void>,
  extra: Partial<NativeRuntimeOptions> = {}): Promise<void> {
  const root: string = await mkdtemp(join(tmpdir(), 'squabble-seven-'));
  try {
    await writeFile(join(root,'fixture.cjs'),body); await writeFile(join(root,'mode'),'success');
    await mkdir(join(root,'.gemini')); await writeFile(join(root,'.gemini','oauth_creds.json'),JSON.stringify({refresh_token:'fixture'}));
    await writeFile(join(root,'.gemini','settings.json'),JSON.stringify({security:{auth:{selectedType:'oauth-personal'}}}));
    await mkdir(join(root,'.kimi-code'));
    await writeFile(join(root,'.kimi-code','config.toml'),'default_model = "kimi-code/research"\n[providers."managed:kimi-code"]\ntype = "kimi"\napi_key = "fixture"\n[models."kimi-code/research"]\nprovider = "managed:kimi-code"\nmodel = "research"\nsupport_efforts = ["low", "high"]\n');
    const runtime = createNativeRuntime({home:root,env:{HOME:root,USERPROFILE:root,CODEX_HOME:root},
      commandResolver:(provider:LocalAgentProvider) => ({executable:process.execPath,prefixArgs:[join(root,'fixture.cjs'),provider]}),
      authTimeoutMs:3000,runTimeoutMs:3000,...extra});
    await run({root,runtime});
  } finally { await rm(root,{recursive:true,force:true}); }
}

test('seven native agents expose bounded model/effort metadata without running paid prompts',async()=>{
  await fixture(async({root,runtime})=>{
    const statuses = await runtime.detectNativeAgents();
    assert.deepEqual(statuses.map(s=>s.provider),[...LOCAL_AGENT_PROVIDERS]);
    assert.ok(statuses.every(s=>s.state==='ready'));
    assert.equal(statuses.find(s=>s.provider==='doubao')?.models?.[0].id,'Research Model');
    assert.deepEqual(statuses.find(s=>s.provider==='kimi')?.models?.[0].reasoningEfforts,['low','high']);
    assert.deepEqual(statuses.find(s=>s.provider==='antigravity')?.models?.[0],{id:'gemini-research',name:'Gemini Research',reasoningEfforts:['low','high']});
    assert.deepEqual(statuses.find(s=>s.provider==='claude')?.models?.map(model=>model.id),['opus','sonnet','haiku']);
    assert.equal((await readdir(root)).filter(name=>name.startsWith('capture-')).length,0);
    assert.ok(statuses.every(status => status.researchTools?.mode));
  });
});

for (const provider of ['gemini', 'antigravity', 'opencode', 'kimi', 'doubao'] as const) {
  test(`${provider} receives dated fallback evidence without changing its read-only tool restrictions`, async () => {
    await fixture(async ({ root, runtime }) => {
      const activity: Array<{ kind: string; status: string }> = [];
      await runtime.runNativeAgent(provider, 'Research TEST', { root: join(root, 'tasks'), signal: new AbortController().signal,
        onProgress: () => undefined, onEvent: event => activity.push(event), researchTools: {
          snapshot: 'Shared evidence for TEST as of 2026-11-03', descriptors: [],
          call: async () => { throw new Error('Snapshot adapters must not call the bridge'); },
        } });
      const capture = JSON.parse(await readFile(join(root, `capture-${provider}`), 'utf8'));
      assert.ok(JSON.stringify(capture).includes('Shared evidence for TEST'));
      assert.equal(capture.env.SQUABBLE_RESEARCH_MCP_TOKEN, undefined);
      assert.ok(activity.some(event => event.kind === 'capability' && event.status === 'unavailable'));
      const calls = (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.ok(calls.some(call => call.provider === provider && call.args.includes('--version')));
    });
  });
}

for (const provider of LOCAL_AGENT_PROVIDERS) {
  test(`${provider} executes a configured research turn with its native protocol`,async()=>{
    await fixture(async({root,runtime})=>{
      const model: string = provider==='kimi'?'kimi-code/research':provider==='doubao'?'Research Model':provider==='opencode'?'openai/research':provider==='gemini'?'gemini-3.1-pro-preview':'research-model';
      const result = await runtime.runNativeAgent(provider,'Research & literal $(shell)',{root:join(root,'tasks'),
        signal:new AbortController().signal,onProgress:()=>undefined,agentSettings:{model,reasoningEffort:'high'}});
      assert.equal(result.text,'Research complete');
      const captured = JSON.parse(await readFile(join(root,'capture-'+provider),'utf8'));
      assert.ok(captured.args.includes(model));
      const serialized: string = JSON.stringify(captured);
      assert.ok(serialized.toLowerCase().includes('high'));
      assert.equal(captured.env.DATABASE_URL,undefined);
      await assert.rejects(readdir(join(root,'tasks')));
      if(provider==='antigravity') assert.equal(JSON.parse(captured.input).message.content,'Research & literal $(shell)');
      if(provider==='kimi') assert.ok(serialized.includes('subagents: []'));
      if(provider==='doubao') {
        assert.ok(captured.args.includes('headless')); assert.ok(captured.args.includes('cloud'));
        assert.equal(captured.args.includes('--wait'),false);
      }
    });
  });
}

test('unsupported reasoning fails before model execution rather than silently falling back',async()=>{
  await fixture(async({root,runtime})=>{
    for(const provider of LOCAL_AGENT_PROVIDERS) await assert.rejects(runtime.runNativeAgent(provider,'research',{
      root:join(root,'tasks'),signal:new AbortController().signal,onProgress:()=>undefined,
      agentSettings:{model:'research',reasoningEffort:'invented'}}),/NATIVE_AGENT_CONFIGURATION_UNSUPPORTED/);
    assert.equal((await readdir(root)).filter(name=>name.startsWith('capture-')).length,0);
  });
});

test('Doubao cancellation stops the accepted upstream run, not just the wait process',async()=>{
  await fixture(async({root,runtime})=>{
    await writeFile(join(root,'mode'),'hang');
    const controller = new AbortController();
    const promise = runtime.runNativeAgent('doubao','research',{root:join(root,'tasks'),signal:controller.signal,onProgress:()=>undefined});
    setTimeout(()=>controller.abort(),500);
    await assert.rejects(promise,/NATIVE_AGENT_CANCELLED/);
    const calls: Array<{args:string[]}> = (await readFile(join(root,'calls'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(calls.some(c=>c.args.includes('stop')&&c.args.includes('conversation-1')&&c.args.includes('run-1')));
  });
});

test('new protocol parsers require a terminal result and never return tool or thinking content',()=>{
  for(const provider of ['gemini','antigravity','opencode','kimi'] as const) {
    const collector = new NativeEventCollector(provider,()=>undefined);
    collector.read(JSON.stringify({type:'tool_result',content:'PRIVATE_TOOL_DATA'}));
    assert.throws(()=>collector.result(),/NATIVE_AGENT_INCOMPLETE/);
  }
});

test('Doubao unconfirmed stop retains only recovery IDs and reports uncertainty',async()=>{
  await fixture(async({root,runtime})=>{
    await writeFile(join(root,'mode'),'stop-failure');
    const controller = new AbortController();
    const promise = runtime.runNativeAgent('doubao','research',{root:join(root,'tasks'),signal:controller.signal,onProgress:()=>undefined});
    setTimeout(()=>controller.abort(),500);
    await assert.rejects(promise,/NATIVE_AGENT_CANCEL_UNCONFIRMED/);
    const receipt = JSON.parse(await readFile(join(root,'tasks','doubao-recovery.json'),'utf8'));
    assert.equal(receipt.conversationId,'conversation-1'); assert.equal(receipt.runId,'run-1');
    assert.equal(receipt.state,'unconfirmed'); assert.equal(JSON.stringify(receipt).includes('fixture'),false);
  });
});

test('Doubao accepted submission with missing IDs is uncertain and never retried',async()=>{
  await fixture(async({root,runtime})=>{
    await writeFile(join(root,'mode'),'missing-receipt');
    await assert.rejects(runtime.runNativeAgent('doubao','research',{root:join(root,'tasks'),
      signal:new AbortController().signal,onProgress:()=>undefined}),/NATIVE_AGENT_UPSTREAM_PENDING/);
    assert.equal(JSON.parse(await readFile(join(root,'tasks','doubao-recovery.json'),'utf8')).state,'unconfirmed');
    const calls = (await readFile(join(root,'calls'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(calls.filter(c=>c.args.includes('create')).length,1);
  });
});

test('local credential files alone do not make Gemini or Kimi ready',async()=>{
  await fixture(async({root,runtime})=>{
    await writeFile(join(root,'.gemini','oauth_creds.json'),'{}');
    await writeFile(join(root,'.kimi-code','config.toml'),'default_model = "missing"\n[models.fake]\nmodel="fake"\nprovider="fake"\n');
    const statuses = await runtime.detectNativeAgents();
    assert.equal(statuses.find(s=>s.provider==='gemini')?.state,'login_required');
    assert.equal(statuses.find(s=>s.provider==='kimi')?.state,'login_required');
  });
});

test('per-run restrictions and Gemini thinking config do not write global settings',async()=>{
  await fixture(async({root,runtime})=>{
    const original: string = await readFile(join(root,'.gemini','settings.json'),'utf8');
    await runtime.runNativeAgent('gemini','research',{root:join(root,'tasks'),signal:new AbortController().signal,
      onProgress:()=>undefined,agentSettings:{model:'gemini-3.1-pro-preview',reasoningEffort:'low'}});
    const captured = JSON.parse(await readFile(join(root,'capture-gemini'),'utf8'));
    const config = JSON.parse(Object.values(captured.files)[0] as string);
    assert.equal(config.modelConfigs.overrides[0].modelConfig.generateContentConfig.thinkingConfig.thinkingLevel,'LOW');
    assert.equal(config.hooksConfig.enabled,false); assert.equal(config.admin.mcp.enabled,false);
    assert.ok(!config.tools.core.includes('run_shell_command'));
    assert.equal(await readFile(join(root,'.gemini','settings.json'),'utf8'),original);
  });
});

test('model choices use Codex cache and Claude native settings without returning private configuration',async()=>{
  await fixture(async({root,runtime})=>{
    await writeFile(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'codex-research',display_name:'Codex Research',
      supported_reasoning_levels:[{effort:'low'},{effort:'high'}]},{slug:'internal',visibility:'hide'}],private:'fixture-secret'}));
    await mkdir(join(root,'.claude'));
    await writeFile(join(root,'.claude','settings.json'),JSON.stringify({model:'sonnet',env:{PRIVATE_SECRET:'do-not-return'}}));
    const statuses = await runtime.detectNativeAgents();
    assert.deepEqual(statuses.find(s=>s.provider==='codex')?.models,[{id:'codex-research',name:'Codex Research',reasoningEfforts:['low','high']}]);
    assert.ok(statuses.find(s=>s.provider==='claude')?.models?.some(model=>model.id==='sonnet'));
    assert.equal(JSON.stringify(statuses).includes('fixture-secret'),false);
    assert.equal(JSON.stringify(statuses).includes('do-not-return'),false);
  });
});

test('installed Codex model efforts take priority over historical defaults',async()=>{
  await fixture(async({root,runtime})=>{
    await writeFile(join(root,'models_cache.json'),JSON.stringify({models:[{slug:'codex-new',supported_reasoning_levels:[{effort:'ultra'}]}]}));
    const result = await runtime.runNativeAgent('codex','research',{root:join(root,'tasks'),signal:new AbortController().signal,
      onProgress:()=>undefined,agentSettings:{model:'codex-new',reasoningEffort:'ultra'}});
    assert.equal(result.text,'Research complete');
  });
});

test('explicitly empty model reasoning capabilities remain empty',()=>{
  assert.deepEqual(parseModels('antigravity',JSON.stringify({models:[{id:'no-thinking',supported_efforts:[]}]}))[0].reasoningEfforts,[]);
});

test('Antigravity uses disposable settings and data paths instead of original mutable account settings',async()=>{
  await fixture(async({root,runtime})=>{
    await mkdir(join(root,'.gemini','antigravity-cli'));
    await writeFile(join(root,'.gemini','antigravity-cli','settings.json'),JSON.stringify({model:'native-model',toolPermission:'auto-approve'}));
    await runtime.runNativeAgent('antigravity','research',{root:join(root,'tasks'),signal:new AbortController().signal,onProgress:()=>undefined});
    const captured = JSON.parse(await readFile(join(root,'capture-antigravity'),'utf8'));
    assert.ok(captured.args.includes('--app_data_dir=antigravity-cli'));
    assert.ok(captured.args.some((arg:string)=>arg.startsWith('--gemini_dir='+captured.cwd)));
    const settings = Object.values(captured.files).map((value:unknown)=>String(value)).find((value:string)=>value.includes('toolPermission'));
    assert.ok(settings?.includes('read_url(*)'));
    assert.equal(JSON.parse(settings!).model,'native-model');
  });
});

test('Kimi preserves native effort and forwards only the selected provider declared credential',async()=>{
  await fixture(async({root})=>{
    await writeFile(join(root,'.kimi-code','config.toml'),'default_model="research"\n[models.research]\nmodel="research"\nprovider="chosen"\n[providers.chosen]\ntype="kimi"\napi_key_env="MY_KIMI_KEY"\n');
    const runtime = createNativeRuntime({home:root,env:{HOME:root,USERPROFILE:root,CODEX_HOME:root,MY_KIMI_KEY:'native-secret',UNRELATED_SECRET:'hidden',DATABASE_URL:'hidden',KIMI_MODEL_THINKING_EFFORT:'high'},
      commandResolver:(provider:LocalAgentProvider)=>({executable:process.execPath,prefixArgs:[join(root,'fixture.cjs'),provider]})});
    assert.equal((await runtime.detectNativeAgents()).find(row=>row.provider==='kimi')?.state,'ready');
    await runtime.runNativeAgent('kimi','research',{root:join(root,'tasks'),signal:new AbortController().signal,onProgress:()=>undefined});
    const captured = JSON.parse(await readFile(join(root,'capture-kimi'),'utf8'));
    assert.equal(captured.env.MY_KIMI_KEY,'native-secret');
    assert.equal(captured.env.KIMI_MODEL_THINKING_EFFORT,'high');
    assert.equal(captured.env.DATABASE_URL,undefined); assert.equal(captured.env.UNRELATED_SECRET,undefined);
    const config = await readFile(join(root,'.kimi-code','config.toml'),'utf8');
    await writeFile(join(root,'.kimi-code','config.toml'),config.replace('MY_KIMI_KEY','DATABASE_URL'));
    assert.equal((await runtime.detectNativeAgents()).find(row=>row.provider==='kimi')?.state,'login_required');
  });
});

test('Kimi readiness requires nonempty credentials for the exact configured OAuth key',async()=>{
  await fixture(async({root})=>{
    await writeFile(join(root,'.kimi-code','config.toml'),'default_model="research"\n[models.research]\nmodel="research"\nprovider="managed"\n[providers.managed]\ntype="kimi"\n[providers.managed.oauth]\nstorage="file"\nkey="kimi-code"\n');
    await mkdir(join(root,'.kimi-code','credentials'));
    await writeFile(join(root,'.kimi-code','credentials','other.json'),JSON.stringify({access_token:'unrelated'}));
    assert.equal(kimiMetadata({home:root,env:{}}).state,'login_required');
    await writeFile(join(root,'.kimi-code','credentials','kimi-code.json'),JSON.stringify({access_token:'',refresh_token:''}));
    assert.equal(kimiMetadata({home:root,env:{}}).state,'login_required');
    await writeFile(join(root,'.kimi-code','credentials','kimi-code.json'),JSON.stringify({refresh_token:'saved'}));
    assert.equal(kimiMetadata({home:root,env:{}}).state,'ready');
  });
});
