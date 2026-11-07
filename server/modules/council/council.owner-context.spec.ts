import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentAssignment } from './council.native';
import { packDiscussionContext } from './council.context';
import { evidenceExcerpts, type CouncilEvidence } from './council.rules';
import { normalizeBuilderConfig } from '../paper-trading/agent-builder.rules';
import { CouncilWorkflowExecutor } from './council.workflow-executor';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { LocalAgentError } from '../local-agents/local-agents.types';

function ownerEvidence(): CouncilEvidence {
  const data = {
    holdings: Array.from({ length: 13 }, (_, index) => ({
      id: `holding-${index}`, ticker: index === 12 ? 'LAST_HOLDING_SENTINEL' : `FIXTURE${index}`,
      shares: String(index + 1), market: 'US', currency: 'USD',
      analysis: 'Fictional saved position detail. '.repeat(16),
      updatedAt: '2026-11-06T08:30:00.000Z',
    })),
    cash: [{ currency: 'USD', amount: '1234.56' }, { currency: 'HKD', amount: null },
      { currency: 'CNY', amount: '0' }],
    capturedAt: '2026-11-06T09:00:00.000Z', confirmedInvestorLimits: { maxPositionPct: '17' },
    confirmedLimitsAt: '2026-11-05T07:00:00.000Z', constraintGap: null,
  };
  return { id: 'context:fictional-owner', title: 'Complete fictional portfolio', content: JSON.stringify(data),
    sourceName: 'Frozen owner context', sourceUrl: null, role: 'fundamental', evidenceType: 'other',
    fetchedAt: data.capturedAt, relevanceScore: 1 };
}
const member = { id: 'researcher', name: 'Fixture', role: 'researcher' as const,
  instructions: '', model: 'fast' as const };
const turn = { memberId: member.id, phase: 'opening' as const };

test('native assignment sends valid complete owner JSON including last holding, unknown cash and confirmed limits', () => {
  const owner = ownerEvidence();
  assert.ok(owner.content.length > 8000);
  const prompt = agentAssignment({ ticker: 'PORTFOLIO', language: 'en', member, turn,
    candidate: null, messages: [], evidence: [owner] });
  const payload = JSON.parse(prompt.split('\n').at(-1)!) as { evidence: CouncilEvidence[] };
  assert.equal(payload.evidence[0].content, owner.content);
  assert.deepEqual(JSON.parse(payload.evidence[0].content), JSON.parse(owner.content));
  assert.ok(Buffer.byteLength(prompt, 'utf8') < 256_000, 'ordinary full portfolio fits existing native input limit');
});

test('native assignment preserves owner context beyond first twenty sources and keeps ordinary source clipping', () => {
  const owner = ownerEvidence();
  const ordinary = Array.from({ length: 21 }, (_, index) => ({ ...owner, id: `news-${index}`,
    sourceName: 'Public fixture', content: 'x'.repeat(2000) }));
  const prompt = agentAssignment({ ticker: 'PORTFOLIO', language: 'en', member, turn,
    candidate: null, messages: [], evidence: [...ordinary, owner] });
  const payload = JSON.parse(prompt.split('\n').at(-1)!) as { evidence: CouncilEvidence[] };
  assert.equal(payload.evidence.find(item => item.id === owner.id)?.content, owner.content);
  assert.equal(payload.evidence.filter(item => item.sourceName === 'Public fixture').length, 20);
  assert.equal(payload.evidence.find(item => item.id === 'news-0')?.content.length, 1500);
});

test('owner evidence bypasses prose excerpts without reducing ordinary evidence coverage', () => {
  const owner = ownerEvidence();
  const market = { ...owner, id: 'price', sourceName: 'Public fixture', evidenceType: 'price', content: 'USD 10' };
  for (const budget of [0, 550, 2100]) {
    const excerpt = evidenceExcerpts([market, owner], budget);
    const frozen = excerpt.find(item => item.id === owner.id);
    assert.ok(frozen);
    assert.equal(frozen.content, owner.content);
    assert.equal(frozen.fetchedAt, owner.fetchedAt);
    assert.deepEqual(excerpt.filter(item => item.id !== owner.id), evidenceExcerpts([market], budget));
  }
});

test('API discussion context keeps atomic owner facts for the central full-input budget gate', () => {
  const owner = ownerEvidence();
  const config = normalizeBuilderConfig({ name: 'Fixture', template: 'guard', tickers: ['PORTFOLIO'],
    minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3,
    maxOrdersPerDay: 1, notifyOnProposal: false });
  const packed = packDiscussionContext({ ticker: 'PORTFOLIO', candidate: null, config, member, turn,
    evidence: [owner], userMessages: ['Review all recorded holdings and cash.'], currentDiscussion: [],
    previousDiscussion: [], systemPrompt: 'Use the complete recorded portfolio.' });
  assert.equal(packed.evidence.find(item => item.id === owner.id)?.content, owner.content);
});

test('more than twenty frozen owner records fail explicitly rather than silently omit records', () => {
  const evidence = Array.from({ length: 21 }, (_, index) => ({ ...ownerEvidence(), id: `context:${index}` }));
  assert.throws(() => evidenceExcerpts(evidence), /RESEARCH_CONTEXT_LIMIT/u);
  assert.throws(() => agentAssignment({ ticker: 'PORTFOLIO', language: 'en', member, turn,
    candidate: null, messages: [], evidence }), /RESEARCH_CONTEXT_LIMIT/u);
});

test('oversized complete native owner context reaches the existing input guard before staging or provider dispatch', async () => {
  let staged = false;
  class FixtureAgents extends LocalAgentsService {
    override get mode(): 'companion' { return 'companion'; }
    override async validate(): Promise<void> {}
  }
  const agents = new FixtureAgents({
    detectNativeAgents: async () => [], openNativeLogin: async () => undefined,
    runNativeAgent: async () => { assert.fail('provider must not be called'); },
  }, { findMessage: async () => undefined,
    stage: async () => { staged = true; assert.fail('oversized prompt must not be staged'); } } as never);
  const owner = ownerEvidence();
  owner.content = JSON.stringify({ ...JSON.parse(owner.content), detail: 'x'.repeat(256_000) });
  const prompt = agentAssignment({ ticker: 'PORTFOLIO', language: 'en', member, turn,
    candidate: null, messages: [], evidence: [owner] });
  await assert.rejects(agents.execute('fixture', { agentId: 'companion-codex', messageId: 'fixture-message', prompt,
    onTask: async () => undefined, onProgress: async () => undefined, shouldContinue: async () => true }),
  (error: unknown) => error instanceof LocalAgentError && error.code === 'LOCAL_INVALID_INPUT');
  assert.equal(staged, false);
});

test('workflow work and review deliver all owner facts or refuse before model dispatch at the actual input limit', async () => {
  for (const kind of ['work', 'review']) for (const limit of [6000, 32000]) {
    const owner = ownerEvidence();
    const row = { id: 'session', owner: 'fixture', revision: 1, ticker: 'PORTFOLIO', scene: 'portfolio_daily',
      language: 'en', status: 'running', profileSnapshot: {},
      checkpoint: { workflow: { peers: [], recallEnabled: false } }, evidenceSnapshot: [owner] };
    const builder = { from: () => builder, where: () => builder,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve([row]).then(resolve), orderBy: async () => [] };
    let calls = 0;
    let captured: Array<{ role: string; content: string }> = [];
    const executor = new CouncilWorkflowExecutor({ db: { select: () => builder },
      llm: { getInputLimit: async () => limit, chatFastJSON: async (messages: typeof captured) => {
        calls++; captured = messages; throw new Error('CAPTURED');
      } }, store: { markRemote: async () => undefined }, activity: async () => {} } as never);
    const task = { id: 'task', key: 'challenge', position: 0, dependencies: [], skills: [], reason: null,
      delivery: { conclusion: 'Fictional conclusion', evidenceIds: [], asOf: '2026-11-06', assumptions: [], gaps: [],
        response: { thesis: 'Fictional conclusion', evidencePoints: [], risks: [], nextChecks: [] } } };
    await assert.rejects(executor.execute(row as never, task as never,
      { id: 'attempt', revision: 1, kind } as never, member, []),
    limit === 6000 ? /RESEARCH_CONTEXT_LIMIT/u : /CAPTURED/u);
    assert.equal(calls, limit === 6000 ? 0 : 1);
    if (calls) {
      const data = JSON.parse(captured.find(message => message.role === 'user')!.content) as { evidence: CouncilEvidence[] };
      const received = data.evidence.find(item => item.id === owner.id);
      assert.equal(received?.content, owner.content);
      assert.deepEqual(JSON.parse(received!.content), JSON.parse(owner.content));
    }
  }
});
