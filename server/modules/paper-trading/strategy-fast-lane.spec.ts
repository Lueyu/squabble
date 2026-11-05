import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { StrategyService } from './strategy.service';
import { StrategyScheduler } from './strategy.scheduler';

test('a pending Council cycle does not block a later protective scan', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const profile = { id: 'profile', version: 1, config: { automation: { enabled: true } } };
  const account = { id: 'account', botEnabled: true };
  const db = { select: () => ({ from: () => ({ where: async () => [account] }) }) };
  let protectiveScans = 0;
  const service = new StrategyService(db as never, { getActiveProfile: async () => profile } as never,
    {} as never, {} as never, {} as never, {} as never, { runtime: async () => ({}) } as never, {} as never);
  Object.assign(service, { stillActive: async () => true, monitorProtections: async () => { protectiveScans++; },
    universe: async () => ['AAPL'], tickMarket: async () => pending });
  const first = service.tick('owner');
  await new Promise(resolve => setImmediate(resolve));
  await service.tick('owner');
  assert.equal(protectiveScans, 2, 'later protective check must run while slow review remains pending');
  release(); await first;
});

test('scheduler dispatch remains available to protections while earlier strategy jobs wait', async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  let dispatches = 0;
  const db = { select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [{ owner: 'fixture', config: { automation: { enabled: true } } }] }) }) }) };
  const strategy = { tick: async () => { dispatches++; if (dispatches === 1) await pending; } };
  const scheduler = new StrategyScheduler(db as never, strategy as never, { tick: async () => undefined } as never);
  const first = scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  await scheduler.tick();
  assert.equal(dispatches, 2, 'global timer must not wait for a slow owner research cycle');
  release(); await first; scheduler.onModuleDestroy();
});
