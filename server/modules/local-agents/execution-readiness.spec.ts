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
test('credentials do not hide OpenCode bare default with empty actual model', () => {
  const result = executionReadiness(connection);
  assert.equal(result.connected, true); assert.equal(result.executable, false); assert.equal(result.state, 'configuration_required');
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
