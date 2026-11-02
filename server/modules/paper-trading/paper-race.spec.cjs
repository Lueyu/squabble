// Deterministic approval/rejection interleaving with isolated data.
const assert = require('node:assert/strict');
const { MemoryDb, loadService, tables } = require('../transactions/transactions-regression.spec.cjs');
const PaperTradingService = loadService('server/modules/paper-trading/paper-trading.service.ts', 'PaperTradingService', {
  'node:crypto': require('node:crypto'),
  '../../database/schema': tables,
  '../../database/council.schema': {},
  '../notifications/notification.service': { NotificationService: class {} },
  '../../common/market-clock': {},
  './agent-builder.service': { AgentBuilderService: class {} },
  './agent-builder.rules': {},
  './builder-cadence.service': { BuilderCadenceService: class {} },
  './trading-cadence': {},
  '../council/council.service': { CouncilService: class {} },
});
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function main() {
  const db = new MemoryDb();
  const userId = 'audit-user-memory-only';
  const orderId = 'audit-pending-order';
  db.data.paperAccounts.push({ id: 'paper-account', owner: userId, cashBalance: '1000' });
  db.data.paperOrders.push({
    id: orderId, owner: userId, accountId: 'paper-account', ticker: 'AAPL',
    market: 'US', currency: 'USD', side: 'buy', orderType: 'market',
    quantity: '10', status: 'pending_approval', source: 'agent',
    createdAt: new Date('2026-10-01T00:00:00Z'),
  });
  const rejectReachedWrite = deferred();
  const releaseRejectWrite = deferred();
  db.beforeExecute = async ({ mode, table, patch }) => {
    if (mode === 'update' && table === 'paperOrders' && patch.status === 'cancelled') {
      rejectReachedWrite.resolve();
      await releaseRejectWrite.promise;
    }
  };
  const notifications = [];
  const service = new PaperTradingService(db,
    { getQuote: async () => ({ price: '10', market: 'US', currency: 'USD', companyName: 'Apple' }) },
    {}, { notifyUser: async (user, payload) => { notifications.push(payload.event); } }, {}, {}, {});
  // B reads pending, pauses immediately before its cancellation UPDATE.
  const rejection = service.rejectOrder(userId, orderId);
  await rejectReachedWrite.promise;
  // A approves, executes the actual fill, and commits its transaction first.
  const approvalResult = await service.approveOrder(userId, orderId);
  assert.equal(approvalResult.status, 'filled');
  // B resumes its stale UPDATE after all approval row locks would be released.
  releaseRejectWrite.resolve();
  await assert.rejects(rejection, /no longer pending/i);
  const result = {
    approvalResponseStatus: approvalResult.status,
    rejectionResponseStatus: 'rejected stale cancellation',
    finalOrderStatus: db.data.paperOrders[0].status,
    finalFilledPrice: db.data.paperOrders[0].filledPrice,
    finalCash: db.data.paperAccounts[0].cashBalance,
    finalPositionShares: db.data.paperPositions[0].shares,
    recordedTrades: db.data.paperTrades.length,
    eventTypes: db.data.paperEvents.map(event => event.eventType),
    notifications,
    note: 'Real approveOrder(), executeFill(), rejectOrder() and recordEvent(); in-memory DB. .for(update) is a no-op because cancellation is deliberately released only after the approval transaction completes, a schedule compatible with real row locks.',
  };
  assert.equal(result.finalOrderStatus, 'filled');
  assert.equal(result.finalCash, '900.00');
  assert.equal(result.finalPositionShares, '10');
  assert.equal(result.recordedTrades, 1);
  assert.deepEqual(result.eventTypes, ['order_filled']);
  assert.deepEqual(notifications, ['order_filled']);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
