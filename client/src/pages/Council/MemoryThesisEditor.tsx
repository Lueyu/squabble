import { useState } from 'react';
import type { MemoryCitation, ResearchThesis, ThesisContent, UpdateResearchThesis } from '@shared/research-memory.interface';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { MemoryCopy } from './memory-copy';
import { editableThesisContent, thesisEditRequest, thesisListFields } from './memory-presentation';

const selectClass = 'w-full min-w-0 rounded-md border bg-background p-2 text-sm';
export function MemoryThesisEditor({ thesis, citations, copy, busy, conflict, error, mode = 'edit', onSave, onCancel, onReload }: {
  thesis: ResearchThesis; citations: MemoryCitation[]; copy: MemoryCopy; busy: boolean; conflict: boolean; error: string;
  mode?: 'edit' | 'confirm'; onSave: (input: UpdateResearchThesis) => void; onCancel: () => void; onReload: () => void;
}) {
  const [content, setContent] = useState(() => editableThesisContent(thesis));
  const [lines, setLines] = useState(() => Object.fromEntries(thesisListFields.map(field => [field, thesis[field].join('\n')])) as Record<typeof thesisListFields[number], string>);
  const [reason, setReason] = useState('');
  const [expiry, setExpiry] = useState(thesis.expiresAt ?? '');
  const [invalid, setInvalid] = useState('');
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); if (busy || conflict) return;
    if (mode === 'confirm') { onSave({ action: 'confirm', expectedVersion: thesis.version, changeReason: reason.trim() || null }); return; }
    const next: ThesisContent = { ...content, claim: content.claim.trim() };
    for (const field of thesisListFields) next[field] = lines[field].split('\n').map(line => line.trim()).filter(Boolean);
    if (!next.claim || next.claim.length > 1500 || next.supportingEvidence.length > 20 || (next.evidenceRelations?.length ?? 0) > 40
      || thesisListFields.some(field => next[field].length > 20 || next[field].some(line => line.length > 1500))) {
      setInvalid(copy.invalid); return;
    }
    const times = [...Object.values(next.horizon ?? {}), expiry].filter(Boolean);
    if (times.some(value => !/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(value) || !Number.isFinite(Date.parse(value)))
      || next.horizon?.startAt && next.horizon.endAt && Date.parse(next.horizon.startAt) > Date.parse(next.horizon.endAt)) {
      setInvalid(copy.invalidDates); return;
    }
    setInvalid(''); onSave(thesisEditRequest(thesis, next, reason, expiry));
  };
  return <form onSubmit={submit} className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
    {mode === 'confirm' ? <><p className="whitespace-pre-wrap text-sm">{thesis.claim}</p><p className="text-xs text-muted-foreground">{copy.eligibilityHint}</p></> : <>
      <div className="space-y-2"><Label htmlFor="memory-claim">{copy.claim}</Label>
        <Textarea id="memory-claim" value={content.claim} maxLength={1500} onChange={event => setContent({ ...content, claim: event.target.value })} /></div>
      {thesisListFields.map(field => <div className="space-y-2" key={field}><Label htmlFor={`memory-${field}`}>{copy[field]}</Label>
        <Textarea id={`memory-${field}`} value={lines[field]} placeholder={copy.lines} onChange={event => setLines({ ...lines, [field]: event.target.value })} /></div>)}
      <fieldset className="space-y-3"><legend className="text-sm font-medium">{copy.horizon}</legend><p className="text-xs text-muted-foreground">{copy.dateInput}</p>
        {(['startAt', 'endAt', 'reviewAt'] as const).map(key => <div className="space-y-1" key={key}><Label htmlFor={`memory-${key}`}>{copy[key]}</Label>
          <Input id={`memory-${key}`} value={content.horizon?.[key] ?? ''} placeholder="2027-01-01T00:00:00Z" onChange={event => {
            const horizon = { ...content.horizon }; if (event.target.value) horizon[key] = event.target.value; else delete horizon[key];
            setContent({ ...content, horizon });
          }} /></div>)}
        <div className="space-y-1"><Label htmlFor="memory-expiry">{copy.expiryInput}</Label><Input id="memory-expiry" value={expiry} onChange={event => setExpiry(event.target.value)} /></div>
      </fieldset>
      <div className="space-y-2"><Label htmlFor="memory-boundary">{copy.boundary}</Label>
        <select id="memory-boundary" className={selectClass} value={content.boundaryOrigin ?? ''}
          onChange={event => setContent({ ...content, boundaryOrigin: event.target.value as ThesisContent['boundaryOrigin'] })}>
          {!content.boundaryOrigin && <option value="">{copy.unknownBoundary}</option>}
          <option value="unknown">{copy.unknownBoundary}</option><option value="stated">{copy.stated}</option><option value="proposed">{copy.proposed}</option>
        </select></div>
      <fieldset className="space-y-3"><legend className="text-sm font-medium">{copy.relation}</legend>
        {!citations.length && <p className="text-xs">{copy.noEvidence}</p>}
        {citations.map(citation => <div className="space-y-2 rounded-md border p-2" key={citation.evidenceId}>
          <p className="text-sm">{citation.title}</p>
          <Label className="flex items-start gap-2"><Checkbox checked={content.supportingEvidence.some(ref => ref.evidenceId === citation.evidenceId)}
            onCheckedChange={checked => setContent({ ...content, supportingEvidence: checked === true
              ? [...content.supportingEvidence, { evidenceId: citation.evidenceId }] : content.supportingEvidence.filter(ref => ref.evidenceId !== citation.evidenceId) })} />{copy.supportingEvidence}</Label>
          <div className="flex flex-wrap gap-3">{(['support', 'refute', 'qualify'] as const).map(role => <Label key={role} className="gap-2">
            <Checkbox checked={content.evidenceRelations?.some(ref => ref.evidenceId === citation.evidenceId && ref.role === role) ?? false}
              onCheckedChange={checked => setContent({ ...content, evidenceRelations: checked === true
                ? [...(content.evidenceRelations ?? []), { evidenceId: citation.evidenceId, role }]
                : (content.evidenceRelations ?? []).filter(ref => ref.evidenceId !== citation.evidenceId || ref.role !== role) })} />{copy[role]}</Label>)}</div>
        </div>)}
      </fieldset>
      {(content.monitorConditions?.length || content.supersedes) && <p className="text-xs text-muted-foreground">{copy.optionalMetadata}</p>}
    </>}
    <div className="space-y-2"><Label htmlFor="memory-change-reason">{copy.changeReason}</Label><Textarea id="memory-change-reason" value={reason} maxLength={1500} onChange={event => setReason(event.target.value)} /></div>
    {(invalid || error || conflict) && <p role="alert" className="text-sm text-destructive">{conflict ? copy.draftConflict : invalid || error}</p>}
    {conflict && <Button type="button" variant="outline" disabled={busy} className="h-auto whitespace-normal" onClick={onReload}>{copy.reloadLatest}</Button>}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || conflict}>{mode === 'confirm' ? copy.confirm : copy.save}</Button>
      <Button type="button" variant="outline" onClick={onCancel}>{copy.cancel}</Button></div>
  </form>;
}
