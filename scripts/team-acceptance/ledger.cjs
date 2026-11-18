const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mock } = require('node:test');
const { price, ruleContent, ticker } = require('./providers.cjs');

async function applyReviewedRule(ownerApi, accountId, at) {
  const content = ruleContent(new Date(), new Date(at.getTime() + 3_600_000));
  const draft = await ownerApi('/api/investment-strategies', { method: 'POST', body: { content } });
  const checked = await ownerApi('/api/investment-strategies/' + draft.id + '/preview', {
    method: 'POST', body: { expectedRevision: draft.revision },
  });
  assert.equal(checked.preview.canConfirm, true, JSON.stringify(checked.preview.issues));
  const path = '/api/ai-investment/accounts/' + accountId + '/strategies';
  const current = await ownerApi(path);
  const input = {
    expectedPolicyRevision: current.policyRevision,
    allocations: [{ strategyId: draft.id, strategyRevision: draft.revision, allocationPct: 100, enabled: true }],
  };
  const review = await ownerApi(path + '/preview', { method: 'POST', body: { ...input, requestKey: randomUUID() } });
  assert.equal(review.canApply, true, JSON.stringify(review.issues));
  const applied = await ownerApi(path + '/apply', { method: 'POST', body: { ...input,
    requestKey: randomUUID(), previewHash: review.previewHash } });
  assert.equal(applied.accountId, accountId);
  assert.equal(applied.status, 'running');
  return draft;
}

async function readFill(sql, owner, accountId, expectedAt, ruler) {
  const fills = await sql`
    select t.id, t.account_id, t.owner, t.ticker, t.quantity::int, t.price, t.side, t.created_at,
      o.id as order_id, o.filled_at, o.filled_price, o.status, o.source, o.risk_check
    from paper_trades t join paper_orders o on o.id = t.order_id and o.account_id = t.account_id
    where t.owner = ${owner} and t.account_id = ${accountId}`;
  assert.equal(fills.length, 1, 'One actual fill for the approved account');
  const [fill] = fills;
  assert.equal(fill.ticker, ticker);
  assert.equal(fill.side, 'buy');
  assert.equal(fill.quantity, 2);
  assert.equal(fill.status, 'filled');
  assert.equal(fill.source, 'agent');
  assert.equal(fill.filled_at.toISOString(), expectedAt.toISOString());
  assert.equal(Number(fill.price), Number(fill.filled_price));
  assert.ok(Number(fill.price) >= price && Number(fill.price) < 85, 'Simulated execution uses the quoted price and slippage');
  const signals = await sql`
    select candidate from strategy_signals where owner = ${owner} and state = 'filled'
    and candidate->>'accountId' = ${accountId}`;
  assert.equal(signals.length, 1);
  assert.equal(signals[0].candidate.userStrategyId, ruler);
  assert.equal(signals[0].candidate.quoteAt, new Date(expectedAt.getTime() - 60_000).toISOString());
  const copied = await sql`select shares::int from paper_positions where owner = ${owner} and account_id = ${accountId} and ticker = ${ticker}`;
  assert.equal(copied[0].shares, 6);
  const real = await sql`select shares::int from holdings where owner = ${owner} and ticker = ${ticker}`;
  assert.equal(real[0].shares, 4, 'The separate real account is unchanged');
  return fill;
}

async function verifyLedger(sandbox, ownerApi, owner, team, observe, application, evidence, refreshSession) {
  const { accountId } = team;
  evidence.source = application ? 'automatic team decision' : 'independent fixed rule';
  const realNow = new Date();
  const schedule = await sandbox.markets.getSchedule('US', realNow);
  assert.ok(schedule.calendarVerified);
  const current = Math.ceil(realNow.getTime() / 300_000) * 300_000 + 300_000;
  const duringSession = schedule.isOpen && Date.parse(schedule.closesAt) > current + 15 * 60_000;
  const at = new Date(duringSession ? current : Date.parse(schedule.nextOpenAt) + 5 * 60_000);
  assert.ok(Number.isFinite(at.getTime()) && at > realNow && (await sandbox.markets.getSchedule('US', at)).isOpen);
  const strategyId = application?.strategyId ?? (await applyReviewedRule(ownerApi, accountId, at)).id;
  const combination = await ownerApi('/api/ai-investment/accounts/' + accountId + '/strategies');
  if (application) {
    assert.equal(combination.policyRevision, application.policyRevision);
    assert.ok(combination.allocations.some(entry => entry.strategyId === strategyId && entry.enabled));
  }
  const { providers, sql } = sandbox;
  const callCount = providers.calls.length;

  mock.timers.enable({ apis: ['Date'], now: at });
  providers.marketAt = at;
  try {
    await refreshSession();
    const runtime = await sandbox.strategy.tick(owner, accountId);
    const [state] = await sql`select state from strategy_signals where owner = ${owner} and candidate->>'accountId' = ${accountId}`;
    assert.equal(state?.state, 'filled', 'Fixed-rule runtime result: ' + JSON.stringify(runtime?.markets ?? runtime));
    await sandbox.strategy.tick(owner, accountId);
    assert.equal(providers.calls.length, callCount, 'The fixed rule executes without a model call');
    const fill = await readFill(sql, owner, accountId, at, strategyId);
    evidence.fill = fill;
    const assetPath = '/api/ai-investment/accounts/' + accountId + '/assets';
    const assets = await ownerApi(assetPath);
    assert.equal(assets.accountId, accountId);
    assert.equal(assets.trades[0]?.id, fill.id);
    const tradeLink = assets.executionProvenance?.find(link => link.targetId === fill.id && link.kind === 'trade');
    if (application) {
      assert.equal(tradeLink?.teamId, team.id);
      assert.equal(tradeLink?.commissionId, application.commissionId);
      assert.equal(tradeLink?.decision?.basis.reportVersionId, application.reportVersionId);
      assert.equal(tradeLink?.attemptId, application.acceptedAttemptId);
    } else {
      assert.equal(tradeLink, undefined, 'An independently approved rule carries no team attribution');
    }
    assert.equal(assets.trades[0].createdAt, fill.created_at.toISOString());
    assert.equal(assets.orders.find(order => order.id === fill.order_id)?.filledAt, at.toISOString());

    await sandbox.valuation.tick(at);
    const [valid] = await sql`select captured_at, complete, equity_usd, market_quotes from paper_equity_observations
      where owner = ${owner} and account_id = ${accountId} and captured_at = ${at}`;
    assert.ok(valid?.complete && Number(valid.equity_usd) > 0, JSON.stringify(valid));
    assert.deepEqual(valid.market_quotes.map(quote => ({ ticker: quote.ticker, price: quote.price, at: quote.quoteAt })),
      [{ ticker, price, at: new Date(at.getTime() - 60_000).toISOString() }]);
    const comparisonPath = '/api/ai-investment/comparison?period=1W&accountIds=real,' + accountId;
    const validComparison = (await ownerApi(comparisonPath)).series;
    assert.deepEqual(validComparison.map(series => series.accountId), ['real', accountId]);
    const paper = validComparison[1];
    assert.equal(paper.valuationAsOf, at.toISOString());
    assert.equal(paper.points.find(point => point.timestamp === at.toISOString())?.equityUsd, Number(valid.equity_usd));
    assert.ok(paper.points.every(point => point.timestamp.slice(0, 10) >= paper.createdAt.slice(0, 10)));
    evidence.valid = valid;
    evidence.tradeLink = tradeLink;
    evidence.pictures = await observe({ state: 'filled', now: at, fill });

    const gapAt = new Date(at.getTime() + 5 * 60_000);
    mock.timers.setTime(gapAt.getTime());
    providers.marketAt = gapAt;
    providers.missingQuotes = true;
    await sandbox.valuation.tick(gapAt);
    const [gap] = await sql`select captured_at, complete, equity_usd, gaps from paper_equity_observations
      where owner = ${owner} and account_id = ${accountId} and captured_at = ${gapAt}`;
    assert.equal(gap.complete, false);
    assert.equal(gap.equity_usd, null);
    assert.ok(gap.gaps.some(item => item.includes(ticker)));
    const gapComparison = (await ownerApi(comparisonPath)).series.find(series => series.accountId === accountId);
    assert.equal(gapComparison.points.find(point => point.timestamp === gapAt.toISOString()).equityUsd, null);
    evidence.gap = gap;
    evidence.gapPictures = await observe({ state: 'gap', now: gapAt, fill });
  } finally {
    providers.missingQuotes = false;
    providers.marketAt = null;
    mock.timers.reset();
  }
}

module.exports = { verifyLedger };
