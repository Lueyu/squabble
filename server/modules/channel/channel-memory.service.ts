import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import * as tables from '../../database/channel.schema';
import { councilMessages } from '../../database/council.schema';
import { readChannelRuntime } from './channel-runtime';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import type { DecisionReflection, RelationshipMemoryEvent } from '../../../shared/channel.interface';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
@Injectable()
export class ChannelMemoryService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}
  async list(owner: string) {
    const [rows, reflections, snapshots] = await Promise.all([
      this.db.select().from(tables.channelMemories).where(eq(tables.channelMemories.owner, owner)).orderBy(desc(tables.channelMemories.createdAt)).limit(100),
      this.db.select().from(tables.channelDecisionReflections).where(eq(tables.channelDecisionReflections.owner, owner)).orderBy(desc(tables.channelDecisionReflections.createdAt)).limit(100),
      this.db.select().from(tables.channelDecisionReflections).where(and(eq(tables.channelDecisionReflections.owner, owner), sql`${tables.channelDecisionReflections.data}->>'author' = 'system_snapshot'`)).orderBy(desc(tables.channelDecisionReflections.createdAt)).limit(100),
    ]);
    const decisions = [...new Map(snapshots.map(r => [r.decisionId, { id: r.decisionId, label: '模拟策略决策记录', createdAt: r.data.recordedAt }])).values()];
    return { items: rows.map(r => r.data), decisions, reflections: reflections.map(r => r.data) };
  }
  async reflections(owner: string, decisionId?: string) {
    const rows = await this.db.select().from(tables.channelDecisionReflections).where(and(eq(tables.channelDecisionReflections.owner, owner), decisionId ? eq(tables.channelDecisionReflections.decisionId, decisionId) : undefined)).orderBy(desc(tables.channelDecisionReflections.createdAt)).limit(100);
    return { items: rows.map(r => r.data) };
  }
  async preference(owner: string, body: unknown) {
    const input = z.object({ text: z.string().trim().min(1).max(4000).optional(), requestKey: z.string().min(1).max(150), sourceMessageId: z.string().uuid().optional() }).strict().refine(p => Boolean(p.text || p.sourceMessageId)).safeParse(body);
    if (!input.success) throw new BadRequestException('INVALID_EXPLICIT_PREFERENCE');
    const p = input.data, id = hash([owner, 'preference', p.requestKey]);
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      let sourceId = p.sourceMessageId;
      let explicitText = p.text;
      if (sourceId) {
        const [question] = await tx.select().from(tables.channelSupplementRequests).where(eq(tables.channelSupplementRequests.owner, owner)).then(rows => rows.filter(r => r.data.userMessageId === sourceId));
        const message = question?.message ?? (await tx.select().from(councilMessages).where(and(eq(councilMessages.owner, owner), eq(councilMessages.id, sourceId), eq(councilMessages.role, 'user'))))[0]?.content;
        if (!message || explicitText && !message.includes(explicitText)) throw new BadRequestException('PREFERENCE_NOT_IN_USER_MESSAGE');
        explicitText ??= message;
      } else {
        sourceId = randomUUID();
        await tx.insert(tables.channelUserActions).values({ id: sourceId, owner, requestKey: `preference:${p.requestKey}`, inputHash: hash(p.text), data: { kind: 'user_preference_input', text: p.text }, result: { recorded: true } }).onConflictDoNothing();
      }
      if (!explicitText) throw new BadRequestException('EMPTY_USER_PREFERENCE');
      const [prior] = await tx.select().from(tables.channelMemories).where(and(eq(tables.channelMemories.owner, owner), eq(tables.channelMemories.id, id)));
      if (prior) { if (prior.data.exactUserQuote !== explicitText || p.sourceMessageId && prior.data.sourceMessageId !== p.sourceMessageId) throw new ConflictException('REQUEST_KEY_CONFLICT'); return prior.data; }
      const memory: RelationshipMemoryEvent = { id, ownerId: owner, kind: 'user_stated_preference', recordedAt: new Date().toISOString(), sourceMessageId: sourceId, exactUserQuote: explicitText, content: explicitText };
      await tx.insert(tables.channelMemories).values({ id, owner, data: memory }); return memory;
    });
  }
  /** Called only after an actual authorized decision, never from model-generated prose. */
  async recordDecisionSnapshot(owner: string, decisionId: string) {
    const [runtime, reports, facts] = await Promise.all([
      readChannelRuntime(this.db, owner), this.db.select().from(tables.channelReports).where(eq(tables.channelReports.owner, owner)).orderBy(desc(tables.channelReports.createdAt)).limit(1),
      this.db.select().from(tables.channelFacts).where(eq(tables.channelFacts.owner, owner)),
    ]);
    const at = new Date().toISOString();
    const records: DecisionReflection[] = [
      { id: hash([owner, decisionId, 'system_snapshot']), decisionId, recordedAt: at, kind: 'reason_at_adoption', author: 'system_snapshot', snapshot: {
        strategyId: runtime.current.strategyId, strategyRevision: runtime.current.strategyRevision, runtimeRevision: runtime.revision,
        reportRefs: reports.map(r => ({ id: r.id, revision: r.revision })), evidenceIds: facts.map(f => f.id), knownGapIds: facts.filter(f => f.card.kind === 'gap').map(f => f.card.id),
      } },
      { id: hash([owner, decisionId, 'unrecorded']), decisionId, recordedAt: at, kind: 'reason_at_adoption', author: 'unrecorded' },
    ];
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      for (const record of records) await tx.insert(tables.channelDecisionReflections).values({ id: record.id, owner, decisionId, data: record }).onConflictDoNothing();
      const episodes = await tx.select().from(tables.channelEpisodes).where(eq(tables.channelEpisodes.owner, owner));
      for (const e of episodes.filter(e => e.data.phase !== 'closed' && !e.data.userDecisionIds.includes(decisionId))) await tx.update(tables.channelEpisodes).set({ data: { ...e.data, revision: e.data.revision + 1, userDecisionIds: [...e.data.userDecisionIds, decisionId] }, updatedAt: new Date() }).where(and(eq(tables.channelEpisodes.owner, owner), eq(tables.channelEpisodes.id, e.id)));
    });
    return records;
  }
  async userReflection(owner: string, body: unknown) {
    const parsed = z.object({ decisionId: z.string().min(1), kind: z.enum(['reason_at_adoption', 'later_reflection']), text: z.string().trim().min(1).max(4000), requestKey: z.string().min(1).max(150), userMessageId: z.string().optional() }).strict().safeParse(body);
    if (!parsed.success) throw new BadRequestException('INVALID_USER_REFLECTION');
    const p = parsed.data;
    const [decision] = await this.db.select().from(tables.channelDecisionReflections).where(and(eq(tables.channelDecisionReflections.owner, owner), eq(tables.channelDecisionReflections.decisionId, p.decisionId))).limit(1);
    if (!decision) throw new NotFoundException('DECISION_UNAVAILABLE');
    if (p.userMessageId) {
      const questions = await this.db.select().from(tables.channelSupplementRequests).where(eq(tables.channelSupplementRequests.owner, owner));
      if (!questions.some(q => q.data.userMessageId === p.userMessageId && q.message.includes(p.text))) throw new BadRequestException('REFLECTION_NOT_IN_USER_MESSAGE');
    }
    const id = hash([owner, 'reflection', p.requestKey]), inputId = hash([id, 'input']);
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [prior] = await tx.select().from(tables.channelDecisionReflections).where(and(eq(tables.channelDecisionReflections.owner, owner), eq(tables.channelDecisionReflections.id, id)));
      if (prior) { if (prior.data.author !== 'user' || prior.data.text !== p.text || prior.data.decisionId !== p.decisionId || prior.data.kind !== p.kind) throw new ConflictException('REQUEST_KEY_CONFLICT'); return prior.data; }
      await tx.insert(tables.channelUserActions).values({ id: inputId, owner, requestKey: `reflection:${p.requestKey}`, inputHash: hash(p), data: { kind: 'user_reflection_input', text: p.text }, result: { recorded: true } });
      const reflection: DecisionReflection = { id, decisionId: p.decisionId, recordedAt: new Date().toISOString(), kind: p.kind, author: 'user', userMessageId: p.userMessageId, userInputRecordId: inputId, text: p.text };
      await tx.insert(tables.channelDecisionReflections).values({ id, owner, decisionId: p.decisionId, data: reflection }); return reflection;
    });
  }
}
