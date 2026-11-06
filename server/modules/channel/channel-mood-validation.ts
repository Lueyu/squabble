import type { ChannelAnchors, ChannelStance, ChannelWeight, ChannelTemplate } from '../../../shared/channel.interface';
import type { ChannelSourceContext } from './channel-slots';
import { exactSlotValuesMatch, hasValidSupportingAnchor, renderRegisteredTemplate, resolveAuthoritativeSlots } from './channel-slots';
import { TemplateRegistry, isAllowedMoodSlotDefinition } from './template-registry';
import { graphemeCount } from './channel-hash';

export interface MoodDecision { allowed: boolean; reason?: string }
export interface MoodCandidate {
  templateId: string; templateRevision: number; stance: ChannelStance; weight: ChannelWeight; layer: number;
  action?: unknown; anchors: ChannelAnchors; slots: Record<string, string | number>;
}
/** Finite reviewed templates are the semantic boundary; lexical checks are defense in depth. */
export function validateMoodLine(text: string, candidate: MoodCandidate, ctx: ChannelSourceContext & { registry: TemplateRegistry }): MoodDecision {
  const deny = (reason: string): MoodDecision => ({ allowed: false, reason });
  if (candidate.stance !== 'mood' || candidate.weight !== 'tap' || candidate.layer !== 2 || candidate.action !== undefined) return deny('MOOD_STRUCTURE_VIOLATION');
  // Undefined, null and [] all mean no attachment, in both relationship and mood validators.
  if (candidate.anchors.relationshipMemoryIds?.length) return deny('MOOD_RELATIONSHIP_MEMORY_FORBIDDEN');
  if (!hasValidSupportingAnchor(candidate.anchors, ctx)) return deny('MISSING_OR_STALE_ANCHOR');
  let template: ChannelTemplate;
  try { template = ctx.registry.resolveTemplate(candidate, 'bubble', 'publish'); }
  catch { return deny('TEMPLATE_UNAVAILABLE_FOR_PUBLICATION'); }
  if (template.family !== 'mood' || template.kind !== 'bubble') return deny('NOT_A_MOOD_TEMPLATE');
  if (!['information_quality', 'research_process'].includes(template.subject)) return deny('INVALID_MOOD_TARGET');
  if (template.changesConclusion !== false || template.impliesInvestmentAdvice !== false) return deny('MOOD_DIRECTION_FLAGS_INVALID');
  if (template.allowedStances.length !== 1 || template.allowedStances[0] !== 'mood'
    || template.allowedWeights.length !== 1 || template.allowedWeights[0] !== 'tap') return deny('MOOD_REGISTRY_INVARIANT_VIOLATION');
  if (!Array.isArray(template.slotSchema) || !template.slotSchema.every(isAllowedMoodSlotDefinition)) return deny('INVALID_MOOD_SLOT_SCHEMA');
  let expected: string;
  try {
    const authoritative = resolveAuthoritativeSlots(template, candidate.anchors, ctx);
    // A process-only placeholder must also resolve to a process/information fact.
    if (template.slotSchema.some(slot => {
      if (slot.source.kind !== 'fact') return true;
      const key = slot.source.factKey;
      return !ctx.facts.some(fact => fact.key === key && ['information_quality', 'research_process'].includes(fact.subject));
    })) return deny('MOOD_SLOT_SUBJECT_MISMATCH');
    if (!exactSlotValuesMatch(candidate.slots, authoritative)) return deny('SLOT_VALUE_OR_KEY_MISMATCH');
    expected = renderRegisteredTemplate(template, authoritative, ctx.timezone);
  } catch { return deny('UNRESOLVED_OR_UNSAFE_SLOT'); }
  if (text !== expected) return deny('FREE_TEXT_MUTATION');
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu, '');
  if (graphemeCount(text) > 90 || graphemeCount(normalized) > 90) return deny('TOO_LONG');
  if (/[!！]{2,}/u.test(normalized)) return deny('EXCESSIVE_EXCLAMATION');
  if (/需要注意的是|综上所述/u.test(normalized)) return deny('BANNED_STYLE');
  if (/买入|卖出|加仓|减仓|该跑|快跑|抄底|追涨|buy now|sell now|go long|go short/iu.test(normalized)) return deny('TRADE_DIRECTION');
  if (/要崩|必涨|必跌|暴涨|暴跌|看涨|看跌|to the moon|crash incoming/iu.test(normalized)) return deny('PRICE_DIRECTION');
  if (/疼不疼|你.*(?:赚|亏|难受|后悔)|your (?:profit|loss|money)|you must feel/iu.test(normalized)) return deny('USER_MONEY_OR_MOTIVE');
  return { allowed: true };
}
