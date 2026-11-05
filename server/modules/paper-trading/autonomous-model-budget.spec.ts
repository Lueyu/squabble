import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { StrategyModelService } from './strategy-model.service';

test('separate durable dispatch identities share the stricter research token budget task', async () => {
  const taskIds: string[] = [];
  const llm = { chatFastJSON: async (_messages: unknown, _owner: string, options: { taskId: string }) => { taskIds.push(options.taskId); return { data: { ok: true } }; } };
  const service = new StrategyModelService(llm as never, {} as never);
  await service.json('owner', { id: 'one', role: 'researcher', name: 'One', model: 'fast', instructions: '' }, 'dispatch-one', 'autonomous', 'facts', async () => true, true, 'shared-research-budget');
  await service.json('owner', { id: 'two', role: 'manager', name: 'Two', model: 'fast', instructions: '' }, 'dispatch-two', 'autonomous', 'facts', async () => true, true, 'shared-research-budget');
  assert.deepEqual(taskIds, ['shared-research-budget', 'shared-research-budget']);
});

test('native staging and runtime handoff share one strict token reservation', async () => {
  let reservations = 0; let settlements = 0;
  const budget = { reserve: async (_owner: string, input: { taskId: string }) => { reservations++; assert.equal(input.taskId, 'shared-native-research'); return { id: 'reserved' }; }, settle: async () => { settlements++; } };
  const local = { execute: async (_owner: string, options: { onDispatch: () => Promise<void>; messageId: string }) => {
    assert.equal(options.messageId, 'native-unique-delivery'); await options.onDispatch(); await options.onDispatch(); return { text: '{"ok":true}', usageTokens: null };
  } };
  const service = new StrategyModelService({} as never, local as never, budget as never);
  await service.json('owner', { id: 'one', role: 'researcher', name: 'One', model: 'fast', instructions: '', executionMode: 'local', agentId: 'native:codex' }, 'native-unique-delivery', 'autonomous', 'facts', async () => true, true, 'shared-native-research');
  assert.equal(reservations, 1); assert.equal(settlements, 1);
});
