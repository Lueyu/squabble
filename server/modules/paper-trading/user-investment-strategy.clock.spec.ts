import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { userInvestmentStrategies } from '../../database/user-investment-strategies.schema';
import type { StrategyDraftInput } from '../../../shared/user-investment-strategy.interface';
import { previewStrategy } from './user-investment-strategy.rules';
import { UserInvestmentStrategyService, type UserStrategyTransaction } from './user-investment-strategy.service';

test('account confirmation persists the exact returned timestamp when the clock advances between reads', async () => {
  const content: StrategyDraftInput = { title: 'Observation fixture', body: '', timezone: 'UTC',
    startsAt: '2026-11-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z', entries: [] };
  let stored: typeof userInvestmentStrategies.$inferSelect = {
    id: randomUUID(), owner: randomUUID(), revision: 1, parentId: null, status: 'draft', content,
    sources: [], preview: previewStrategy(content, [], 1), confirmedAt: null, deletedAt: null,
    createdAt: new Date('2026-11-01'), updatedAt: new Date('2026-11-01'),
  };
  // In-memory persistence ports exercise both public methods without starting a
  // database, research provider or policy activation. Integration tests retain
  // their full saved-object assertion against PostgreSQL.
  const persistence = {
    select: () => ({ from: (table: unknown) => {
      assert.equal(table, userInvestmentStrategies);
      return { where: () => ({ for: async () => [stored],
        then: (resolve: (rows: typeof stored[]) => unknown) => Promise.resolve([stored]).then(resolve) }) };
    } }),
    update: (table: unknown) => {
      assert.equal(table, userInvestmentStrategies);
      return { set: (values: Partial<typeof stored>) => ({ where: async () => { stored = { ...stored, ...values }; } }) };
    },
  };
  const service = new UserInvestmentStrategyService(persistence as never, {} as never, {} as never);
  const RealDate = Date;
  let clock = RealDate.parse('2026-11-13T08:00:00Z');
  class AdvancingDate extends RealDate {
    constructor(value?: string | number) {
      if (arguments.length) super(value!);
      else super(clock++);
    }
  }
  try {
    globalThis.Date = AdvancingDate as DateConstructor;
    const confirmed = await service.accountSnapshot(persistence as unknown as UserStrategyTransaction,
      stored.owner, stored.id, stored.revision, true);
    assert.equal(confirmed.updatedAt, confirmed.confirmedAt);
    assert.deepEqual(await service.get(stored.owner, stored.id), confirmed,
      'the confirmation receipt must match its later saved read, even across a millisecond boundary');
  } finally {
    globalThis.Date = RealDate;
  }
});
