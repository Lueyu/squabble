import type { ChannelAnchors, ChannelEvent, ChannelFact, ChannelPrimaryAnchor, ChannelTemplate } from '../../../shared/channel.interface';
import { canonical } from './channel-hash';

export interface ChannelSourceContext {
  ownerId: string; now: string; event: ChannelEvent; facts: ChannelFact[];
  reportRefs: Array<{ id: string; revision: number; sectionIds: string[];
    assertions?: Array<{ id: string; value: string | number; subject: ChannelTemplate['subject'] }> }>;
  runtimeValues?: Record<string, string | number>; runtimeRevision?: number;
  correctedSourceIds?: string[]; timezone?: string;
}
export function factIsCurrent(fact: ChannelFact, ctx: ChannelSourceContext): boolean {
  return fact.ownerId === ctx.ownerId && !fact.correctedBy && !ctx.correctedSourceIds?.includes(fact.sourceId ?? '')
    && Number.isFinite(Date.parse(fact.observedAt)) && Date.parse(fact.observedAt) <= Date.parse(ctx.now) + 5000
    && (!fact.expiresAt || Date.parse(fact.expiresAt) > Date.parse(ctx.now));
}
export function hasValidSupportingAnchor(anchor: ChannelAnchors | ChannelPrimaryAnchor, ctx: ChannelSourceContext): boolean {
  const primary = 'primary' in anchor ? anchor.primary : anchor;
  if ('primary' in anchor && anchor.triggerEventId !== ctx.event.id) return false;
  if (ctx.event.ownerId !== ctx.ownerId) return false;
  if (primary.kind === 'fact') return ctx.facts.some(fact => fact.id === primary.factId && fact.revision === primary.factRevision && factIsCurrent(fact, ctx));
  return ctx.reportRefs.some(report => report.id === primary.reportId && report.revision === primary.reportRevision && report.sectionIds.includes(primary.sectionId));
}
export function resolveAuthoritativeSlots(template: ChannelTemplate, anchor: ChannelAnchors, ctx: ChannelSourceContext): Record<string, string | number> {
  if (!hasValidSupportingAnchor(anchor, ctx)) throw new Error('Anchor unavailable');
  const slots: Record<string, string | number> = {};
  for (const slot of template.slotSchema) {
    let value: string | number | undefined;
    if (slot.source.kind === 'fact') {
      const key = slot.source.factKey;
      const fact = ctx.facts.find(item => item.key === key && factIsCurrent(item, ctx)
        && (anchor.primary.kind === 'fact' && anchor.primary.factId === item.id && anchor.primary.factRevision === item.revision
          || ctx.event.factRefs.some(ref => ref.id === item.id && ref.revision === item.revision)));
      if (fact && (typeof fact.value === 'string' || typeof fact.value === 'number')) value = fact.value;
    } else if (slot.source.kind === 'runtime') {
      if (ctx.runtimeRevision === undefined || ctx.event.runtimeRevision !== ctx.runtimeRevision) throw new Error('Runtime version changed');
      value = ctx.runtimeValues?.[slot.source.field];
    } else {
      const assertionId = slot.source.assertionId;
      if (anchor.primary.kind === 'report_section') {
        const primary = anchor.primary;
        value = ctx.reportRefs.find(report => report.id === primary.reportId && report.revision === primary.reportRevision)
          ?.assertions?.find(assertion => assertion.id === assertionId)?.value;
      }
    }
    if (value === undefined || value === null) throw new Error(`Missing slot ${slot.name}`);
    if (slot.format === 'approved_label') {
      if (!slot.approvedLabels?.includes(String(value))) throw new Error('Unapproved label');
    } else if (slot.format === 'time') {
      if (!Number.isFinite(Date.parse(String(value)))) throw new Error('Invalid time');
    } else {
      if (!/^-?\d+(?:\.\d+)?$/u.test(String(value)) || String(value).length > 50 || !Number.isFinite(Number(value))) throw new Error('Invalid decimal');
      if (slot.format === 'duration' && Number(value) < 0) throw new Error('Negative duration');
    }
    slots[slot.name] = value;
  }
  return slots;
}
export function exactSlotValuesMatch(left: Record<string, string | number>, right: Record<string, string | number>): boolean { return canonical(left) === canonical(right); }
export function renderRegisteredTemplate(template: ChannelTemplate, slots: Record<string, string | number>, timezone = 'Asia/Shanghai'): string {
  if (Object.keys(slots).length !== template.slotSchema.length) throw new Error('Unexpected template slots');
  return template.body.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (_, name: string) => {
    const slot = template.slotSchema.find(item => item.name === name);
    if (!slot || !(name in slots)) throw new Error('Missing slot');
    if (slot.format === 'time') return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(String(slots[name])));
    return String(slots[name]);
  });
}
