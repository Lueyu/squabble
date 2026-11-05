import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { builderProfiles } from '../../database/schema';
import { councilSessions } from '../../database/council.schema';
import { CouncilService } from './council.service';
import type { BuilderConfig } from '../../../shared/api.interface';

const url = process.env.COUNCIL_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;
const client = url ? postgres(url, { max: 4, onnotice: () => undefined }) : null;
const db = client ? drizzle(client) : null;
const owner = randomUUID();
const other = randomUUID();
let profileId = '';
const config: BuilderConfig = { name: 'Council integration', template: 'balanced', tickers: ['AAPL'], minimumRating: 'Buy', customPrompt: '', maxOrderPct: 5, dailyLossLimitPct: 3, maxOrdersPerDay: 4, notifyOnProposal: false, priceRules: [{ ticker: 'AAPL', buyAtOrBelow: 101 }] };
const candidate = { ticker: 'AAPL', side: 'buy' as const, quantity: 2, price: 100, reason: 'Investor price rule: 100 reached buy trigger 101' };
const portfolio = { totalValue: 1000, totalMv: 0, cash: 1000, cashRatio: 100, holdings: [], companyExposures: {} };

before(async () => {
  if (!client) return;
  await client.unsafe(readFileSync('scripts/db/08_investment_council.sql', 'utf8'));
  await client.unsafe(readFileSync('scripts/db/21_research_archive_jobs.sql', 'utf8'));
  await client.unsafe(readFileSync('scripts/db/12_council_dialogue.sql', 'utf8'));
  await client.unsafe(readFileSync('scripts/db/27_research_threads.sql', 'utf8'));
  const [row] = await db.insert(builderProfiles).values({ owner, config }).returning();
  profileId = row.id;
});
after(async () => {
  if (!client) return;
  await db.delete(councilSessions).where(eq(councilSessions.owner, owner));
  await db.delete(builderProfiles).where(eq(builderProfiles.owner, owner));
  await client.end();
});

function service(chat = async () => ({ data: { decision: 'wait', summary: 'Need verified data', evidenceIds: [], dissent: [], nextReviewCondition: 'financials' }, tokens: 5 }), configured = true) {
  return new CouncilService(db, {
    isConfigured: async () => configured, validateConnectionIds: async () => undefined, chatFastJSON: chat, chatSlowJSON: chat,
  } as never, { collectEvidence: async () => [
    { role: 'fundamental', evidenceType: 'price', title: 'quote', content: '100 USD', relevanceScore: 1, sourceName: 'provider' },
    { role: 'fundamental', evidenceType: 'other', title: 'financials missing', content: 'unavailable', relevanceScore: 0, sourceName: 'Data Unavailable' },
  ] } as never, { getPortfolioContext: async () => portfolio } as never,
  { listRuns: async () => ({ items: [], total: 0 }) } as never);
}
async function completed(svc: CouncilService, id: string) {
  for (let i = 0; i < 300; i++) {
    const session = await svc.getSession(owner, id);
    if (session.status !== 'running') return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Council did not finish');
}

dbTest('sequential discussion responds to prior messages and publishes public rationale in four bounded turns', async () => {
  const contexts: Array<{ conversation?: Array<{ id: string; content: string }> }> = [];
  const svc = service(async (...args: unknown[]) => {
    contexts.push(JSON.parse((args[0] as Array<{ content: string }>)[1].content));
    return { data: { content: `Public contribution ${contexts.length}`, reasoningSummary: ['Check filed cash flow'],
      questions: ['How durable is the margin?'], evidenceIds: [], researchStance: 'balanced' }, tokens: 8 };
  });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  const result = await completed(svc, session.id);
  const messages = result.messages.filter((item) => item.memberId);
  assert.equal(contexts.length, 4);
  assert.deepEqual(messages.map((item) => item.phase), ['opening', 'challenge', 'response', 'summary']);
  assert.ok(contexts[1].conversation?.some((item) => item.content.includes('Public contribution 1')));
  assert.equal(messages[1].replyToMessageId, messages[0].id);
  assert.deepEqual(messages[0].reasoningSummary, ['Check filed cash flow']);
  assert.equal(result.reports[0].researchStance, 'balanced');
  assert.equal(result.reports[0].decision, 'wait', 'Manual research has no trade approval capability');
});

dbTest('structured replies survive persistence with exact task, revision and turn identity and full report details', async () => {
  const response = { thesis: 'The evidence supports a balanced view.', evidencePoints: ['Cash flow covers reported capex.'],
    risks: ['Valuation remains uncertain.'], nextChecks: ['Review the next filing.'], details: 'Complete supporting analysis. '.repeat(200) };
  const svc = service(async () => ({ data: { response, evidenceIds: [], researchStance: 'balanced' }, tokens: 8 }));
  const session = await svc.createSession(owner, { ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  const result = await completed(svc, session.id);
  const replies = result.messages.filter(message => message.response);
  assert.equal(replies.length, 4);
  assert.deepEqual(replies.map(message => message.turn), [0, 1, 2, 3]);
  assert.ok(replies.every(message => message.cycleId && message.taskId && message.revision === result.revision));
  // The parser normalizes boundary whitespace; every substantive sentence must survive persistence.
  assert.deepEqual(replies[0].response, { ...response, details: response.details.trim() });
  for (const reply of replies) {
    assert.ok(result.researchEvents?.some(event => event.taskId === reply.taskId
      && event.revision === reply.revision && event.turn === reply.turn));
  }
  assert.ok(result.messages.filter(message => message.phase === 'progress').every(message => message.researchEventId));
  assert.ok(result.reports[0].summary.includes(response.details.trim()));
});

dbTest('manual research rooms require no Builder profile and cannot become trading candidates', async () => {
  const svc = service();
  const session = await svc.createSession(owner, { ticker: 'AAPL', language: 'en', webResearch: false });
  assert.equal(session.profileId, null);
  assert.equal(session.members?.length, 3);
  const [row] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
  assert.equal(row.candidate, null);
  assert.equal(row.profileSnapshot.template, 'guard');
  assert.deepEqual(row.profileSnapshot.priceRules, []);
});

dbTest('six custom members use seven turns and each selected connection routes without a default model', async () => {
  const members = Array.from({ length: 6 }, (_, index) => ({ id: `expert${index}`, role: index === 5 ? 'manager' as const : 'researcher' as const,
    name: `Expert ${index}`, instructions: '', model: 'fast' as const, connectionId: randomUUID() }));
  const connections: string[] = [];
  const svc = service();
  Reflect.set(svc, 'llm', { validateConnectionIds: async (_owner: string, ids: string[]) => assert.deepEqual(ids, members.map((member) => member.connectionId)),
    isConfigured: async (_owner: string, connectionId?: string) => Boolean(connectionId),
    chatFastJSON: async (_prompt: unknown, _owner: string, options: { connectionId: string }) => {
      connections.push(options.connectionId);
      return { data: { content: 'Review this evidence', evidenceIds: [], researchStance: 'cautious' }, tokens: 4 };
    } });
  const session = await svc.createSession(owner, { ticker: 'AAPL', members });
  await svc.runSession(owner, session.id);
  const result = await completed(svc, session.id);
  assert.equal(result.status, 'completed');
  assert.deepEqual(connections, [...members.slice(0, 5).map((member) => member.connectionId), members[0].connectionId, members[5].connectionId]);
});

dbTest('a failed turn resumes at its checkpoint without replaying successful members or resetting task usage', async () => {
  let calls = 0;
  let fail = true;
  const tasks: string[] = [];
  const svc = service(async (...args: unknown[]) => {
    calls++;
    tasks.push((args[2] as { taskId: string }).taskId);
    if (calls === 2 && fail) throw new Error('LLM provider returned HTTP 503');
    return { data: { content: `Contribution ${calls}`, evidenceIds: [] }, tokens: 4 };
  });
  const session = await svc.createSession(owner, { ticker: 'AAPL' });
  await svc.runSession(owner, session.id);
  const failed = await completed(svc, session.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.progress?.turn, 2);
  fail = false;
  await svc.addMessage(owner, session.id, 'Continue with the saved evidence');
  await svc.runSession(owner, session.id);
  const done = await completed(svc, session.id);
  assert.equal(calls, 5);
  assert.equal(new Set(tasks).size, 1);
  assert.equal(done.messages.filter((item) => item.phase === 'opening').length, 1);
  assert.equal(done.reports.length, 2);
});

dbTest('steering while the moderator is speaking repeats only the outdated summary', async () => {
  let calls = 0;
  let sessionId = '';
  const svc = service(async () => {
    calls++;
    if (calls === 4) await svc.addMessage(owner, sessionId, 'Please include the debt maturity risk');
    return { data: { content: `Contribution ${calls}`, evidenceIds: [] }, tokens: 4 };
  });
  sessionId = (await svc.createSession(owner, { ticker: 'AAPL' })).id;
  await svc.runSession(owner, sessionId);
  const result = await completed(svc, sessionId);
  assert.equal(calls, 5);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].summary, 'Contribution 5');
  assert.equal(result.reports[0].revision, result.revision);
});

dbTest('requested tools are fixed to the room ticker and two categories with persisted real progress', async () => {
  let calls = 0;
  const tools: string[] = [];
  const svc = service(async (...args: unknown[]) => {
    calls++;
    const context = JSON.parse((args[0] as Array<{ content: string }>)[1].content);
    if (calls === 2) assert.ok(context.evidence.some((item: { content: string }) => item.content.includes('Verified tool financials')));
    return { data: { content: `Contribution ${calls}`, evidenceIds: [], researchRequests:
      calls === 1 ? [{ kind: 'financials' }, { kind: 'news' }] : [{ kind: 'financials' }, { kind: 'web' }] }, tokens: 4 };
  });
  Reflect.set(svc, 'evidence', { collectEvidence: async () => [{ role: 'fundamental', evidenceType: 'other',
    title: 'AAPL Financial statements unavailable', content: 'Missing source', sourceName: 'Data Unavailable', relevanceScore: 0 }],
  collectResearch: async (ticker: string, user: string, kind: string, _language: string,
    options: { onAcquisition: (event: { source: string; status: string; detail: string }) => Promise<void> }) => {
    assert.equal(ticker, 'AAPL'); assert.equal(user, owner); tools.push(kind);
    await options.onAcquisition({ source: 'Fixture source', status: 'succeeded', detail: `Retrieved ${kind}` });
    return [{ role: kind === 'news' ? 'news' : 'fundamental', evidenceType: kind === 'news' ? 'news' : 'financial',
      title: `AAPL ${kind}`, content: `Verified tool ${kind}`, sourceName: 'Fixture source', relevanceScore: 1 }];
  } });
  const session = await svc.createSession(owner, { ticker: 'AAPL', webResearch: false });
  await svc.runSession(owner, session.id);
  const done = await completed(svc, session.id);
  assert.deepEqual(tools, ['financials', 'news']);
  assert.equal(calls, 4);
  assert.ok(done.messages.some((item) => item.acquisition?.source === 'Fixture source' && item.acquisition.status === 'succeeded'));
  assert.ok(done.messages.some((item) => item.acquisition?.status === 'skipped'));
  assert.ok(!done.reports[0].evidence.some((item) => item.title.includes('statements unavailable')));
});

dbTest('refreshing a source retains earlier message citations in the final report and empty tools retain gaps', async () => {
  let cited = '';
  let calls = 0;
  const svc = service(async (...args: unknown[]) => {
    calls++;
    const context = JSON.parse((args[0] as Array<{ content: string }>)[1].content);
    if (calls === 1) cited = context.evidence.find((item: { title: string }) => item.title === 'AAPL financial statements').id;
    return { data: { content: 'Check revised facts', evidenceIds: calls === 1 ? [cited] : [],
      researchRequests: calls === 1 ? [{ kind: 'financials' }, { kind: 'valuation' }] : [] }, tokens: 4 };
  });
  Reflect.set(svc, 'evidence', { collectEvidence: async () => [
    { role: 'fundamental', evidenceType: 'financial', title: 'AAPL financial statements', content: 'Old filed revenue USD 100', sourceName: 'SEC EDGAR', relevanceScore: 1 },
    { role: 'fundamental', evidenceType: 'other', title: 'AAPL valuation unavailable', content: 'No valuation', sourceName: 'Data Unavailable', relevanceScore: 0 },
  ], collectResearch: async (_ticker: string, _owner: string, kind: string) => kind === 'valuation' ? [] : [
    { role: 'fundamental', evidenceType: 'financial', title: 'AAPL financial statements', content: 'Revised filed revenue USD 110', sourceName: 'SEC EDGAR', relevanceScore: 1 },
  ] });
  const session = await svc.createSession(owner, { ticker: 'AAPL' });
  await svc.runSession(owner, session.id);
  const result = await completed(svc, session.id);
  assert.ok(result.reports[0].evidence.some((item) => item.id === cited), 'A cited replaced source must remain resolvable');
  assert.ok(result.reports[0].evidence.some((item) => item.content === 'No valuation'), 'An empty response cannot erase a critical gap');
});

dbTest('Chinese steering and customized personas fit the default input budget while retaining the latest question and direct rationale', async () => {
  const { estimateInputTokens, DEFAULT_LLM_BUDGET } = await import('../llm-budget/llm-budget.rules');
  const newest = '请重点分析现金流负债与收入的关系，并明确说明风险。'.repeat(20).slice(0, 500);
  const captures: number[] = [];
  const svc = service(async (...args: unknown[]) => {
    const prompt = args[0] as Array<{ role: string; content: string }>;
    const context = JSON.parse(prompt[1].content);
    assert.ok(context.steering.includes(newest));
    if (captures.length) {
      assert.ok(context.conversation.some((item: { questions?: string[] }) => item.questions?.includes('负债的期限是否匹配现金流？')));
      assert.ok(context.conversation.some((item: { reasoningSummary?: string[] }) => item.reasoningSummary?.includes('已核实本期现金流与负债的币种一致')));
    }
    captures.push(estimateInputTokens([...prompt, { role: 'system', content: '你必须严格按照用户要求的 JSON 格式输出，不要添加任何解释、说明或 markdown 格式。只输出合法的 JSON 字符串。' }]));
    return { data: { content: '这里是公开的分析结论。'.repeat(90), reasoningSummary: ['已核实本期现金流与负债的币种一致'],
      questions: ['负债的期限是否匹配现金流？'], evidenceIds: [] }, tokens: 5 };
  });
  const members = [{ id: 'fundamental', role: 'researcher' as const }, { id: 'risk', role: 'challenger' as const }, { id: 'chair', role: 'manager' as const }]
    .map((item) => ({ ...item, name: item.id, model: 'fast' as const, instructions: '关注现金流与风险。'.repeat(100).slice(0, 1000),
      personality: '耐心、严谨，追问证据。'.repeat(30).slice(0, 240) }));
  await db.update(builderProfiles).set({ config: { ...config, customPrompt: '审查投资依据。'.repeat(100) } }).where(eq(builderProfiles.id, profileId));
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', members, language: 'zh-CN' });
  await svc.addMessage(owner, session.id, newest);
  await svc.runSession(owner, session.id);
  const result = await completed(svc, session.id);
  assert.equal(result.status, 'completed');
  assert.equal(captures.length, 4);
  for (const size of captures) assert.ok(size <= DEFAULT_LLM_BUDGET.maxInputTokens, `packed prompt ${size}`);
  await db.update(builderProfiles).set({ config }).where(eq(builderProfiles.id, profileId));
});

dbTest('portfolio and saved-report failures do not prevent fresh stock evidence collection', async () => {
  const svc = service();
  let collected = 0;
  Reflect.set(svc, 'portfolio', { getPortfolioContext: async () => { throw new Error('FX unavailable'); } });
  Reflect.set(svc, 'research', { listRuns: async () => { throw new Error('old report unavailable'); } });
  Reflect.set(svc, 'evidence', { collectEvidence: async (_ticker: string, _owner: string, context: unknown) => {
    collected++;
    assert.equal(context, null);
    return [{ role: 'fundamental', evidenceType: 'financial', title: 'Verified statement', content: 'Filed revenue', sourceName: 'Finnhub API', relevanceScore: 1 }];
  } });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  const result = await completed(svc, session.id);
  assert.equal(collected, 1);
  assert.ok(result.reports[0].evidence.some((item) => item.title === 'Verified statement'));
  assert.ok(result.reports[0].evidence.some((item) => /portfolio.*unavailable/i.test(item.title)));
});

dbTest('explicit discussion resume refreshes old gaps, preserves reports and retains the task budget', async () => {
  const svc = service();
  let available = false;
  let collected = 0;
  Reflect.set(svc, 'evidence', { collectEvidence: async () => {
    collected++;
    return [{ role: 'fundamental', evidenceType: 'financial', title: available ? 'Verified statement' : 'Missing key',
      content: available ? 'Filed revenue' : 'Configure key', sourceName: available ? 'Finnhub API' : 'Data Unavailable', relevanceScore: available ? 1 : 0 }];
  } });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  const first = await completed(svc, session.id);
  const [before] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
  available = true;
  await svc.runSession(owner, session.id);
  const second = await completed(svc, session.id);
  const [after] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
  assert.equal(collected, 2);
  assert.equal(after.taskId, before.taskId);
  assert.deepEqual(second.reports.find((item) => item.id === first.reports[0].id), first.reports[0]);
  assert.ok(second.reports.find((item) => item.version === 2)?.evidence.some((item) => item.title === 'Verified statement'));
});

dbTest('incomplete cached research is recollected instead of perpetuating old missing-key gaps', async () => {
  const svc = service();
  let collected = 0;
  Reflect.set(svc, 'research', {
    listRuns: async () => ({ items: [{ id: randomUUID(), completedAt: new Date().toISOString() }] }),
    getEvidence: async () => [{ id: randomUUID(), role: 'fundamental', evidenceType: 'other', title: 'Old missing key',
      content: 'old', sourceName: 'Data Unavailable', relevanceScore: 0, fetchedAt: new Date().toISOString(), sourceUrl: null }],
  });
  Reflect.set(svc, 'evidence', { collectEvidence: async () => {
    collected++;
    return [{ role: 'fundamental', evidenceType: 'financial', title: 'Fresh statement', content: 'new', sourceName: 'Finnhub API', relevanceScore: 1 }];
  } });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  const result = await completed(svc, session.id);
  assert.equal(collected, 1);
  assert.ok(!result.reports[0].evidence.some((item) => item.title === 'Old missing key'));
  assert.equal(result.reports[0].sourceRunId, null);
});

dbTest('follow-up round includes the latest published discussion without copying the entire chat', async () => {
  const contexts: Array<{ previousDiscussion?: Array<{ content: string }> }> = [];
  const svc = service(async (...args: unknown[]) => {
    contexts.push(JSON.parse((args[0] as Array<{ content: string }>)[1].content));
    return { data: { decision: 'wait', summary: 'Prior concern about cash flow', evidenceIds: [], dissent: [], nextReviewCondition: 'financials' }, tokens: 5 };
  });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  await completed(svc, session.id);
  await svc.addMessage(owner, session.id, 'Please explain that cash flow concern');
  await svc.runSession(owner, session.id);
  await completed(svc, session.id);
  assert.ok(contexts[4].previousDiscussion?.some((item) => item.content.includes('Prior concern')));
  assert.ok(contexts[4].previousDiscussion.length <= 3);
});

dbTest('sending notes to a failed discussion preserves its failure until explicit retry', async () => {
  const svc = service(async () => { throw new Error('LLM_BUDGET_EXCEEDED'); });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  const failed = await completed(svc, session.id);
  for (const note of ['First follow-up', 'Second follow-up']) {
    const updated = await svc.addMessage(owner, session.id, note);
    assert.equal(updated.status, 'failed');
    assert.equal(updated.error, failed.error);
  }
});

dbTest('cross-owner session reads, steering, pause and run all refuse access', async () => {
  const svc = service();
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  for (const fn of [() => svc.getSession(other, session.id), () => svc.addMessage(other, session.id, 'steer'), () => svc.pauseSession(other, session.id), () => svc.runSession(other, session.id)]) {
    await assert.rejects(fn, /not found/i);
  }
  assert.deepEqual(await svc.listSessions(other), []);
});

dbTest('missing model publishes an honest basic wait report without invented member messages', async () => {
  const svc = service(undefined, false);
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  const result = await completed(svc, session.id);
  assert.equal(result.reports[0].engine, 'basic');
  assert.equal(result.reports[0].decision, 'wait');
  assert.equal(result.messages.filter((item) => ['researcher', 'challenger', 'manager'].includes(item.role)).length, 0);
});

dbTest('budget errors publish wait and preserve the session task budget', async () => {
  const svc = service(async () => { throw new Error('LLM_BUDGET_EXCEEDED'); });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  const result = await completed(svc, session.id);
  assert.equal(result.reports[0].decision, 'wait');
  assert.match(result.reports[0].summary, /budget|unavailable|complete/i);
});

dbTest('pause during an in-flight call prevents report approval and a manager call', async () => {
  let release: () => void;
  let calls = 0;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const svc = service(async () => { calls++; await barrier; return { data: { decision: 'wait', summary: 'Wait', evidenceIds: [] }, tokens: 4 }; });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  while (!calls) await new Promise((resolve) => setTimeout(resolve, 10));
  await svc.pauseSession(owner, session.id);
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const paused = await svc.getSession(owner, session.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.reports.length, 0);
  assert.equal(calls, 1);
});

dbTest('steering invalidates old revision, reuses taskId, persists partial messages and yields one current report', async () => {
  let release: () => void;
  let calls = 0;
  const taskIds: string[] = [];
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const svc = service(async (...args: unknown[]) => {
    calls++;
    taskIds.push((args[2] as { taskId: string }).taskId);
    if (calls <= 2) await barrier;
    return { data: { decision: 'wait', summary: 'Wait for facts', evidenceIds: [] }, tokens: 4 };
  });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  while (!calls) await new Promise((resolve) => setTimeout(resolve, 10));
  await svc.addMessage(owner, session.id, 'Consider downside cash flow');
  release();
  const result = await completed(svc, session.id);
  assert.equal(new Set(taskIds).size, 1);
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].revision, result.revision);
  assert.ok(result.messages.some((item) => item.role === 'user'));
  assert.ok(result.messages.some((item) => item.revision < result.revision && item.role === 'researcher'));
});

dbTest('unchanged wait candidates reuse saved result without additional model calls', async () => {
  let calls = 0;
  const svc = service(async () => { calls++; return { data: { decision: 'wait', summary: 'Wait', evidenceIds: [] }, tokens: 4 }; });
  const profile = { id: profileId, config, version: 1, status: 'active' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const first = await svc.reviewCandidate(owner, profile, candidate);
  const second = await svc.reviewCandidate(owner, profile, { ...candidate, price: 100.01 });
  assert.equal(first.approved, false);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(calls, 4);
});

dbTest('default prompts stay within the default conservative input budget', async () => {
  const { estimateInputTokens, DEFAULT_LLM_BUDGET } = await import('../llm-budget/llm-budget.rules');
  const captures: number[] = [];
  const svc = service(async (...args: unknown[]) => {
    const prompt = args[0] as Array<{ role: string; content: string }>;
    captures.push(estimateInputTokens([...prompt, { role: 'system', content: '你必须严格按照用户要求的 JSON 格式输出，不要添加任何解释、说明或 markdown 格式。只输出合法的 JSON 字符串。' }]));
    return { data: { decision: 'wait', summary: '本季度现金流已有数据，需继续审查负债和估值风险。'.repeat(25),
      dissent: ['潜在风险需进一步核实。'.repeat(25), '数据来源有时效限制。'.repeat(25)], evidenceIds: [] }, tokens: 5 };
  });
  Reflect.set(svc, 'evidence', { collectEvidence: async () => Array.from({ length: 12 }, (_, i) => ({
    role: i < 8 ? 'fundamental' : 'news', evidenceType: i === 0 ? 'price' : 'other',
    title: `实际证据 ${i}`, content: '企业报表与估值数据缺少充分证据，当前结论需等待后续财报披露。'.repeat(12),
    sourceName: i % 2 === 0 ? 'provider' : 'Data Unavailable', relevanceScore: i % 2 === 0 ? 1 : 0,
  })) });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'zh-CN' });
  await svc.runSession(owner, session.id);
  await completed(svc, session.id);
  await svc.addMessage(owner, session.id, '请进一步解释现金流和负债方面的差异');
  await svc.runSession(owner, session.id);
  await completed(svc, session.id);
  assert.equal(captures.length, 8);
  assert.ok(captures.slice(0, 4).reduce((sum, size) => sum + size + DEFAULT_LLM_BUDGET.maxOutputTokens, 0)
    <= DEFAULT_LLM_BUDGET.perTaskTokenLimit, `default round reservations: ${captures.slice(0, 4)}`);
  for (const size of captures) assert.ok(size <= DEFAULT_LLM_BUDGET.maxInputTokens, `prompt size ${size}`);
});

dbTest('duplicate run requests across service instances start only one council job', async () => {
  let release: () => void;
  let calls = 0;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const chat = async () => { calls++; await barrier; return { data: { decision: 'wait', summary: 'Wait', evidenceIds: [] }, tokens: 4 }; };
  const first = service(chat);
  const second = service(chat);
  const session = await first.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await first.runSession(owner, session.id);
  while (!calls) await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? first : second).runSession(owner, session.id)));
  assert.equal(calls, 1);
  release();
  const result = await completed(first, session.id);
  assert.equal(calls, 4);
  assert.equal(result.reports.length, 1);
});

dbTest('pause followed immediately by resume drains old calls and finishes the current revision', async () => {
  let release: () => void;
  let calls = 0;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const svc = service(async () => { calls++; if (calls <= 2) await barrier;
    return { data: { decision: 'wait', summary: 'Wait', evidenceIds: [] }, tokens: 4 }; });
  const session = await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' });
  await svc.runSession(owner, session.id);
  while (!calls) await new Promise((resolve) => setTimeout(resolve, 10));
  await svc.pauseSession(owner, session.id);
  await svc.runSession(owner, session.id);
  release();
  const result = await completed(svc, session.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].revision, result.revision);
  assert.equal(calls, 4);
});

dbTest('repeated steering cannot create unbounded automatic restarts', async () => {
  let calls = 0;
  let sessionId = '';
  const svc = service(async () => {
    calls++;
    if (calls % 2 === 1) await svc.addMessage(owner, sessionId, `Revision ${calls}`);
    return { data: { decision: 'wait', summary: 'Wait', evidenceIds: [] }, tokens: 4 };
  });
  sessionId = (await svc.createSession(owner, { profileId, ticker: 'AAPL', language: 'en' })).id;
  await svc.runSession(owner, sessionId);
  const result = await completed(svc, sessionId);
  assert.ok(calls <= 6);
  assert.equal(result.reports.at(-1)?.decision, 'wait');
  assert.equal(calls, 4, 'Steering must not replay completed turns');
  assert.equal(result.status, 'completed');
});

dbTest('rule-only approval preserves exact candidate and changed quote cannot reuse that approval', async () => {
  let calls = 0;
  const svc = service(async (...args: unknown[]) => {
    calls++;
    const data = JSON.parse((args[0] as Array<{ content: string }>)[1].content);
    return { data: { decision: 'approve', summary: 'Rule-only approval; financial evidence remains missing.',
      evidenceIds: [data.evidence[0].id], dissent: ['No research forecast'], nextReviewCondition: 'Review next scheduled trigger' }, tokens: 4 };
  });
  const profile = { id: profileId, config, version: 1, status: 'active' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const exact = { ...candidate, quantity: 3 };
  const first = await svc.reviewCandidate(owner, profile, exact);
  assert.equal(first.approved, true);
  const same = await svc.reviewCandidate(owner, profile, exact);
  assert.equal(same.reportId, first.reportId);
  assert.equal(calls, 4);
  const changed = await svc.reviewCandidate(owner, profile, { ...exact, price: 100.01 });
  assert.equal(changed.approved, true);
  assert.notEqual(changed.reportId, first.reportId);
  assert.equal(calls, 8);
  const stored = await svc.getSession(owner, changed.sessionId);
  assert.deepEqual(stored.reports[0].candidate, { ...exact, price: 100.01 });
});

dbTest('research-driven model approval is forced to wait when critical financial evidence is missing', async () => {
  const svc = service(async (...args: unknown[]) => {
    const data = JSON.parse((args[0] as Array<{ content: string }>)[1].content);
    return { data: { decision: 'approve', summary: 'Model attempts approval', evidenceIds: [data.evidence[0].id] }, tokens: 4 };
  });
  const profile = { id: profileId, config: { ...config, language: 'en' as const }, version: 1, status: 'active' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await db.update(builderProfiles).set({ config: profile.config }).where(eq(builderProfiles.id, profileId));
  const result = await svc.reviewCandidate(owner, profile, { ...candidate, reason: 'AI Buy rating', quantity: 7 });
  const stored = await svc.getSession(owner, result.sessionId);
  assert.equal(stored.reports[0].decision, 'wait');
  assert.match(stored.reports[0].summary, /Critical research evidence is missing/);
});
