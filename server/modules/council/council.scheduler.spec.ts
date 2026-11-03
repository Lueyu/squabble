import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CouncilScheduler } from './council.scheduler';

test('account cap and native connection exclusion apply across sessions; cancelled work is skipped', async () => {
  const scheduler = new CouncilScheduler();
  const yes = async () => true;
  const first = await scheduler.acquire('owner', 'a', 'codex', 2, yes);
  const order: string[] = [];
  const duplicate = scheduler.acquire('owner', 'a', 'codex', 2, yes).then(release => { order.push('duplicate'); return release; });
  const second = await scheduler.acquire('owner', 'b', undefined, 2, yes);
  const third = scheduler.acquire('owner', 'c', undefined, 2, yes).then(release => { order.push('third'); return release; });
  assert.deepEqual(order, []);
  second!();
  const releaseThird = await third;
  assert.deepEqual(order, ['third']);
  first!(); const releaseDuplicate = await duplicate;
  assert.deepEqual(order, ['third', 'duplicate']);
  releaseThird!(); releaseDuplicate!();
  assert.equal(await scheduler.acquire('owner', 'c', undefined, 2, async () => false), null);
});

test('a release during an async readiness check wakes previously skipped tasks', async () => {
  const scheduler = new CouncilScheduler();
  const first = await scheduler.acquire('o', 'a', 'codex', 2, async () => true);
  const waiting = scheduler.acquire('o', 'a', 'codex', 2, async () => true);
  let unblock!: () => void;
  const checked = new Promise<void>(resolve => { unblock = resolve; });
  const other = scheduler.acquire('o', 'b', undefined, 2, async () => { await checked; return true; });
  first!(); unblock();
  const [releaseWaiting, releaseOther] = await Promise.all([waiting, other]);
  releaseWaiting!(); releaseOther!();
});
