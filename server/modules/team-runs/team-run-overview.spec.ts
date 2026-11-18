import assert from 'node:assert/strict';
import test from 'node:test';
import type { TeamRunConfiguration, TeamRunCycle } from '../../../shared/team-run.interface';
import { nextRunWindow } from './team-run-overview';

test('run window respects market holidays, short sessions, consumed dates, consent boundaries and calendar coverage', () => {
  const config = { market: 'US', cadence: { kind: 'after_close', delayMinutes: 60 } } as TeamRunConfiguration;
  const fridayWindow = { kind: 'after_close', at: '2026-11-27T19:00:00.000Z', timezone: 'America/New_York' };
  assert.deepEqual(nextRunWindow(config, [], 1, new Date('2026-11-26T18:00Z')), fridayWindow);
  assert.deepEqual(nextRunWindow(config, [], 1, new Date('2026-11-27T16:00Z')), fridayWindow);
  const recorded = { state: 'observed', tradingDate: '2026-11-27', agreementRevision: 2 } as TeamRunCycle;
  assert.deepEqual(nextRunWindow(config, [recorded], 1, new Date('2026-11-27T15:00Z')),
    { kind: 'after_close', at: '2026-11-30T22:00:00.000Z', timezone: 'America/New_York' });
  assert.deepEqual(nextRunWindow({ ...config, initialRun: 'immediate' }, [recorded], 3, new Date('2026-11-28T16:00Z')), { kind: 'first' });
  assert.deepEqual(nextRunWindow(config, [{ ...recorded, state: 'uncertain' }], 1, new Date('2026-11-28T16:00Z')), { kind: 'after_cycle' });
  assert.deepEqual(nextRunWindow(config, [], 1, new Date('2027-01-01T18:00Z')), { kind: 'unknown' });
});
