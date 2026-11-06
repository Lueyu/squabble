import type { ChannelTemplate, TemplateRef, TemplateSlot } from '../../../shared/channel.interface';
import { channelHash } from './channel-hash';

export function isAllowedMoodSlotDefinition(slot: TemplateSlot): boolean {
  return slot.source.kind === 'fact' && /^(process\.|catalyst\.|research\.process\.)/u.test(slot.source.factKey)
    && ['decimal', 'duration', 'time', 'approved_label'].includes(slot.format)
    && (slot.format !== 'approved_label' || Boolean(slot.approvedLabels?.length));
}
export function assertMoodRegistryInvariant(template: ChannelTemplate): void {
  if (template.family !== 'mood') {
    if (template.allowedStances.includes('mood')) throw new Error('Mood stance requires mood family');
    return;
  }
  if (template.kind !== 'bubble' || !['information_quality', 'research_process'].includes(template.subject)
    || template.changesConclusion !== false || template.impliesInvestmentAdvice !== false
    || template.allowedStances.length !== 1 || template.allowedStances[0] !== 'mood'
    || template.allowedWeights.length !== 1 || template.allowedWeights[0] !== 'tap'
    || !template.slotSchema.every(isAllowedMoodSlotDefinition)) throw new Error('Invalid mood registry invariant');
}
export function templateContentHash(template: ChannelTemplate): string {
  const { status: _status, retiredAt: _retiredAt, reviewedAt: _reviewedAt, contentHash: _hash, ...immutable } = template;
  return channelHash(immutable);
}
export class TemplateRegistry {
  private readonly records = new Map<string, ChannelTemplate>();
  constructor(records: ChannelTemplate[] = []) { for (const record of records) this.register(record); }
  register(template: ChannelTemplate): ChannelTemplate {
    if (!template.id || !Number.isSafeInteger(template.revision) || template.revision < 1 || !Array.isArray(template.slotSchema)
      || !['draft', 'active', 'retired'].includes(template.status) || !['bubble', 'evidence_card'].includes(template.kind)
      || !template.allowedStances.length || !template.allowedWeights.length || template.body.length > 6000
      || template.status === 'active' && !template.reviewedAt) throw new Error('Invalid template record');
    const names = new Set<string>();
    for (const slot of template.slotSchema) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/u.test(slot.name) || names.has(slot.name)
        || !['decimal', 'money', 'duration', 'time', 'approved_label'].includes(slot.format)
        || !['fact', 'runtime', 'report'].includes(slot.source.kind)
        || slot.format === 'approved_label' && (!slot.approvedLabels?.length || slot.approvedLabels.some(value => typeof value !== 'string' || !value || value.length > 100 || /[\r\n]/u.test(value)))) {
        throw new Error('Invalid template slot');
      }
      names.add(slot.name);
    }
    const placeholders = [...template.body.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(match => match[1]);
    if (placeholders.some(name => !names.has(name)) || [...names].some(name => !placeholders.includes(name))) throw new Error('Template slots do not match body');
    assertMoodRegistryInvariant(template);
    const hash = templateContentHash(template);
    if (template.contentHash && template.contentHash !== hash) throw new Error('Template content hash mismatch');
    const key = `${template.id}:${template.revision}`;
    const existing = this.records.get(key);
    if (existing && (existing.contentHash !== hash || existing.status === 'retired' && template.status !== 'retired')) throw new Error('Template revision is immutable');
    const saved = structuredClone({ ...template, contentHash: hash });
    this.records.set(key, saved);
    return structuredClone(saved);
  }
  resolveTemplate(ref: TemplateRef, kind: ChannelTemplate['kind'], purpose: 'publish' | 'history'): ChannelTemplate {
    const template = this.records.get(`${ref.templateId}:${ref.templateRevision}`);
    if (!template || template.kind !== kind || purpose === 'publish' && (template.status !== 'active' || !template.reviewedAt)) throw new Error('Template unavailable');
    assertMoodRegistryInvariant(template);
    return structuredClone(template);
  }
  retire(ref: TemplateRef, at: string): void {
    const record = this.resolveTemplate(ref, this.records.get(`${ref.templateId}:${ref.templateRevision}`)?.kind ?? 'bubble', 'history');
    this.records.set(`${record.id}:${record.revision}`, { ...record, status: 'retired', retiredAt: at });
  }
  all(): ChannelTemplate[] { return [...this.records.values()].map(record => structuredClone(record)); }
}
