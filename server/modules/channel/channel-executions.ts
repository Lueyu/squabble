import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from '../../common/platform';
import { channelEpisodes, channelEvents } from '../../database/channel.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { readChannelRuntime } from './channel-runtime';
import type { ChannelService } from './channel.service';
import { channelHash } from './channel-hash';
import type { ChannelEpisode, ChannelEvidenceCard, ChannelFact } from '../../../shared/channel.interface';

/** Fill receipts are observed from the ledger; this producer never creates orders. */
export async function syncChannelExecutions(db: PostgresJsDatabase, channel: ChannelService, owner: string) {
  const runtime = await readChannelRuntime(db, owner);
  for (const execution of runtime.executions.filter(e => Number(e.filledQuantity) > 0)) {
    const episodeId = `execution:${execution.id}`, delta = channelHash([execution.id, execution.status, execution.filledQuantity, execution.remainingQuantity]);
    const facts: ChannelFact[] = [
      { id: `${delta}:filled`, revision: 1, ownerId: owner, key: 'execution.filledQuantity', value: execution.filledQuantity, observedAt: execution.updatedAt, subject: 'runtime_status' },
      { id: `${delta}:remaining`, revision: 1, ownerId: owner, key: 'execution.remainingQuantity', value: execution.remainingQuantity, observedAt: execution.updatedAt, subject: 'runtime_status' },
    ];
    const card: ChannelEvidenceCard = { id: `card:${delta}`, kind: 'evidence', summary: `${execution.symbol} 模拟盘已成交 ${execution.filledQuantity} 股，未成交 ${execution.remainingQuantity} 股`,
      sources: [{ id: execution.id, kind: 'ledger', title: `${execution.symbol} 模拟订单与成交回执`, uri: `/ai-investment?orderId=${encodeURIComponent(execution.id)}`, publishedAt: execution.updatedAt, observedAt: runtime.confirmedAt, verification: 'checked' }],
      asOf: execution.updatedAt, gaps: execution.strategyRevision === 0 ? ['历史订单的策略来源未确认；没有借用当前策略版本。'] : [], supports: facts.map(f => ({ factId: f.id, scope: '该模拟订单的实际累计成交与剩余数量' })) };
    if (execution.status === 'partially_filled') {
      await channel.publishTemplate(owner, { episodeId, entityId: execution.id, title: `${execution.symbol} · 模拟成交`, eventKind: 'paper.execution_changed', semanticDeltaId: delta,
        facts: facts.map(fact => ({ fact, card })), templateId: 'channel.paper.partial', stance: 'plain_fact', weight: 'nudge', layer: 3, posture: 'standalone', evidence: card });
      continue;
    }
    // quiet_win is silent by default: a completed fill updates the board and audit log without an unsolicited bubble.
    await db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [priorEvent] = await tx.select().from(channelEvents).where(and(eq(channelEvents.owner, owner), eq(channelEvents.id, `execution:${delta}`)));
      if (priorEvent) return;
      for (const fact of facts) await channel.ingestFact(owner, fact, card, tx);
      const [prior] = await tx.select().from(channelEpisodes).where(and(eq(channelEpisodes.owner, owner), eq(channelEpisodes.id, episodeId)));
      const episode: ChannelEpisode = prior?.data ?? { id: episodeId, revision: 1, entityId: execution.id, phase: 'idle', severity: 'ordinary', lastEventSequence: 0, consumedDeltaIds: [], hadBreach: false, executionIds: [], userDecisionIds: [] };
      await tx.insert(channelEpisodes).values({ id: episodeId, owner, title: `${execution.symbol} · 模拟成交`, data: episode }).onConflictDoNothing();
      const event = { id: `execution:${delta}`, ownerId: owner, episodeId, entityId: execution.id, sequence: episode.lastEventSequence + 1, occurredAt: execution.updatedAt, observedAt: runtime.confirmedAt, kind: 'paper.execution_changed' as const, factRefs: facts.map(f => ({ id: f.id, revision: f.revision })), runtimeRevision: runtime.revision, semanticDeltaId: delta };
      await tx.insert(channelEvents).values({ id: event.id, owner, episodeId, data: event }).onConflictDoNothing();
      await tx.update(channelEpisodes).set({ data: { ...episode, revision: episode.revision + 1, lastEventSequence: event.sequence, phase: execution.status === 'filled' || execution.status === 'cancelled' ? 'closed' : episode.phase, executionIds: [execution.id] }, updatedAt: new Date() }).where(and(eq(channelEpisodes.owner, owner), eq(channelEpisodes.id, episodeId)));
    });
  }
}
