'use strict';

// Read-only fictional data required by the guided setup screens. The only POST
// computes a static preview; it creates no account, team, receipt or agreement.
const FIXED_TIME = '2026-11-13T01:00:00.000Z';

function buildSeed(ctx) {
  return {
    ...ctx.seed, id: ctx.seed.previewId, sourceRevision: 'fictional-ui-seed-v1',
    limits: { maxPositionPct: 30, maxOrderPct: 10, maxDailyIncreasePct: 20,
      maxDailyTurnoverPct: 50, maxGrossExposurePct: 100, minCashPct: 5, dailyLossLimitPct: 5 },
    budget: { dailyTasks: 4, maxCallsPerTask: 8, maxDiscoveryCandidates: 10, maxDeepResearchCandidates: 4 },
    inheritedConcentration: [],
    seed: {
      ...ctx.seed.seed, origin: { kind: 'real_holdings' }, sourceRevision: 'fictional-ui-seed-v1',
      capturedAt: FIXED_TIME, copiedCash: [{ currency: 'USD', total: '10000' }],
      fx: [{ currency: 'USD', rate: '1', at: FIXED_TIME }], initialEquityUsd: '10000', gaps: [],
      model: { version: 'paper-v1', feeBps: 0, slippageBps: 0, corporateActions: 'unsupported' },
    },
  };
}

function createFixtureSupport() {
  return function fixtureSupport(ctx, req, res, url) {
    let data;
    if (url.pathname === '/api/teams' && req.method === 'GET') {
      data = { items: [], total: 0, nextCursor: null, capabilities: { workspaceEnabled: true, researchEnabled: true } };
    } else if (url.pathname === '/api/ai-investment/accounts' && req.method === 'GET') {
      data = [];
    } else if (url.pathname === '/api/ai-investment/preview' && req.method === 'POST') {
      data = buildSeed(ctx);
    } else {
      return false;
    }
    ctx.answer(res, 200, data);
    return true;
  };
}

module.exports = createFixtureSupport;
