import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { CouncilService } from './council.service';
import { dailyResearchMembers } from './council.daily';
import { ResearchDocumentsService } from '../research-documents/research-documents.service';
import { CurrentResearchService } from '../experience/current-research.service';
import { DailyChannelResearchService } from '../experience/daily-channel-research.service';
import { UserInvestmentStrategyService } from '../paper-trading/user-investment-strategy.service';
import { ChannelService } from '../channel/channel.service';
import { councilSessions } from '../../database/council.schema';
import { holdings } from '../../database/schema';
import { channelMemories } from '../../database/channel.schema';
import type { CouncilMember, DailyReverseCheck } from '../../../shared/council.interface';
import { businessDate } from '../experience/simple-experience.rules';

const url = process.env.COUNCIL_TEST_DATABASE_URL;
test('daily research executes a sealed independent barrier and mandatory reverse gate before Today publication', { skip: !url }, async t => {
  const namespace = `daily_channel_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  const client = postgres(url!, { max: 6, onnotice: () => {}, connection: { search_path: namespace } });
  await admin`CREATE SCHEMA ${admin(namespace)}`;
  try {
    for (const file of readdirSync('scripts/db').filter(name => /^\d\d_.*\.sql$/u.test(name) && !name.startsWith('02_')).sort()) {
      await client.unsafe(readFileSync(`scripts/db/${file}`, 'utf8'));
    }
    const db = drizzle(client), documents = new ResearchDocumentsService(db);
    const day=businessDate(new Date(),'Asia/Shanghai');
    const channel = new ChannelService(db, {} as never); await channel.onModuleInit();
    const strategies = new UserInvestmentStrategyService(db, documents, {} as never);
    const synchronizer = new DailyChannelResearchService({} as never, db, channel, strategies);
    const today = new CurrentResearchService(db, documents, {} as never, {} as never);
    const team: CouncilMember[] = dailyResearchMembers([
      { id: 'financials', name: 'Financials', role: 'researcher', model: 'fast', instructions: '', connectionId: randomUUID() },
      { id: 'falsifier', name: 'Falsifier', role: 'challenger', model: 'fast', instructions: '', connectionId: randomUUID() },
      { id: 'summary', name: 'Summary', role: 'manager', model: 'fast', instructions: '', connectionId: randomUUID() },
    ]);

    async function execute(options: { missingReverse?: boolean; lostMember?: boolean; outcome?: DailyReverseCheck['outcome'] } = {}) {
      const owner = randomUUID();
      await client`INSERT INTO users (id,username,password_hash) VALUES (${owner},${`daily-${owner.slice(0, 12)}`},'fixture-only')`;
      const prompts: Array<{ system: string; input: Record<string, unknown> }> = [];
      const outcome = options.outcome ?? 'no_counterevidence_found';
      const llm = { validateConnectionIds: async () => {}, isConfigured: async () => true,
        chatFastJSON: async (messages: Array<{ content: string }>) => {
          const input = JSON.parse(messages[1].content); prompts.push({ system: messages[0].content, input });
          if (options.lostMember && input.phase === 'opening' && input.member.name === 'Financials') {
            return { data: { evidenceIds: [] }, tokens: 1 };
          }
          const marker = input.phase === 'opening' ? `SEALED_${input.member.name}_ONLY` : input.phase === 'challenge' ? 'Reverse check finished.' :
            '# Daily report\n\nEvidence remains limited.\n\n## DAILY STRATEGY DRAFT\n\nObserve the current holdings; no new risk is authorized.';
          const check = { outcome, checked: ['Compare the original filing periods', 'Inspect whether cash conversion data exists'],
            findings: outcome === 'no_counterevidence_found' ? ['No contradiction established in the supplied material.'] : [],
            gaps: ['Customer-level cash conversion is unavailable.'], affectedPremises: ['Cash conversion supports earnings quality'], evidenceIds: [] };
          return { data: { response: { thesis: marker, evidencePoints: [], risks: ['Missing original customer-level data'], nextChecks: ['Review the next filing'] },
            evidenceIds: [], researchStance: 'balanced', ...(input.phase === 'challenge' && !options.missingReverse ? { reverseCheck: check } : {}) }, tokens: 1 };
        } };
      const council = new CouncilService(db, llm as never, { collectEvidence: async () => [] } as never,
        { getPortfolioContext: async () => ({ totalValue: 1000, cash: 100, holdings: [] }) } as never,
        { listRuns: async () => ({ items: [] }) } as never, undefined, undefined, undefined, undefined, documents);
      const session = await council.createSession(owner, { scene: 'portfolio_daily', subject: 'Fictional daily portfolio review', members: team, language: 'en' }, { independent: true });
      const [stored] = await db.select().from(councilSessions).where(eq(councilSessions.id, session.id));
      await db.update(councilSessions).set({ checkpoint: { ...stored.checkpoint!, simple: { ...stored.checkpoint!.simple!, researchOnly: true, contextDate: day } } }).where(eq(councilSessions.id, session.id));
      await council.runSession(owner, session.id);
      let result = await council.getSession(owner, session.id);
      for (let i = 0; i < 500 && result.status === 'running'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10)); result = await council.getSession(owner, session.id);
      }
      return { owner, session: result, prompts };
    }

    await t.test('unanimity still invokes the reverse gate; the summary receives its structured result', async () => {
      const { owner, session, prompts } = await execute();
      assert.equal(session.status, 'completed', JSON.stringify(session.error));
      assert.equal(prompts.filter(p => p.input.phase === 'opening').length, 3);
      assert.equal(prompts.filter(p => p.input.phase === 'challenge').length, 1);
      assert.equal(prompts.filter(p => p.input.phase === 'summary').length, 1);
      for (const prompt of prompts.filter(p => p.input.phase === 'opening')) {
        assert.equal(JSON.stringify(prompt.input).includes('SEALED_'), false, 'an independent prompt cannot contain a sibling conclusion');
      }
      const summary = prompts.find(p => p.input.phase === 'summary')!;
      const check = session.reports.at(-1)?.coverage?.reverseCheck;
      assert.equal(check?.outcome, 'no_counterevidence_found');
      assert.ok(summary.system.includes(JSON.stringify(check)), 'summary must receive the complete structured reverse-check result, including checked paths and gaps');
      const submissions = await client`SELECT * FROM council_independent_submissions WHERE owner=${owner}`;
      assert.equal(submissions.length, 3); assert.ok(submissions.every(s => s.released_at));
      await assert.rejects(client`UPDATE council_independent_submissions SET contribution='{}' WHERE owner=${owner}`, /immutable/u);
      const report = session.reports.at(-1)!;
      assert.equal(report.coverage?.reverseCheck?.outcome, 'no_counterevidence_found');
      assert.match(report.summary, /does not establish correctness/i);
      const selection = await today.getDailyReports(owner, day);
      assert.equal(selection.initial?.source?.type, 'council');
      assert.equal(selection.initial?.sessionId, session.id);
      assert.equal(selection.latestDiscussion, null, 'private daily research is not a public discussion result');
      assert.match(selection.initial?.content ?? '', /DAILY STRATEGY DRAFT/u);
      assert.equal((await today.getDailyReports(randomUUID(), day)).initial, null);
      await synchronizer.syncPublished(); await synchronizer.syncPublished();
      const [drafts] = await client`SELECT count(*)::int AS count FROM user_investment_strategies WHERE owner=${owner}`;
      assert.equal(drafts.count, 0, 'legacy report prose without a typed execution plan cannot create an automatic strategy draft');
      const [findings] = await client`SELECT count(*)::int AS count FROM channel_findings WHERE owner=${owner}`;
      assert.equal(findings.count, 0, 'no_counterevidence_found never creates a channel finding');
      const preference='我只看一周内会变化的证据。';
      await db.insert(channelMemories).values({id:'explicit-preference',owner,data:{id:'explicit-preference',ownerId:owner,kind:'user_stated_preference',recordedAt:new Date(Date.now()-86400000).toISOString(),exactUserQuote:preference,content:preference},createdAt:new Date(Date.now()-86400000)});
      for(let n=0;n<25;n++)await db.insert(channelMemories).values({id:`new-history-${n}`,owner,data:{id:`new-history-${n}`,ownerId:owner,kind:'shared_history',recordedAt:new Date().toISOString(),content:'Fictional completed history event'}});
      let inputMessage='';
      const remembering=new DailyChannelResearchService({create:async(_owner:string,input:{message:string})=>{inputMessage=input.message;return{id:session.id};}} as never,db,channel,strategies);
      await remembering.create(owner,day,'remember-explicit-preference');
      assert.ok(inputMessage.includes(preference),'recent shared history must not evict explicit user preferences before the SQL limit');
      assert.equal(inputMessage.includes('Fictional completed history event'),false);
    });

    await t.test('a missing reverse-check artifact prevents successful daily publication', async () => {
      const { owner, session } = await execute({ missingReverse: true });
      assert.notEqual(session.status, 'completed');
      assert.equal(session.reports.filter(report => report.publicationOutcome === 'succeeded').length, 0);
      assert.equal((await today.getDailyReports(owner, day)).initial, null);
      await client`UPDATE council_sessions SET status='paused',error='LOCAL_LOGIN_REQUIRED' WHERE owner=${owner} AND id=${session.id}`;
      await client`INSERT INTO research_current_views(owner,topic_key,date_key,state,task_kind,task_id) VALUES (${owner},'portfolio',${day},'generating','daily_research',${session.id})`;
      await today.reconcile();
      const failed=await today.get(owner,'portfolio',day);
      assert.equal(failed.state,'failed','a paused daily gate cannot leave Today generating forever');
      assert.ok(failed.error);assert.equal(failed.taskId,session.id,'the original recoverable research is retained');
    });

    await t.test('a missing independent member is never labelled complete', async () => {
      const { session } = await execute({ lostMember: true, outcome: 'unable_to_verify' });
      assert.equal(session.status, 'completed');
      assert.equal(session.reports.at(-1)?.coverage?.complete, false);
      assert.equal(session.reports.at(-1)?.coverage?.reverseCheck?.outcome, 'unable_to_verify');
    });

    await t.test('historical daily reports remain readable without fresh findings, proposals or cross-owner exposure', async () => {
      const { owner, session } = await execute({ outcome: 'unable_to_verify' });
      await client`UPDATE council_reports SET created_at=now()-interval '2 days' WHERE owner=${owner}`;
      const [holding] = await db.insert(holdings).values({ owner, ticker: 'FICT', shares: '7', buyPrice: '12', currentPrice: '13' }).returning();
      const before = await client`SELECT summary,coverage,evidence FROM council_reports WHERE owner=${owner}`;
      await synchronizer.syncPublished(); await synchronizer.syncPublished();
      const [findings] = await client`SELECT count(*)::int AS count FROM channel_findings WHERE owner=${owner}`;
      const [drafts] = await client`SELECT count(*)::int AS count FROM user_investment_strategies WHERE owner=${owner}`;
      assert.equal(findings.count, 0, 'an old inability-to-verify record is not a fresh channel finding');
      assert.equal(drafts.count, 0, 'an old daily report does not silently create a new current strategy proposal');
      const [archives] = await client`SELECT count(*)::int AS count FROM channel_reports WHERE owner=${owner}`;
      assert.equal(archives.count, 1, 'the historical report remains available');
      assert.deepEqual(await client`SELECT summary,coverage,evidence FROM council_reports WHERE owner=${owner}`, before);
      const [after] = await db.select().from(holdings).where(eq(holdings.id, holding.id));
      assert.equal(after.shares, '7'); assert.equal(after.buyPrice, '12');
      const stranger = randomUUID(), projection = await channel.projection(stranger);
      assert.equal(projection.report, null); assert.deepEqual(projection.episodes, []);
      assert.equal((await today.getDailyReports(stranger, day)).history.length, 0);
      assert.equal((await client`SELECT id FROM council_sessions WHERE owner=${owner} AND id=${session.id}`).length, 1);
    });
  } finally {
    await client.end(); await admin`DROP SCHEMA IF EXISTS ${admin(namespace)} CASCADE`; await admin.end();
  }
});
