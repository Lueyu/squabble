import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { councilSessions } from '../../database/council.schema';
import { CouncilService } from './council.service';
import type { ResolvedReportReference } from '../../../shared/research-document.interface';
import type { LocalAgentExecution } from '../local-agents/local-agents.types';

const url = process.env.COUNCIL_TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;
const client = url ? postgres(url, { max: 4, onnotice: () => undefined }) : null;
const db = client ? drizzle(client) : null;
const owner = randomUUID();
const foreign = randomUUID();
const versionId = randomUUID();
const reference: ResolvedReportReference = { versionId, reportId: randomUUID(), version: 1, title: 'Frozen portfolio', kind: 'portfolio',
  ticker: null, content: 'Original concentration: 45%', section: null, dataAsOf: null, availableAt: null,
  createdAt: new Date().toISOString(), snapshot: { holdings: [{ ticker: 'AAPL', quantity: 10 }] }, source: null,
  parentVersionId: null, status: 'valid', sourceStatus: 'available' };
before(async () => {
  if (!client) return;
  await client.unsafe(readFileSync('scripts/db/27_research_threads.sql', 'utf8'));
});
after(async () => {
  if (!client) return;
  await db!.delete(councilSessions).where(eq(councilSessions.owner, owner));
  await client.end();
});
function service() {
  const contexts: Array<Record<string, unknown>> = [];
  let collections = 0;
  let revoked = false;
  const chat = async (messages: Array<{ content: string }>) => {
    contexts.push(JSON.parse(messages[1].content));
    return { data: { content: 'Portfolio findings', evidenceIds: [], researchStance: 'balanced' }, tokens: 1 };
  };
  const svc = new CouncilService(db!, { isConfigured: async () => true, validateConnectionIds: async () => undefined,
    chatFastJSON: chat, chatSlowJSON: chat } as never,
  { collectEvidence: async () => { collections++; return []; } } as never,
  { getPortfolioContext: async () => ({ totalValue: 1000, cash: 400, holdings: [{ ticker: 'AAPL', quantity: 10 }] }) } as never,
  { listRuns: async () => ({ items: [] }) } as never, undefined, undefined, undefined, undefined,
  { resolveReferences: async (user: string, refs: Array<{ versionId: string }>) => {
    if (user !== owner || refs.some(ref => ref.versionId !== versionId)) throw new Error('Reference unavailable');
    return refs.map(() => ({ ...reference, status: revoked ? 'revoked' : 'valid' }));
  }, importSource: async () => ({ id: randomUUID() }), importSourceInTransaction: async () => ({ id: randomUUID() }) } as never);
  return { svc, contexts, collections: () => collections, revoke: () => { revoked = true; } };
}
async function finish(svc: CouncilService, id: string) {
  for (let count = 0; count < 200; count++) {
    const session = await svc.getSession(owner, id);
    if (session.status !== 'running') return session;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
}

dbTest('portfolio research sends actual pinned content and never queries the synthetic ticker', async () => {
  const run = service();
  const session = await run.svc.createSession(owner, { scene: 'portfolio_daily', subject: 'Today', references: [{ versionId }] });
  await run.svc.runSession(owner, session.id);
  const done = await finish(run.svc, session.id);
  assert.equal(done.status, 'completed');
  assert.equal(run.collections(), 0);
  assert.equal((run.contexts[0].thread as { pinnedReports: ResolvedReportReference[] }).pinnedReports[0].content, reference.content);
  assert.ok(done.reports[0].researchVersionId);
  run.revoke();
  await assert.rejects(run.svc.createSession(owner, { scene: 'trade_pre_review', ticker: 'AAPL', references: [{ versionId }] }), /revoked/iu);
});

dbTest('message replies and forks reject foreign identities and freeze only preceding parent text', async () => {
  const { svc } = service();
  const parent = await svc.createSession(owner, { ticker: 'AAPL', references: [{ versionId }] });
  const other = await svc.createSession(owner, { ticker: 'MSFT' });
  const first = await svc.addMessage(owner, parent.id, 'Original hypothesis');
  const messageId = first.messages[0].id;
  await svc.addMessage(owner, parent.id, 'Quote the same report again', { references: [{ versionId }] });
  await assert.rejects(svc.addMessage(owner, other.id, 'reply', { replyToMessageId: messageId }), /belong/iu);
  await assert.rejects(svc.forkSession(foreign, parent.id, { messageId }), /not found/iu);
  const child = await svc.forkSession(owner, parent.id, { messageId });
  await svc.addMessage(owner, parent.id, 'Later hypothesis');
  const frozen = await svc.getSession(owner, child.id);
  assert.equal(frozen.parentSessionId, parent.id);
  assert.deepEqual(frozen.inheritedContext?.map(item => item.content), ['Original hypothesis']);
  assert.equal(frozen.resolvedReferences?.[0].content, reference.content);
  const reply = await svc.addMessage(owner, parent.id, 'Check assumptions', { replyToMessageId: messageId });
  assert.equal(reply.messages.at(-1)?.replyToMessageId, messageId);
});

dbTest('message limit gives an explicit continuation branch without deleting history', async () => {
  const { svc } = service();
  let session = await svc.createSession(owner, { ticker: 'AAPL' });
  for (let index = 0; index < 30; index++) session = await svc.addMessage(owner, session.id, `Question ${index}`);
  await assert.rejects(svc.addMessage(owner, session.id, 'Question 31'), /Fork/iu);
  const child = await svc.forkSession(owner, session.id, { messageId: session.messages.at(-1)!.id });
  assert.equal(child.inheritedContext?.length, 30);
  assert.equal((await svc.addMessage(owner, child.id, 'Continue')).messages.length, 1);
});

dbTest('a discussion can draft a revision only for its exact referenced version', async () => {
  const run = service();
  const session = await run.svc.createSession(owner, { scene: 'portfolio_daily', references: [{ versionId }] });
  await run.svc.runSession(owner, session.id);
  const done = await finish(run.svc, session.id);
  await assert.rejects(run.svc.draftReportRevision(owner, session.id, done.reports[0].id, randomUUID()), /pinned/iu);
  let saved: { content: string; changeReason: string } | undefined;
  Reflect.set(run.svc, 'documents', { getVersion: async () => ({ ...reference, id: versionId, sections: [{ id: 'facts', title: 'Facts', content: 'Original facts' }] }),
    resolveReferences: async () => [reference], createDraftInTransaction: async (_tx: unknown, _owner: string, parent: string, input: { content: string; changeReason: string }) => {
      assert.equal(parent, versionId); saved = input; return { id: 'draft' };
    } });
  await run.svc.draftReportRevision(owner, session.id, done.reports[0].id, versionId);
  assert.match(saved!.content, /Original concentration/u);
  assert.match(saved!.content, /Portfolio findings/u);
  assert.match(saved!.changeReason, new RegExp(session.id, 'u'));
});

dbTest('native portfolio tasks receive exact report content and no synthetic ticker tool scope', async () => {
  const run = service();
  const prompts: string[] = [];
  Reflect.set(run.svc, 'localAgents', { validate: async () => undefined,
    execute: async (_owner: string, options: LocalAgentExecution) => {
      prompts.push(options.prompt);
      assert.equal(options.researchScope, undefined);
      await options.onDispatch?.();
      return { text: '', data: { content: 'Native portfolio findings', evidenceIds: [], researchStance: 'balanced' }, usageTokens: null };
    } });
  const session = await run.svc.createSession(owner, { scene: 'portfolio_daily', references: [{ versionId }], members: [
    { id: 'researcher', name: 'Researcher', role: 'researcher', model: 'fast', instructions: '', executionMode: 'local', agentId: 'fixture' },
    { id: 'manager', name: 'Manager', role: 'manager', model: 'slow', instructions: '', executionMode: 'local', agentId: 'fixture' },
  ] });
  await run.svc.runSession(owner, session.id);
  const done = await finish(run.svc, session.id);
  assert.equal(done.status, 'completed');
  assert.ok(prompts.length >= 2);
  for (const prompt of prompts) { assert.ok(prompt.includes(reference.content)); assert.ok(prompt.includes(versionId)); }
  assert.equal(run.collections(), 0);
});

dbTest('revocation during a final model response prevents publishing a successful report', async () => {
  const run = service();
  let calls = 0;
  const chat = async () => {
    calls++;
    if (calls === 4) run.revoke();
    return { data: { content: 'Must not publish revoked conclusion', evidenceIds: [], researchStance: 'balanced' }, tokens: 1 };
  };
  Reflect.set(run.svc, 'llm', { isConfigured: async () => true, validateConnectionIds: async () => undefined,
    chatFastJSON: chat, chatSlowJSON: chat });
  const session = await run.svc.createSession(owner, { scene: 'trade_pre_review', ticker: 'AAPL', references: [{ versionId }] });
  await run.svc.runSession(owner, session.id);
  const done = await finish(run.svc, session.id);
  assert.notEqual(done.status, 'completed');
  assert.equal(done.reports.some(report => report.publicationOutcome === 'succeeded'), false);
});

dbTest('reviewed continuation freezes source IDs and references, while research can challenge revoked material', async () => {
  const run = service();
  run.revoke();
  await assert.rejects(run.svc.createSession(owner, { scene: 'trade_pre_review', ticker: 'AAPL', references: [{ versionId }] }), /revoked/iu);
  const parent = await run.svc.createSession(owner, { scene: 'portfolio_daily', references: [{ versionId }] });
  const saved = await run.svc.addMessage(owner, parent.id, 'Old conclusion must be checked');
  const child = await run.svc.forkSession(owner, parent.id, { messageId: saved.messages[0].id, summary: 'Unverified hypothesis; recheck sources' });
  assert.equal(child.continuationSummary?.content, 'Unverified hypothesis; recheck sources');
  assert.deepEqual(child.continuationSummary?.sourceMessageIds, [saved.messages[0].id]);
  assert.deepEqual(child.continuationSummary?.references, [{ versionId }]);
  await run.svc.runSession(owner, child.id);
  assert.equal((await finish(run.svc, child.id)).status, 'completed');
  const thread = run.contexts[0].thread as { parentDiscussion: unknown[]; continuationSummary: { content: string }; pinnedReports: ResolvedReportReference[] };
  assert.deepEqual(thread.parentDiscussion, []);
  assert.match(thread.continuationSummary.content, /Unverified/u);
  assert.equal(thread.pinnedReports[0].status, 'revoked');
});

dbTest('AI section revisions durably claim before generation and never repeat a completed request', async () => {
  const run = service();
  const session = await run.svc.createSession(owner, { scene: 'portfolio_daily', references: [{ versionId }] });
  await run.svc.runSession(owner, session.id);
  const done = await finish(run.svc, session.id);
  let calls = 0;
  let saved: { sections: Array<{ id: string; content: string }>; content: string } | undefined;
  Reflect.set(run.svc, 'llm', { isConfigured: async () => true, chatSlowJSON: async () => {
    calls++;
    const claims = await client!`select status from council_revision_requests where owner = ${owner}`;
    assert.ok(claims.some(row => row.status === 'pending'));
    return { data: { content: 'Revised evidence with uncertainty' }, tokens: 2 };
  } });
  Reflect.set(run.svc, 'documents', { getVersion: async () => ({ ...reference, id: versionId, content: 'Original facts\nOther risks',
    sections: [{ id: 'facts', title: 'Facts', content: 'Original facts' }, { id: 'risk', title: 'Risk', content: 'Other risks' }] }),
  resolveReferences: async () => [reference], createDraftInTransaction: async (_tx: unknown, _owner: string, parent: string, input: typeof saved) => {
    saved = input; return { ...input, id: randomUUID(), parentVersionId: parent };
  } });
  const options = { sectionId: 'facts', generate: true, requestId: randomUUID() };
  const draft = await run.svc.draftReportRevision(owner, session.id, done.reports[0].id, versionId, options);
  const duplicate = await run.svc.draftReportRevision(owner, session.id, done.reports[0].id, versionId, options);
  assert.equal(duplicate.id, draft.id);
  assert.equal(calls, 1);
  assert.equal(saved?.sections[0].content, 'Revised evidence with uncertainty');
  assert.equal(saved?.sections[1].content, 'Other risks');
  assert.equal(saved?.content.includes('Original facts'), false);
  await assert.rejects(run.svc.draftReportRevision(owner, session.id, done.reports[0].id, versionId, { ...options, sectionId: 'risk' }), /identity/iu);
});

dbTest('concurrent or failed AI revision claims cannot replay a paid request across service calls', async () => {
  const run = service();
  const session = await run.svc.createSession(owner, { scene: 'portfolio_daily', references: [{ versionId }] });
  await run.svc.runSession(owner, session.id);
  const done = await finish(run.svc, session.id);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  Reflect.set(run.svc, 'llm', { isConfigured: async () => true, chatSlowJSON: async () => {
    calls++; started(); await barrier; throw new Error('Ambiguous provider response');
  } });
  Reflect.set(run.svc, 'documents', { getVersion: async () => ({ ...reference, id: versionId, sections: [] }), resolveReferences: async () => [reference] });
  const options = { generate: true, requestId: randomUUID() };
  const pending = assert.rejects(run.svc.draftReportRevision(owner, session.id, done.reports[0].id, versionId, options), /Ambiguous/iu);
  await ready;
  await assert.rejects(run.svc.draftReportRevision(owner, session.id, done.reports[0].id, versionId, options), /claimed/iu);
  release(); await pending;
  await assert.rejects(run.svc.draftReportRevision(owner, session.id, done.reports[0].id, versionId, options), /failed/iu);
  assert.equal(calls, 1);
});

dbTest('scene and topic filters remain owner scoped and keep pre-trade distinct from post-trade', async () => {
  const { svc } = service();
  const pre = await svc.createSession(owner, { scene: 'trade_pre_review', ticker: 'AAPL', subject: 'Unique allocation review' });
  await svc.createSession(owner, { scene: 'trade_post_review', subject: 'Unique allocation review' });
  const filtered = await svc.listSessions(owner, { scene: 'trade_pre_review', topic: 'Unique allocation' });
  assert.deepEqual(filtered.map(item => item.id), [pre.id]);
  assert.deepEqual(await svc.listSessions(foreign, { topic: 'Unique allocation' }), []);
  assert.deepEqual(await svc.listSessions(owner, { topic: '%_SQL wildcard' }), []);
});
