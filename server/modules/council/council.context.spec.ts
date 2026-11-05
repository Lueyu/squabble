import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packDiscussionContext } from './council.context';
import { discussionPrompt } from './council.dialogue';
import { evidenceExcerpts, type CouncilEvidence } from './council.rules';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import { parseSecFinancials } from '../multi-agent/sec-financials';
import { estimateInputTokens } from '../llm-budget/llm-budget.rules';
import { jsonChatMessages } from '../multi-agent/llm.service';
import { CouncilWorkflowExecutor } from './council.workflow-executor';

function secFinancialEvidence(): CouncilEvidence[] {
  const context = { start: '2025-09-28', end: '2026-06-27', accn: '0000320193-26-000020', fy: 2026,
    fp: 'Q3', form: '10-Q', filed: '2026-07-31' };
  const monetary = (val: number, instant = false) => ({ units: { USD: [{ ...context, ...(instant ? { start: undefined } : {}), val }] } });
  const result = parseSecFinancials({ cik: 320193, facts: { 'us-gaap': {
    RevenueFromContractWithCustomerExcludingAssessedTax: monetary(364357000000), NetIncomeLoss: monetary(101464000000),
    NetCashProvidedByUsedInOperatingActivities: monetary(116996000000), Liabilities: monetary(275746000000, true),
    PaymentsToAcquirePropertyPlantAndEquipment: monetary(6799000000), CashAndCashEquivalentsAtCarryingValue: monetary(39544000000, true),
    StockholdersEquity: monetary(107520000000, true), Assets: monetary(383266000000, true),
    GrossProfit: monetary(178782000000), OperatingIncomeLoss: monetary(122432000000),
  } } }, { cik: '0000320193', tickers: ['AAPL'], filings: { recent: { form: ['10-Q'],
    accessionNumber: [context.accn], filingDate: [context.filed], reportDate: [context.end] } } }, 'AAPL', new Date('2026-10-30T12:00:00Z'));
  assert.equal(result.hasStatements, true);
  return result.items.map((item, i) => ({ ...item, id: `sec-${i}`, sourceName: item.sourceName ?? null,
    sourceUrl: item.sourceUrl ?? null, fetchedAt: '2026-10-30T12:00:00Z' }));
}

test('small excerpt shares never remove the essential typed SEC statement', () => {
  for (const budget of [550, 900]) {
    const sources = secFinancialEvidence();
    const excerpt = evidenceExcerpts(sources, budget).find(item => item.id === 'sec-0');
    assert.ok(excerpt, `typed statement must survive the ${budget}-byte prose share`);
    const serialized = JSON.stringify(excerpt);
    for (const value of ['364357000000', '101464000000', '116996000000', '275746000000', '6799000000',
      '39544000000', '107520000000', '2025-09-28', '2026-06-27', '2026-07-31', 'currency=USD', 'basis=us-gaap', sources[0].sourceUrl!]) {
      assert.ok(serialized.includes(value), `lost ${value}`);
    }
  }
});

test('challenge and summary without replacement tools retain snapshot financials or stop before transport', async () => {
  for (const key of ['challenge', 'summary']) for (const limit of [6000, 2400]) {
    const evidence = secFinancialEvidence();
    const row = { id: 'session', owner: 'owner', revision: 1, ticker: 'AAPL', language: 'en', status: 'running',
      profileSnapshot: {}, checkpoint: { workflow: { peers: [], recallEnabled: false } }, evidenceSnapshot: evidence };
    const builder = { from: () => builder, where: () => builder,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve([row]).then(resolve), orderBy: async () => [] };
    let captured = '', measured = 0;
    const executor = new CouncilWorkflowExecutor({ db: { select: () => builder },
      llm: { getInputLimit: async () => limit, chatFastJSON: async (messages: unknown) => { captured = JSON.stringify(messages); throw new Error('CAPTURED'); } },
      store: { markRemote: async (_row: unknown, _task: unknown, _id: unknown, update: { memory: { requestTokens: number } }) => { measured = update.memory.requestTokens; } },
      activity: async () => {} } as never);
    await assert.rejects(executor.execute(row as never, { id: 'task', key, position: 0, dependencies: [], skills: [], reason: null } as never,
      { id: 'attempt', revision: 1, kind: 'work' } as never, { id: 'researcher', name: 'Fixture', model: 'fast', instructions: '' } as never, []),
    /CAPTURED|RESEARCH_CONTEXT_LIMIT/);
    if (captured) {
      assert.ok(measured <= limit);
      for (const value of ['364357000000', '116996000000', '6799000000', '2025-09-28', '2026-06-27', '2026-07-31', evidence[0].sourceUrl!]) {
        assert.ok(captured.includes(value), `snapshot ${key} lost ${value}`);
      }
    } else assert.ok(measured > limit, 'a request containing essential facts fails only at the complete request limit');
    if (limit === 6000) assert.ok(captured, `${key} can fit essential financials in the ordinary global budget`);
  }
});

test('summary retains a short unique third or later handoff fact with its citation and valid steering', async () => {
  for (const [count, language] of [[3, 'en'], [5, 'en'], [3, 'zh-CN']] as const) {
    const marker = language === 'zh-CN' ? '本期客户续约率采用同口径付费客户计算，已扣除终止合同，结果为82.3%。' : 'Unique retention result: 82.3 percent.';
    const evidence = [...secFinancialEvidence(), { ...fact('business-news', 'news', 'Renewal disclosure', marker),
      role: 'news', sourceName: 'Provider', sourceUrl: 'https://example.test/renewals' }];
    const row = { id: 'session', owner: 'owner', revision: 1, ticker: 'AAPL', language, status: 'running',
      profileSnapshot: {}, checkpoint: { workflow: { peers: [], recallEnabled: false } }, evidenceSnapshot: evidence };
    const builder = { from: () => builder, where: () => builder,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve([row]).then(resolve),
      orderBy: async () => [{ content: '请核对公开披露数据。'.repeat(language === 'zh-CN' ? 60 : count === 3 ? 55 : 30) }] };
    let captured = '', measured = 0;
    const executor = new CouncilWorkflowExecutor({ db: { select: () => builder },
      llm: { getInputLimit: async () => 6000, chatFastJSON: async (messages: unknown) => { captured = JSON.stringify(messages); throw new Error('CAPTURED'); } },
      store: { markRemote: async (_row: unknown, _task: unknown, _id: unknown, update: { memory: { requestTokens: number } }) => { measured = update.memory.requestTokens; } },
      activity: async () => {} } as never);
    const points = ['First observation: revenue growth is conditional.', 'Second observation: cash conversion needs review.',
      ...(count === 5 ? ['Third observation: margin sensitivity matters.', 'Fourth observation: no annualization.'] : []), marker];
    const financialPoints = ['Financial scope is distinct.', 'Separate cash-flow source.', 'Unique financial stress: USD 42.'];
    await assert.rejects(executor.execute(row as never, { id: 'task', key: 'summary', position: 0, dependencies: ['business', 'financials'], skills: [], reason: null } as never,
      { id: 'attempt', revision: 1, kind: 'work' } as never, { id: 'researcher', name: 'Fixture', model: 'fast', instructions: '' } as never,
      [{ key: 'business', state: 'accepted', reason: 'Reviewed', delivery: { conclusion: 'The business requires monitoring.',
        evidenceIds: ['business-news'], response: { evidencePoints: points }, assumptions: [], gaps: [] } }, ...(count === 5 ? [{
        key: 'financials', state: 'needs_revision', reason: 'Independent reconciliation pending.', delivery: { conclusion: 'The financial scope differs.',
          evidenceIds: ['sec-0'], response: { evidencePoints: financialPoints }, assumptions: ['No growth assumption.'], gaps: ['Reconcile cash flow.'] },
      }] : [])] as never), /CAPTURED/);
    assert.ok(measured <= 6000);
    for (const point of points) assert.ok(captured.includes(point), `lost complete short point: ${point}`);
    if (count === 5) for (const point of financialPoints) assert.ok(captured.includes(point));
    assert.ok(captured.includes('business-news'));
  }
});

test('populated discussion preserves real SEC facts before optional prose or reaches the full request gate', () => {
  const config = normalizeBuilderConfig({ name: 'Research', template: 'guard', tickers: ['AAPL'], minimumRating: 'Buy',
    customPrompt: '审查现金流和负债。'.repeat(100), maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false });
  const member = { id: 'risk', role: 'challenger' as const, name: '风险分析师', model: 'fast' as const,
    instructions: '核对财务数据并提出问题。'.repeat(80), personality: '严谨务实，善于核对数据。'.repeat(20) };
  const turn = { memberId: 'risk', phase: 'challenge' as const };
  const systemPrompt = discussionPrompt(turn, 'zh-CN', false);
  for (const latest of ['请核对最近的财报与现金流，解释最新风险。'.repeat(26).slice(0, 500), '请核对财报。'.repeat(1000)]) {
    const data = packDiscussionContext({ ticker: 'AAPL', candidate: null, config, member, turn, systemPrompt, userMessages: [latest],
      previousDiscussion: [], currentDiscussion: [{ id: 'm1', memberName: 'Researcher', role: 'researcher', content: '这里有需要讨论的事实。'.repeat(100),
        metadata: { reasoningSummary: ['现金流属于累计口径，需要核对季度与年度的区别'], questions: ['最新新闻是否改变了收入趋势？'] } }],
      evidence: [...secFinancialEvidence(), fact('price', 'price', 'AAPL current quote', 'Price USD 100.')] });
    assert.ok(data.evidence.some(item => item.id === 'sec-0'));
    assert.ok(data.evidence.some(item => item.id === 'price'), 'the required quote also survives the local evidence share');
    assert.equal(data.criticalEvidenceMissing, false);
    assert.ok(JSON.stringify(data.evidence).includes('364357000000'));
    assert.deepEqual(data.steering, [latest]);
    const measured = estimateInputTokens(jsonChatMessages([{ role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify(data) }]));
    if (latest.length === 500) assert.ok(measured <= 6000, `ordinary discussion should fit the global budget: ${measured}`);
    else assert.ok(measured > 6000, 'oversized current context must remain oversized for the central pre-transport gate');
  }
});

const statement = 'Period: 2026-01-01 to 2026-09-30. Revenue: USD 314389000000; Net income: USD 85204000000; Operating cash flow: USD 81389000000 (period total); Liabilities: USD 290437000000. Liabilities are a balance as of 2026-09-30; income and cash flow cover the stated period (may be YTD), not annualized. Form: 10-Q. Filed: 2026-10-29.';
const fact = (id: string, evidenceType: string, title: string, content: string): CouncilEvidence => ({ id, evidenceType,
  title, content, role: 'fundamental', sourceUrl: 'https://www.sec.gov/Archives/filing', sourceName: 'SEC EDGAR',
  fetchedAt: '2026-10-30T10:00:00Z', relevanceScore: 1 });

test('financial excerpts include verified values, units and periods instead of just provenance', () => {
  const excerpt = evidenceExcerpts([fact('filing', 'financial', 'AAPL SEC reported financial statements', statement)])[0];
  for (const value of ['314389000000', '85204000000', '81389000000', '290437000000', 'USD', '2026-01-01', '2026-09-30', 'may be YTD']) {
    assert.ok(excerpt.content.includes(value), `financial excerpt must retain ${value}`);
  }
});

test('a requested web source and financial statement both reach the next speaker with a populated, compressed context', () => {
  const config = normalizeBuilderConfig({ name: 'Research', template: 'guard', tickers: ['AAPL'], minimumRating: 'Buy',
    customPrompt: '审查现金流和负债。'.repeat(100), maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false });
  const member = { id: 'risk', role: 'challenger' as const, name: '风险分析师', model: 'fast' as const,
    instructions: '核对财务数据并提出问题。'.repeat(80), personality: '严谨务实，善于核对数据。'.repeat(20) };
  const turn = { memberId: 'risk', phase: 'challenge' as const };
  const data = packDiscussionContext({ ticker: 'AAPL', candidate: null, config, member, turn,
    systemPrompt: discussionPrompt(turn, 'zh-CN', false), userMessages: ['请核对最近的财报与现金流，解释最新风险。'.repeat(26).slice(0, 500)],
    previousDiscussion: [], currentDiscussion: [{ id: 'm1', memberName: 'Researcher', role: 'researcher', content: '这里有需要讨论的事实。'.repeat(100),
      metadata: { reasoningSummary: ['现金流属于累计口径，需要核对季度与年度的区别'], questions: ['最新新闻是否改变了收入趋势？'] } }],
    evidence: [fact('price', 'price', 'AAPL current quote', 'Price USD 100. '.repeat(30)),
      fact('technical', 'price', 'AAPL current-session price action', 'High USD 103. Low USD 99. '.repeat(20)),
      fact('valuation', 'financial', 'AAPL Finnhub valuation metrics', 'P/E 25. P/S 8.'),
      fact('filing', 'financial', 'AAPL SEC reported financial statements', statement),
      { ...fact('requested-web', 'other', 'Recent company release', 'A public web lead, not a verified financial statement. '.repeat(20)), researchKind: 'web' }],
  });
  assert.ok(data.evidence.some((item) => item.id === 'filing'));
  assert.ok(data.evidence.some((item) => item.id === 'requested-web'), 'Successful requested research must not silently disappear from the prompt');
});

test('ordinary cash-flow discussions retain capex, derived FCF, cash and equity inside the financial excerpt', () => {
  const config = normalizeBuilderConfig({ name: 'Research', template: 'guard', tickers: ['AAPL'], minimumRating: 'Buy',
    customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 1, notifyOnProposal: false });
  const member = { id: 'value', role: 'researcher' as const, name: '价值研究员', model: 'fast' as const,
    instructions: '核对已披露现金流和资本开支，回应同伴的质疑。' };
  const turn = { memberId: 'value', phase: 'response' as const };
  const financials = 'Period: 2025-09-28 to 2026-06-27 (may be YTD; not TTM; not annualized). Revenue: USD 364357000000; Net income: USD 101464000000; Operating cash flow: USD 116996000000 (period total); Liabilities: USD 275746000000; Capex (PP&E): USD 6799000000; Derived FCF (CFO-capex, non-GAAP): USD 110197000000; Cash/equivalents: USD 39544000000; Equity (parent): USD 107520000000; Assets: USD 383266000000.';
  const data = packDiscussionContext({ ticker: 'AAPL', candidate: null, config, member, turn,
    systemPrompt: discussionPrompt(turn, 'zh-CN', false), userMessages: ['现金流、负债和资本开支是否支持当前估值？'],
    previousDiscussion: [], currentDiscussion: [{ id: 'risk', memberName: '风险研究员', role: 'challenger', content: '请核对自由现金流与净现金。'.repeat(20) }],
    evidence: [fact('filing', 'financial', 'AAPL SEC reported financial statements', financials),
      fact('price', 'price', 'AAPL current price', 'USD 348.91'), fact('valuation', 'financial', 'AAPL valuation', 'P/E 39.56'),
      fact('news', 'news', 'AAPL earnings event', 'Upcoming quarterly report')],
  });
  const excerpt = data.evidence.find(item => item.id === 'filing')?.content ?? '';
  for (const value of ['6799000000', '110197000000', '39544000000', '107520000000', 'not TTM', 'non-GAAP']) assert.ok(excerpt.includes(value), value);
});
