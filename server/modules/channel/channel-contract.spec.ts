import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackgroundFinding, ChannelBubble, ChannelEvent } from '../../../shared/channel.interface';
import { TemplateRegistry } from './template-registry';
import { builtinChannelTemplates } from './channel-templates';
import { canPublish, sealFinding, renderApprovedFinding, publicationKey, assertSemanticDelta, type ChannelPublicationContext } from './channel-contract';
import { validateMoodLine } from './channel-mood-validation';
import { renderRegisteredTemplate, resolveAuthoritativeSlots } from './channel-slots';

const at = '2026-11-06T04:00:00.000Z';
function fixture() {
  const registry = new TemplateRegistry(builtinChannelTemplates('zh-CN'));
  const event: ChannelEvent = { id: 'event', ownerId: 'owner', entityId: 'ABC', episodeId: 'episode', sequence: 2,
    occurredAt: at, observedAt: at, kind: 'research.finding', factRefs: [{ id: 'fact', revision: 1 }], semanticDeltaId: 'delta' };
  const ctx: ChannelPublicationContext = { registry, ownerId: 'owner', now: at, compilerVersion: '1', event,
    facts: [{ id: 'fact', ownerId: 'owner', revision: 1, key: 'process.waitMinutes', value: 12, observedAt: at, subject: 'research_process' }],
    reportRefs: [], priorBubbles: [], memories: [], consumedDeltaIds: [],
    episode: { id: 'episode', revision: 1, entityId: 'ABC', phase: 'idle', severity: 'ordinary', lastEventSequence: 1,
      consumedDeltaIds: [], hadBreach: false, executionIds: [], userDecisionIds: [] }, hasNewMaterialGap: () => true };
  const finding: Omit<BackgroundFinding, 'review'> = { id: 'finding', ownerId: 'owner', episodeId: 'episode', researchRunId: 'run',
    createdAt: at, kind: 'verified_discrepancy', anchor: { kind: 'fact', factId: 'fact', factRevision: 1 },
    affectedPremiseIds: ['premise'], evidenceCardId: 'card', semanticDeltaId: 'delta',
    template: { templateId: 'channel.finding.discrepancy', templateRevision: 1 }, slots: {}, weight: 'nudge' };
  ctx.evidenceCards = [{ id: 'card', kind: 'evidence', summary: '原文与摘要统计期间不同。', sources: [{ id: 'source', kind: 'filing',
    title: 'Fictional filing', uri: 'https://example.test/filing', publishedAt: at, observedAt: at, verification: 'checked' }],
    asOf: at, gaps: [], supports: [{ factId: 'fact', scope: '期间口径' }] }];
  return { ctx, finding, registry };
}
function bubbleFor(ctx: ChannelPublicationContext, id: string, override: Partial<ChannelBubble> = {}): ChannelBubble {
  const template = ctx.registry.resolveTemplate({ templateId: id, templateRevision: 1 }, 'bubble', 'publish');
  const anchors = { primary: { kind: 'fact' as const, factId: 'fact', factRevision: 1 }, triggerEventId: ctx.event.id };
  const slots = resolveAuthoritativeSlots(template, anchors, ctx);
  return { id: 'bubble', ownerId: ctx.ownerId, speaker: template.speaker ?? 'xiaoqi', episodeId: ctx.episode.id,
    posture: 'standalone', anchors, text: renderRegisteredTemplate(template, slots), evidence: ctx.evidenceCards![0],
    templateId: template.id, templateRevision: template.revision, semanticDeltaId: ctx.event.semanticDeltaId,
    createdAt: ctx.now, deliveryCause: 'monitor', stance: template.allowedStances[0], weight: template.allowedWeights[0],
    layer: template.allowedWeights[0] === 'tap' ? 2 : 3, ...override } as ChannelBubble;
}

test('ordinary mood with an empty or null relationship memory attachment passes', () => {
  const { ctx } = fixture(); ctx.event.kind = 'catalyst.countdown';
  for (const memories of [undefined, null, []]) {
    const result = validateMoodLine('电话会还有 12 分钟，先等它开场。', {
      templateId: 'channel.process.countdown', templateRevision: 1, stance: 'mood', weight: 'tap', layer: 2,
      anchors: { primary: { kind: 'fact', factId: 'fact', factRevision: 1 }, triggerEventId: 'event', relationshipMemoryIds: memories },
      slots: { minutes: 12 },
    }, ctx);
    assert.equal(result.allowed, true, result.reason);
  }
});
test('resealing after compiler upgrade preserves publication key and outbox identity', async () => {
  const { ctx, finding } = fixture(); const first = await sealFinding(finding, ctx);
  assert.equal(first.finding.review.state, 'approved');
  const bubble = renderApprovedFinding(first.finding, { ...ctx, seal: first.seal, sealedFinding: first.finding });
  const upgraded = await sealFinding(finding, { ...ctx, compilerVersion: '2' });
  const second = renderApprovedFinding(upgraded.finding, { ...ctx, compilerVersion: '2', seal: upgraded.seal, sealedFinding: upgraded.finding });
  assert.equal(publicationKey(bubble), publicationKey(second));
  assert.equal(new Set([`${publicationKey(bubble)}:stream`, `${publicationKey(second)}:stream`]).size, 1);
  assert.notEqual(first.seal?.compilerVersion, upgraded.seal?.compilerVersion);
});
test('retirement after compilation blocks Brief and background publication', async () => {
  const { ctx, finding, registry } = fixture(); const sealed = await sealFinding(finding, ctx);
  const c = { ...ctx, seal: sealed.seal, sealedFinding: sealed.finding }; const bubble = renderApprovedFinding(sealed.finding, c);
  assert.equal(canPublish(bubble, c).allowed, true);
  assert.equal(canPublish({ ...bubble, deliveryCause: 'monitor' }, c).allowed, true);
  registry.retire(finding.template, at);
  assert.equal(canPublish(bubble, c).allowed, false);
  assert.equal(canPublish({ ...bubble, deliveryCause: 'monitor' }, c).allowed, false);
});
test('no counterevidence never creates an approved finding', async () => {
  const { ctx, finding } = fixture();
  assert.equal((await sealFinding({ ...finding, reverseCheckOutcome: 'no_counterevidence_found' }, ctx)).finding.review.state, 'rejected');
});
test('unable-to-verify needs material-gap kind and a newly established gap', async () => {
  const { ctx, finding } = fixture();
  assert.equal((await sealFinding({ ...finding, reverseCheckOutcome: 'unable_to_verify' }, ctx)).finding.review.state, 'rejected');
  assert.equal((await sealFinding({ ...finding, kind: 'material_gap', reverseCheckOutcome: 'unable_to_verify' },
    { ...ctx, hasNewMaterialGap: () => false })).finding.review.state, 'rejected');
  assert.equal((await sealFinding({ ...finding, kind: 'material_gap', reverseCheckOutcome: 'unable_to_verify' }, ctx)).finding.review.state, 'approved');
});
test('compiler awaits asynchronous contract dependencies before sealing', async () => {
  const { ctx, finding } = fixture(); let resolved = false;
  const result = await sealFinding(finding, { ...ctx, compilePublicationContract: async () => {
    await Promise.resolve(); resolved = true; return { allowed: false, reason: 'MISSING_SOURCE' };
  } });
  assert.equal(resolved, true); assert.equal(result.finding.review.state, 'rejected');
});
test('finding, event and bubble must have identical semantic deltas', async () => {
  const { ctx, finding } = fixture(); const sealed = await sealFinding(finding, ctx);
  const bubble = renderApprovedFinding(sealed.finding, { ...ctx, seal: sealed.seal, sealedFinding: sealed.finding });
  assert.doesNotThrow(() => assertSemanticDelta(sealed.finding, ctx.event, bubble));
  assert.throws(() => assertSemanticDelta(sealed.finding, ctx.event, { ...bubble, semanticDeltaId: 'other' }));
});
test('source correction invalidates a previously granted seal', async () => {
  const { ctx, finding } = fixture(); const sealed = await sealFinding(finding, ctx);
  const c = { ...ctx, seal: sealed.seal, sealedFinding: sealed.finding }; const bubble = renderApprovedFinding(sealed.finding, c);
  ctx.facts[0].correctedBy = 'new-fact'; assert.equal(canPublish(bubble, c).allowed, false);
});
test('background findings cannot use tap or claim a completed action', async () => {
  const { ctx, finding } = fixture(); const sealed = await sealFinding(finding, ctx);
  const c = { ...ctx, seal: sealed.seal, sealedFinding: sealed.finding }; const bubble = renderApprovedFinding(sealed.finding, c);
  assert.equal(canPublish({ ...bubble, weight: 'tap' } as ChannelBubble, c).allowed, false);
  assert.equal(canPublish({ ...bubble, stance: 'quiet_win' } as ChannelBubble, c).allowed, false);
});
test('registry retains retired versions and rejects mutation of versioned content', () => {
  const { registry } = fixture(); const ref = { templateId: 'channel.finding.discrepancy', templateRevision: 1 };
  const original = registry.resolveTemplate(ref, 'bubble', 'history'); registry.retire(ref, at);
  assert.equal(registry.resolveTemplate(ref, 'bubble', 'history').body, original.body);
  assert.throws(() => registry.resolveTemplate(ref, 'bubble', 'publish'));
  assert.throws(() => registry.register({ ...original, body: 'different', status: 'active' }));
});
test('mood registry refuses advice flags and market-price placeholders', () => {
  const { registry } = fixture();
  const old = registry.resolveTemplate({ templateId: 'channel.process.countdown', templateRevision: 1 }, 'bubble', 'history');
  assert.throws(() => registry.register({ ...old, id: 'bad1', impliesInvestmentAdvice: true, contentHash: '' }));
  assert.throws(() => registry.register({ ...old, id: 'bad2', slotSchema: [{ name: 'minutes', source: { kind: 'fact', factKey: 'price' }, format: 'decimal' }], contentHash: '' }));
});

test('mood cannot attach relationship history or mutate an approved sentence', () => {
  const { ctx } = fixture(); ctx.event.kind = 'catalyst.countdown';
  const bubble = bubbleFor(ctx, 'channel.process.countdown');
  assert.equal(canPublish(bubble, ctx).allowed, true);
  assert.equal(canPublish({ ...bubble, anchors: { ...bubble.anchors, relationshipMemoryIds: ['memory'] } }, ctx).allowed, false);
  assert.equal(canPublish({ ...bubble, text: '我也觉得该跑了' }, ctx).allowed, false);
});

test('quiet-win requires a confirmed complete action, not a partial fill or hopeful condition', () => {
  const { ctx } = fixture(); ctx.event.kind = 'paper.execution_changed'; ctx.facts[0].key = 'execution.filledQuantity'; ctx.facts[0].value = 2;
  const bubble = bubbleFor(ctx, 'channel.paper.filled');
  assert.equal(canPublish(bubble, ctx).allowed, false);
  ctx.completedActions = [{ eventId: 'event', kind: 'paper_order_filled', status: 'completed' }];
  assert.equal(canPublish(bubble, ctx).allowed, true);
  ctx.facts[0].value = 0;
  assert.equal(canPublish(bubbleFor(ctx, 'channel.paper.filled'), ctx).allowed, false);
});

test('a user decision forces the factual close branch and forbids claiming a quiet win', () => {
  const { ctx } = fixture(); ctx.event.kind = 'monitor.recovered'; ctx.episode.phase = 'accompany'; ctx.episode.userDecisionIds = ['decision'];
  ctx.completedActions = [{ eventId: 'event', kind: 'monitor_episode_closed', status: 'completed' }];
  assert.equal(canPublish(bubbleFor(ctx, 'channel.monitor.recovered', { posture: 'close' }), ctx).allowed, false);
  assert.equal(canPublish(bubbleFor(ctx, 'channel.monitor.recovered_after_user', { posture: 'close' }), ctx).allowed, true);
});

test('a breach episode cannot be closed as an untriggered false alarm', () => {
  const { ctx } = fixture(); ctx.event.kind = 'monitor.recovered'; ctx.episode.hadBreach = true;
  ctx.completedActions = [{ eventId: 'event', kind: 'monitor_episode_closed', status: 'completed' }];
  assert.equal(canPublish(bubbleFor(ctx, 'channel.monitor.recovered', { posture: 'close' }), ctx).allowed, false);
});

test('watchful cannot be used to frame a confirmed breach as a casual near miss', () => {
  const { ctx } = fixture(); ctx.event.kind = 'monitor.near'; ctx.facts[0].key = 'monitor.distance'; ctx.facts[0].value = 1;
  const bubble = bubbleFor(ctx, 'channel.monitor.near');
  assert.equal(canPublish(bubble, ctx).allowed, true);
  ctx.event.kind = 'monitor.breached';
  assert.equal(canPublish(bubble, ctx).allowed, false);
});

test('a new event id or reworded template does not make the same anchored meaning new', () => {
  const { ctx } = fixture(); const bubble = bubbleFor(ctx, 'channel.finding.discrepancy');
  ctx.priorBubbles = [{ ...bubble, id: 'old', semanticDeltaId: 'old-delta' }];
  assert.equal(canPublish(bubble, ctx).allowed, false);
  assert.equal(canPublish({ ...bubble, deliveryCause: 'user_reply' }, { ...ctx, directReply: true }).allowed, true);
});

test('same delta is consumed regardless of speaker or channel path', () => {
  const { ctx } = fixture(); const bubble = bubbleFor(ctx, 'channel.finding.discrepancy'); ctx.consumedDeltaIds = ['delta'];
  assert.equal(canPublish(bubble, ctx).allowed, false);
});

test('finding route cannot be relabelled to bypass its compiler seal', () => {
  const { ctx } = fixture(); const bubble = bubbleFor(ctx, 'channel.finding.discrepancy'); ctx.event.findingId = 'finding';
  assert.equal(canPublish(bubble, ctx).allowed, false);
});

test('scope acknowledgement binds integer indexes to the frozen original question count', () => {
  const { ctx } = fixture(); ctx.event.kind = 'user.question';
  ctx.facts[0].key = 'supplement.scope.selectedIndex'; ctx.facts[0].value = 2;
  ctx.facts.push({ ...ctx.facts[0], id: 'count', key: 'supplement.scope.deferredCount', value: 1 },
    { ...ctx.facts[0], id: 'frozen', key: 'supplement.scope.originalQuestionCount', value: 3 });
  ctx.event.factRefs = ctx.facts.map(fact => ({ id: fact.id, revision: fact.revision }));
  assert.equal(canPublish(bubbleFor(ctx, 'channel.supplement.scope'), ctx).allowed, true);
  ctx.facts.find(fact => fact.id === 'count')!.value = 0;
  assert.equal(canPublish(bubbleFor(ctx, 'channel.supplement.scope'), ctx).allowed, false);
  ctx.facts.find(fact => fact.id === 'count')!.value = 1;
  ctx.facts[0].value = 4;
  assert.equal(canPublish(bubbleFor(ctx, 'channel.supplement.scope'), ctx).allowed, false);
});

test('pending human authority applies only to grantable authority, never invalid evidence', async () => {
  const { ctx, finding } = fixture();
  assert.equal((await sealFinding(finding, { ...ctx, grantableAuthorityMissing: () => true })).finding.review.state, 'pending');
  assert.equal((await sealFinding({ ...finding, ownerId: 'other' }, { ...ctx, grantableAuthorityMissing: () => true })).finding.review.state, 'rejected');
});
