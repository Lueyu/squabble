import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionReadiness } from './execution-readiness';
import type { LocalAgentConnection } from '../../../shared/local-agents.interface';
import { LocalAgentsService } from './local-agents.service';
import { LocalAgentStore } from './local-agents.store';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const connection: LocalAgentConnection = { id: 'native-opencode', provider: 'opencode', name: 'OpenCode', state: 'ready', connected: true, available: true, busy: false, source: 'native', loginCommand: '', installUrl: '', models: [{ id: 'gateway/deepseek-v4-flash', name: 'DeepSeek' }], defaultModel: 'deepseek-v4-flash' };
test('an unambiguous bare OpenCode default is resolved to its provider/model id', () => {
  const result = executionReadiness(connection);
  assert.equal(result.connected, true); assert.equal(result.executable, true); assert.equal(result.state, 'ready');
  assert.equal(result.effectiveModel.id, 'gateway/deepseek-v4-flash');
  assert.deepEqual(result.route, { mode: 'local', agentId: connection.id, agentSettings: { model: 'gateway/deepseek-v4-flash' } }, 'the actual route must carry the resolved model');
});
test('ambiguous bare OpenCode models cannot choose a provider or dispatch', () => {
  const result = executionReadiness({ ...connection, models: [...connection.models!, { id: 'other/deepseek-v4-flash', name: 'Another provider' }] });
  assert.equal(result.executable, false); assert.equal(result.state, 'configuration_required');
  assert.equal(result.route, undefined);
});
test('resolved OpenCode model keeps its explicit advertised reasoning variant', () => {
  const settings = { model: 'deepseek-v4-flash', reasoningEffort: 'high' };
  const result = executionReadiness({ ...connection, reasoningEfforts: [], models: [{ ...connection.models![0], reasoningEfforts: ['high'] }] }, settings);
  assert.equal(result.executable, true);
  assert.deepEqual(result.route?.agentSettings, { model: 'gateway/deepseek-v4-flash', reasoningEffort: 'high' });
  assert.deepEqual(settings, { model: 'deepseek-v4-flash', reasoningEffort: 'high' }, 'native preferences are never rewritten');
});
test('an unresolvable bare OpenCode model still requires configuration', () => {
  const bare = { ...connection, models: [{ id: 'gateway/other-model', name: 'Other' }] };
  const result = executionReadiness(bare);
  assert.equal(result.executable, false); assert.equal(result.state, 'configuration_required');
  assert.equal(result.failure?.code, 'LOCAL_INVALID_CONFIGURATION');
});
test('explicit app provider/model override wins without changing the default', () => {
  const result = executionReadiness(connection, { model: 'gateway/deepseek-v4-flash' });
  assert.equal(result.executable, true); assert.equal(result.effectiveModel.id, 'gateway/deepseek-v4-flash');
  assert.deepEqual(result.route, { mode: 'local', agentId: connection.id, agentSettings: { model: 'gateway/deepseek-v4-flash' } });
  assert.equal(connection.defaultModel, 'deepseek-v4-flash');
});
test('unknown native model remains honest and busy routes are not dispatched', () => {
  const codex = { ...connection, provider: 'codex' as const, id: 'native-codex', defaultModel: undefined };
  assert.equal(executionReadiness(codex).effectiveModel.verified, false);
  assert.equal(executionReadiness({ ...codex, busy: true }).state, 'busy');
  assert.equal(executionReadiness({ ...codex, busy: true }).executable, false);
});
test('bounded metadata caching avoids repeated probes and explicit invalidation refreshes it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'readiness-cache-'));let probes=0;
  try{
    const store=new LocalAgentStore(root);await store.connectNative('owner','codex');
    const service=new LocalAgentsService({detectNativeAgents:async()=>{probes++;return[{...connection,provider:'codex',defaultModel:undefined}];},openNativeLogin:async()=>{},runNativeAgent:async()=>{throw new Error('No provider requests allowed');}} as never,store);
    Object.defineProperty(service,'mode',{get:()=> 'native'});
    await service.readiness('owner');await service.readiness('owner');assert.equal(probes,1);
    service.invalidateDetection();await service.readiness('owner');assert.equal(probes,2);
    await assert.rejects(service.execute('owner',{agentId:'native-codex',messageId:'fixture',prompt:'Fixture',activityContext:{sessionId:'fixture',memberId:'one'},
      onTask:async()=>{},onProgress:async()=>{},shouldContinue:async()=>true} as never),/LOCAL_INVALID_INPUT/u);
    await service.onModuleDestroy();
  }finally{await rm(root,{recursive:true,force:true});}
});
