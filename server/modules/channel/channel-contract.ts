import type { BackgroundFinding, ChannelAnchors, ChannelBubble, ChannelEpisode, ChannelEvent, ChannelEvidenceCard,
  ChannelVibe, FindingCandidate, FindingSeal, RelationshipMemoryEvent } from '../../../shared/channel.interface';
import { channelHash, canonical, graphemeCount } from './channel-hash';
import { TemplateRegistry } from './template-registry';
import { validateMoodLine } from './channel-mood-validation';
import { exactSlotValuesMatch, hasValidSupportingAnchor, renderRegisteredTemplate, resolveAuthoritativeSlots, type ChannelSourceContext } from './channel-slots';

export interface PublicationDecision { allowed: boolean; reason?: string }
export interface ChannelPublicationContext extends ChannelSourceContext {
  registry: TemplateRegistry; compilerVersion: string; episode: ChannelEpisode;
  priorBubbles: ChannelBubble[]; memories: RelationshipMemoryEvent[]; consumedDeltaIds: string[];
  evidenceCards?: ChannelEvidenceCard[];
  seal?: FindingSeal | null; sealedFinding?: BackgroundFinding;
  hasNewMaterialGap?: (finding: FindingCandidate) => boolean;
  grantableAuthorityMissing?: (finding: FindingCandidate) => boolean;
  compilePublicationContract?: (finding: FindingCandidate) => PublicationDecision | Promise<PublicationDecision>;
  completedActions?: Array<{ eventId: string; kind: 'paper_order_filled' | 'monitor_episode_closed' | 'research_day_closed'; status: 'completed' }>;
  vibe?: ChannelVibe; lastOrdinaryTapAt?: string; currentBurstCount?: number;
  /** Caller sets this only from a durable user question, never from model prose. */
  directReply?: boolean;
}
function deny(reason: string): PublicationDecision { return { allowed: false, reason }; }
export function publicationKey(bubble: Pick<ChannelBubble, 'ownerId' | 'episodeId' | 'semanticDeltaId'>): string {
  return channelHash([bubble.ownerId, bubble.episodeId, bubble.semanticDeltaId]);
}
export function semanticDeltaId(subjectId: string, change: unknown): string { return channelHash([subjectId, change]); }
function findingPayload(finding: FindingCandidate | BackgroundFinding): FindingCandidate {
  const { review: _review, ...payload } = finding as BackgroundFinding;
  return payload;
}
function findingAnchors(finding: FindingCandidate, ctx: ChannelPublicationContext): ChannelAnchors {
  return { primary: finding.anchor, triggerEventId: ctx.event.id, ...(finding.thesis ? { thesis: finding.thesis } : {}) };
}
function backgroundAllowed(finding: FindingCandidate, ctx: ChannelPublicationContext): PublicationDecision {
  if (finding.reverseCheckOutcome === 'no_counterevidence_found') return deny('NO_COUNTEREVIDENCE_IS_NOT_A_FINDING');
  if (finding.reverseCheckOutcome === 'unable_to_verify'
    && !(finding.kind === 'material_gap' && ctx.hasNewMaterialGap?.(finding) === true)) return deny('NO_NEW_MATERIAL_GAP');
  if (finding.weight !== 'nudge' && finding.weight !== 'poke') return deny('BACKGROUND_FINDING_CANNOT_BE_TAP');
  if (!finding.semanticDeltaId || finding.semanticDeltaId !== ctx.event.semanticDeltaId) return deny('SEMANTIC_DELTA_MISMATCH');
  if (finding.ownerId !== ctx.ownerId || finding.episodeId !== ctx.episode.id) return deny('OWNER_OR_EPISODE_MISMATCH');
  if (!finding.affectedPremiseIds.length) return deny('NO_AFFECTED_PREMISE');
  if (!hasValidSupportingAnchor(findingAnchors(finding, ctx), ctx)) return deny('MISSING_OR_STALE_ANCHOR');
  return { allowed: true };
}
export function findingDependencyDigest(finding: FindingCandidate, ctx: ChannelPublicationContext): string {
  const template = ctx.registry.resolveTemplate(finding.template, 'bubble', 'publish');
  const anchors = findingAnchors(finding, ctx);
  const bound = resolveAuthoritativeSlots(template, anchors, ctx);
  if (!exactSlotValuesMatch(finding.slots, bound)) throw new Error('Finding slot mismatch');
  const referenced = ctx.facts.filter(fact => ctx.event.factRefs.some(ref => ref.id === fact.id && ref.revision === fact.revision)
    || finding.anchor.kind === 'fact' && fact.id === finding.anchor.factId);
  if (referenced.some(fact => fact.correctedBy || ctx.correctedSourceIds?.includes(fact.sourceId ?? ''))) throw new Error('Source corrected');
  const card = ctx.evidenceCards?.find(item => item.id === finding.evidenceCardId);
  if (!card) throw new Error('Evidence card unavailable');
  if (card.sources.some(source => ctx.correctedSourceIds?.includes(source.id))) throw new Error('Card source corrected');
  // Both exact template identity and parsed slot schemas/bindings are part of the seal.
  return channelHash({ templateRef: finding.template, templateHash: template.contentHash,
    slotSchema: template.slotSchema, resolvedSlots: bound, facts: referenced,
    report: finding.anchor.kind === 'report_section' ? ctx.reportRefs.filter(report => finding.anchor.kind === 'report_section' && report.id === finding.anchor.reportId) : [],
    card, runtimeRevision: ctx.runtimeRevision });
}
export async function sealFinding(candidate: FindingCandidate, ctx: ChannelPublicationContext): Promise<{ finding: BackgroundFinding; seal: FindingSeal | null }> {
  const rejected = (reason: string, pending = false) => ({ finding: { ...candidate,
    review: { state: pending ? 'pending' as const : 'rejected' as const, reviewedAt: ctx.now, reviewerId: `publication-compiler:${ctx.compilerVersion}` } }, seal: null, reason });
  const initial = backgroundAllowed(candidate, ctx);
  if (!initial.allowed) return rejected(initial.reason!);
  // Only grantable authority fences can enter a human queue. Invalid sources never do.
  if (ctx.grantableAuthorityMissing?.(candidate)) return rejected('GRANTABLE_AUTHORITY_MISSING', true);
  try {
    const template = ctx.registry.resolveTemplate(candidate.template, 'bubble', 'publish');
    if (template.family === 'mood' || !template.allowedWeights.includes(candidate.weight)) return rejected('INVALID_FINDING_TEMPLATE');
    // Explicit await prevents an unresolved Promise from being interpreted as approval.
    const compiled: PublicationDecision = await (ctx.compilePublicationContract?.(candidate) ?? Promise.resolve({ allowed: true }));
    if (!compiled.allowed) return rejected(compiled.reason ?? 'PUBLICATION_CONTRACT_REJECTED', compiled.reason === 'GRANTABLE_AUTHORITY_MISSING');
    const dependencyDigest = findingDependencyDigest(candidate, ctx);
    const finding: BackgroundFinding = { ...candidate, review: { state: 'approved', reviewedAt: ctx.now, reviewerId: `publication-compiler:${ctx.compilerVersion}` } };
    const seal: FindingSeal = { findingId: finding.id, ownerId: finding.ownerId, compilerVersion: ctx.compilerVersion,
      payloadHash: channelHash(findingPayload(finding)), dependencyDigest, grantedAt: ctx.now, review: finding.review };
    return { finding, seal };
  } catch { return rejected('INVALID_TEMPLATE_OR_DEPENDENCY'); }
}
export function sealMatchesCurrentPayloadAndDependencies(finding: BackgroundFinding, seal: FindingSeal | null | undefined, ctx: ChannelPublicationContext): boolean {
  if (!seal || finding.review.state !== 'approved' || seal.review.state !== 'approved' || seal.findingId !== finding.id
    || seal.ownerId !== ctx.ownerId || seal.compilerVersion !== ctx.compilerVersion
    || seal.payloadHash !== channelHash(findingPayload(finding))) return false;
  try {
    // resolveTemplate requires active status; corrected source revisions also change/reject this digest.
    return seal.dependencyDigest === findingDependencyDigest(finding, ctx);
  } catch { return false; }
}
export function renderApprovedFinding(finding: BackgroundFinding, ctx: ChannelPublicationContext): ChannelBubble {
  if (!sealMatchesCurrentPayloadAndDependencies(finding, ctx.seal, ctx)) throw new Error('Finding has no valid server seal');
  const template = ctx.registry.resolveTemplate(finding.template, 'bubble', 'publish');
  if (finding.weight !== 'nudge' && finding.weight !== 'poke') throw new Error('Background finding cannot be tap');
  const stance = template.allowedStances.find(value => value !== 'mood');
  if (!stance) throw new Error('Finding cannot be mood');
  const evidence = ctx.evidenceCards?.find(card => card.id === finding.evidenceCardId);
  if (!evidence) throw new Error('Finding evidence unavailable');
  return { id: publicationKey({ ownerId: finding.ownerId, episodeId: finding.episodeId, semanticDeltaId: finding.semanticDeltaId }),
    ownerId: finding.ownerId, speaker: template.speaker ?? 'xiaoqi', episodeId: finding.episodeId,
    posture: ctx.episode.phase === 'idle' ? 'alarm' : 'standalone', anchors: findingAnchors(finding, ctx),
    text: renderRegisteredTemplate(template, finding.slots, ctx.timezone), evidence, templateId: template.id, templateRevision: template.revision,
    semanticDeltaId: finding.semanticDeltaId, createdAt: ctx.now, deliveryCause: 'background_finding',
    stance, weight: finding.weight, layer: 3 };
}
export function assertSemanticDelta(finding: FindingCandidate | undefined, event: ChannelEvent, bubble: ChannelBubble): void {
  if (!bubble.semanticDeltaId || bubble.semanticDeltaId !== event.semanticDeltaId
    || finding && finding.semanticDeltaId !== event.semanticDeltaId) throw new Error('Semantic delta mismatch');
}
export function validateRelationshipLinks(bubble: ChannelBubble, ctx: ChannelPublicationContext): PublicationDecision {
  const links = bubble.anchors.relationshipMemoryIds;
  // Null, undefined and [] have exactly the same meaning; never reject a plain mood for an empty attachment.
  if (links == null || links.length === 0) return { allowed: true };
  if (!['I_told_you', 'admit_wrong'].includes(bubble.stance) || !bubble.anchors.priorOwnBubbleId) return deny('RELATIONSHIP_LINK_NOT_ALLOWED');
  const prior = ctx.priorBubbles.find(item => item.id === bubble.anchors.priorOwnBubbleId && item.ownerId === bubble.ownerId && item.speaker === bubble.speaker);
  if (!prior) return deny('PRIOR_OWN_STATEMENT_MISSING');
  if (links.some(id => !ctx.memories.some(memory => memory.id === id && memory.ownerId === bubble.ownerId
    && memory.sourceBubbleId === prior.id))) return deny('RELATIONSHIP_MEMORY_UNSUPPORTED');
  return { allowed: true };
}
function validEvidence(bubble: ChannelBubble, ctx: ChannelPublicationContext): boolean {
  const card = ctx.evidenceCards?.find(item => item.id === bubble.evidence.id);
  if (!card || canonical(card) !== canonical(bubble.evidence) || !card.summary || !Number.isFinite(Date.parse(card.asOf))
    || Date.parse(card.asOf) > Date.parse(ctx.now) + 5000 || !card.supports.length) return false;
  if (card.kind === 'evidence' && !card.sources.length) return false;
  if (bubble.anchors.primary.kind === 'fact' && !card.supports.some(support => bubble.anchors.primary.kind === 'fact' && support.factId === bubble.anchors.primary.factId)) return false;
  if (bubble.anchors.thesis && !card.supports.some(support => support.thesisId === bubble.anchors.thesis?.id || bubble.anchors.primary.kind === 'fact' && support.factId === bubble.anchors.primary.factId)) return false;
  return card.sources.every(source => !ctx.correctedSourceIds?.includes(source.id)
    && /^(https?:\/\/|\/)/iu.test(source.uri) && !source.uri.startsWith('//')
    && Number.isFinite(Date.parse(source.observedAt)) && Date.parse(source.observedAt) <= Date.parse(ctx.now) + 5000);
}
function vibeAllowsTap(ctx: ChannelPublicationContext): boolean {
  if (!ctx.lastOrdinaryTapAt) return true;
  const policy = { quiet: { gap: 1200, burst: 1 }, deskmate: { gap: 300, burst: 2 }, chatty: { gap: 90, burst: 3 } }[ctx.vibe ?? 'deskmate'];
  const elapsed = (Date.parse(ctx.now) - Date.parse(ctx.lastOrdinaryTapAt)) / 1000;
  return elapsed >= policy.gap || elapsed < 60 && (ctx.currentBurstCount ?? 0) < policy.burst;
}
export function canPublish(bubble: ChannelBubble, ctx: ChannelPublicationContext): PublicationDecision {
  if (bubble.ownerId !== ctx.ownerId || bubble.episodeId !== ctx.episode.id || ctx.event.episodeId !== ctx.episode.id) return deny('OWNER_OR_EPISODE_MISMATCH');
  try { assertSemanticDelta(bubble.deliveryCause === 'background_finding' ? ctx.sealedFinding : undefined, ctx.event, bubble); }
  catch { return deny('SEMANTIC_DELTA_MISMATCH'); }
  if (ctx.event.sequence < ctx.episode.lastEventSequence) return deny('OLDER_EVENT');
  if (!hasValidSupportingAnchor(bubble.anchors, ctx)) return deny('MISSING_OR_STALE_ANCHOR');
  if (!validEvidence(bubble, ctx)) return deny('EVIDENCE_CARD_MISMATCH');
  if (!bubble.text.trim() || graphemeCount(bubble.text) > 90 || /[!！]{2,}|需要注意的是|综上所述/u.test(bubble.text)) return deny('INVALID_READER_TEXT');
  if (ctx.event.findingId && bubble.deliveryCause !== 'background_finding') return deny('FINDING_ROUTE_MISMATCH');
  let template;
  try { template = ctx.registry.resolveTemplate(bubble, 'bubble', 'publish'); }
  catch { return deny('TEMPLATE_UNAVAILABLE'); }
  if (!template.allowedStances.includes(bubble.stance) || !template.allowedWeights.includes(bubble.weight)
    || template.speaker && template.speaker !== bubble.speaker) return deny('TEMPLATE_ROLE_OR_STANCE_MISMATCH');
  const eventConstraints: Record<string, ChannelEvent['kind'][]> = {
    'channel.monitor.near': ['monitor.near'], 'channel.monitor.persisted': ['monitor.persisted'],
    'channel.monitor.breached': ['monitor.breached'], 'channel.monitor.recovered': ['monitor.recovered'],
    'channel.monitor.recovered_after_user': ['monitor.recovered'], 'channel.paper.filled': ['paper.execution_changed'],
    'channel.paper.partial': ['paper.execution_changed'], 'channel.paper.completed': ['paper.execution_changed'], 'channel.research.closed': ['research.day_closed'],
    'channel.opportunity.ready': ['thesis.changed', 'strategy.changed'], 'channel.process.countdown': ['catalyst.countdown'],
    'channel.supplement.scope': ['user.question'], 'channel.supplement.scope_needed': ['user.question'],
    'channel.supplement.unverified': ['user.question'], 'channel.supplement.price': ['user.question'],
    'channel.supplement.position': ['user.question'], 'channel.supplement.cash': ['user.question'],
  };
  if (eventConstraints[template.id] && !eventConstraints[template.id].includes(ctx.event.kind)) return deny('TEMPLATE_EVENT_MISMATCH');
  try {
    const slots = resolveAuthoritativeSlots(template, bubble.anchors, ctx);
    if (renderRegisteredTemplate(template, slots, ctx.timezone) !== bubble.text) return deny('FREE_TEXT_MUTATION');
    if (bubble.stance === 'mood') {
      const mood = validateMoodLine(bubble.text, { ...bubble, slots }, ctx);
      if (!mood.allowed) return mood;
    }
    if (template.id === 'channel.supplement.scope') {
      const index = Number(slots.selectedIndex), count = Number(slots.count);
      const frozenCount = ctx.facts.find(fact => fact.key === 'supplement.scope.originalQuestionCount'
        && ctx.event.factRefs.some(ref => ref.id === fact.id && ref.revision === fact.revision))?.value;
      if (!Number.isSafeInteger(Number(frozenCount)) || Number(frozenCount) < 2
        || !Number.isSafeInteger(index) || index < 1 || index > Number(frozenCount)
        || !Number.isSafeInteger(count) || count < 1 || count >= Number(frozenCount)) return deny('INVALID_FROZEN_QUESTION_SCOPE');
    }
    if (template.id === 'channel.paper.filled' && !(Number(slots.quantity) > 0)) return deny('NO_NONZERO_FILL');
    if (template.id === 'channel.paper.completed' && (!(Number(slots.quantity) > 0)
      || !ctx.completedActions?.some(action => action.eventId === ctx.event.id && action.kind === 'paper_order_filled' && action.status === 'completed'))) return deny('NO_CONFIRMED_COMPLETE_FILL');
    if (template.id === 'channel.paper.partial' && !(Number(slots.filled) > 0 && Number(slots.remaining) > 0)) return deny('NOT_A_PARTIAL_FILL');
  } catch { return deny('INVALID_SLOT_BINDING'); }
  const relationship = validateRelationshipLinks(bubble, ctx);
  if (!relationship.allowed) return relationship;
  if (['I_told_you', 'admit_wrong'].includes(bubble.stance)) {
    const prior = ctx.priorBubbles.find(item => item.id === bubble.anchors.priorOwnBubbleId && item.ownerId === bubble.ownerId && item.speaker === bubble.speaker);
    if (!prior || Date.parse(prior.createdAt) >= Date.parse(ctx.event.occurredAt)) return deny('PRIOR_OWN_STATEMENT_MISSING');
    if (bubble.stance === 'I_told_you' && bubble.anchors.thesis?.id !== prior.anchors.thesis?.id) return deny('UNRELATED_PRIOR_STATEMENT');
  }
  if (bubble.stance === 'watchful' && (bubble.speaker !== 'laozhou' || !['monitor.near', 'monitor.persisted'].includes(ctx.event.kind))) return deny('WATCHFUL_EVENT_NOT_ALLOWED');
  if (bubble.layer === 2 && bubble.weight === 'poke' || bubble.layer === 3 && bubble.weight === 'tap') return deny('LAYER_WEIGHT_MISMATCH');
  if (bubble.layer === 4 && (bubble.weight !== 'poke' || !bubble.action?.length)) return deny('PIN_REQUIRES_DECISION');
  if (bubble.action && (bubble.action.length < 1 || bubble.action.length > 3 || bubble.action.some(action => !action.targetId || action.expiresAt && Date.parse(action.expiresAt) <= Date.parse(ctx.now)))) return deny('INVALID_ACTION');
  if (bubble.posture === 'close' && ctx.episode.userDecisionIds.length) {
    if (bubble.stance !== 'plain_fact' || template.family !== 'episode_close_after_user_action' || !template.isFactualStatusOnly || /虚惊/u.test(bubble.text)) return deny('USER_DECISION_CLOSE_MUST_BE_FACT');
  }
  if (bubble.stance === 'quiet_win') {
    const completion = ctx.completedActions?.find(item => item.eventId === ctx.event.id && item.status === 'completed');
    if (!completion) return deny('NO_CONFIRMED_COMPLETION');
    if (completion.kind === 'monitor_episode_closed' && ctx.episode.userDecisionIds.length) return deny('USER_ACTION_NOT_AGENT_WIN');
    if (template.id === 'channel.monitor.recovered' && (ctx.episode.hadBreach || ctx.episode.executionIds.length)) return deny('NOT_A_FALSE_ALARM');
    if (completion.kind === 'paper_order_filled' && ctx.event.kind !== 'paper.execution_changed') return deny('NO_FILL_EVENT');
    if (completion.kind === 'research_day_closed' && ctx.event.kind !== 'research.day_closed') return deny('RESEARCH_NOT_CLOSED');
    if (completion.kind === 'monitor_episode_closed' && ctx.event.kind !== 'monitor.recovered') return deny('MONITOR_NOT_CLOSED');
  }
  if (bubble.deliveryCause === 'background_finding') {
    const finding = ctx.sealedFinding;
    if (!finding || !sealMatchesCurrentPayloadAndDependencies(finding, ctx.seal, ctx)) return deny('INVALID_COMPILER_SEAL');
    // Second hard guard: the event path cannot bypass a material-gap requirement.
    if (finding.reverseCheckOutcome === 'unable_to_verify'
      && !(finding.kind === 'material_gap' && ctx.hasNewMaterialGap?.(finding) === true)) return deny('NO_NEW_MATERIAL_GAP');
    if (finding.reverseCheckOutcome === 'no_counterevidence_found') return deny('NO_COUNTEREVIDENCE_IS_NOT_A_FINDING');
    if (bubble.weight === 'tap' || bubble.weight !== finding.weight) return deny('BACKGROUND_FINDING_CANNOT_BE_TAP');
  }
  if (ctx.consumedDeltaIds.includes(bubble.semanticDeltaId) || ctx.episode.consumedDeltaIds.includes(bubble.semanticDeltaId)) return deny('DELTA_ALREADY_CONSUMED');
  if (!ctx.directReply && bubble.deliveryCause !== 'user_reply' && ctx.priorBubbles.some(prior => prior.ownerId === bubble.ownerId && prior.episodeId === bubble.episodeId
    && prior.posture === bubble.posture && canonical(prior.anchors.primary) === canonical(bubble.anchors.primary)
    && canonical(prior.anchors.thesis) === canonical(bubble.anchors.thesis)
    && canonical(prior.evidence.supports) === canonical(bubble.evidence.supports)
    && canonical(prior.evidence.gaps) === canonical(bubble.evidence.gaps))) return deny('NO_NEW_SUPPORTED_MEANING');
  if (bubble.posture === 'accompany' && (!['alarm', 'accompany'].includes(ctx.episode.phase) || ctx.event.kind !== 'monitor.persisted')) return deny('NO_NEW_PERSISTENCE_OBSERVATION');
  if (bubble.posture === 'close' && !['monitor.recovered', 'research.day_closed'].includes(ctx.event.kind)) return deny('NO_CLOSE_EVENT');
  if (bubble.weight === 'tap' && !ctx.directReply && !vibeAllowsTap(ctx)) return deny('ORDINARY_TAP_THROTTLED');
  return { allowed: true };
}

export interface FindingPublicationHooks {
  publish: (bubble: ChannelBubble, finding: BackgroundFinding, seal: FindingSeal) => Promise<boolean>;
}
/** This is not the zero-model Brief route: research may use a model; publishing never invents prose. */
export async function onBackgroundFinding(candidate: FindingCandidate, ctx: ChannelPublicationContext, hooks: FindingPublicationHooks): Promise<boolean> {
  if (candidate.reverseCheckOutcome === 'no_counterevidence_found') return false;
  if (candidate.reverseCheckOutcome === 'unable_to_verify'
    && !(candidate.kind === 'material_gap' && ctx.hasNewMaterialGap?.(candidate) === true)) return false;
  const sealed = await sealFinding(candidate, ctx);
  if (sealed.finding.review.state !== 'approved' || !sealed.seal) return false;
  const publishCtx = { ...ctx, seal: sealed.seal, sealedFinding: sealed.finding };
  const bubble = renderApprovedFinding(sealed.finding, publishCtx);
  if (bubble.weight === 'tap' || bubble.weight !== sealed.finding.weight) throw new Error('Background finding weight mismatch');
  assertSemanticDelta(sealed.finding, ctx.event, bubble);
  if (!canPublish(bubble, publishCtx).allowed) return false;
  return hooks.publish(bubble, sealed.finding, sealed.seal);
}
