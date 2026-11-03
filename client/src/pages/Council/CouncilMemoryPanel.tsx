import { useState } from 'react';
import type { FC } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Market } from '@shared/api.interface';
import type { MemoryCitation, ResearchThesis, ThesisContent, UpdateResearchThesis } from '@shared/research-memory.interface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useResearchMemory, useResearchMemoryActions, useResearchMemoryPreferences,
  useResearchThesisVersions } from '@/hooks/use-research-memory';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';
import { memoryCopy, type MemoryCopy } from './memory-copy';

interface CouncilMemoryPanelProps {
  ticker: string; market?: Market; topic?: string; language?: 'zh-CN' | 'en'; onChange?: () => void;
}
const listFields = ['opposingEvidence', 'assumptions', 'indicators', 'invalidationConditions'] as const;
const date = (value: string, language: string) => new Date(value).toLocaleString(language);

export const CouncilMemoryPanel: FC<CouncilMemoryPanelProps> = ({ ticker, market, topic, language, onChange }) => {
  const { i18n } = useTranslation();
  const locale = language ?? (i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en');
  const copy = memoryCopy[locale];
  const listing = useResearchMemory({ ticker, market, topic });
  const preferences = useResearchMemoryPreferences();
  const actions = useResearchMemoryActions();
  const [editing, setEditing] = useState<ResearchThesis | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const versions = useResearchThesisVersions(historyId);
  // Source liveness comes from the polling list, never from a frozen editor or history cache.
  const editable = editing && listing.data?.theses.some(t => t.id === editing.id && t.sourceStatus === 'available') ? editing : null;
  const historyAvailable = listing.data?.theses.some(t => t.id === historyId && t.sourceStatus === 'available') === true;
  const allMutations = [actions.preferences, actions.updateMemory, actions.deleteMemory, actions.updateThesis, actions.deleteThesis];
  const error = allMutations.find(action => action.error)?.error ?? listing.error ?? preferences.error ?? versions.error;
  const rawError = error ? errorMessage(error, copy.failed) : '';
  const message = rawError.includes('MEMORY_VERSION_CONFLICT') ? copy.conflict
    : rawError.includes('MEMORY_SOURCE_REQUIRED') ? copy.sourceRequired
      : rawError.startsWith('MEMORY_') ? copy.failed : rawError;
  const busy = allMutations.some(action => action.isPending);
  const resetErrors = () => allMutations.forEach(action => action.reset());
  const update = (thesis: ResearchThesis, action: UpdateResearchThesis['action'], excluded?: boolean) => {
    resetErrors();
    actions.updateThesis.mutate({ id: thesis.id, input: { expectedVersion: thesis.version, action, excluded } }, { onSuccess: onChange });
  };

  return <section className="space-y-4 rounded-lg border border-border p-4" data-ai-section-type="card-list">
    <div><h2 className="font-semibold">{copy.title}</h2><p className="mt-1 text-sm text-muted-foreground">{copy.description}</p></div>
    {preferences.data && <div className="flex flex-wrap gap-4">
      {(['autoArchive', 'recallEnabled'] as const).map(key => <Label key={key} className="gap-2">
        <Switch checked={preferences.data[key]} disabled={busy} aria-label={key === 'autoArchive' ? copy.archive : copy.recall}
          onCheckedChange={checked => { resetErrors(); actions.preferences.mutate({ ...preferences.data!, [key]: checked }, { onSuccess: onChange }); }} />
        {key === 'autoArchive' ? copy.archive : copy.recall}
      </Label>)}
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{message}</p>}
    {listing.isLoading && <p role="status" className="text-sm text-muted-foreground">{copy.loading}</p>}
    {!ticker && <p className="text-sm text-muted-foreground">{copy.noTicker}</p>}
    {listing.data && !listing.data.memories.length && <p className="text-sm text-muted-foreground">{copy.empty}</p>}
    {!!listing.data?.memories.length && <div className="space-y-3">
      <h3 className="text-sm font-semibold">{copy.history}</h3>
      {listing.data.memories.map(memory => <article key={memory.id} className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{memory.ticker} · {memory.topic === 'general' ? copy.general : memory.topic}</span>
          {memory.source && <span>{copy.version} {memory.source.reportVersion} · {date(memory.source.reportCreatedAt, locale)}</span>}
          {memory.flags.map(flag => <Badge key={flag} variant="outline">{copy[flag]}</Badge>)}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm">{memory.sourceStatus === 'source-deleted' ? copy.sourceDeleted : memory.summary}</p>
        {memory.source && <Link className="text-sm text-primary underline" to={memory.source.url}>{copy.source}</Link>}
        <div className="flex flex-wrap items-center gap-3">
          <Label className="gap-2"><Checkbox checked={!memory.excluded} disabled={busy || !memory.source} aria-label={`${copy.included}: ${memory.ticker} ${memory.id}`}
            onCheckedChange={checked => { resetErrors(); actions.updateMemory.mutate({ id: memory.id, excluded: checked !== true }, { onSuccess: onChange }); }} />{copy.included}</Label>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { resetErrors(); actions.deleteMemory.mutate(memory.id, { onSuccess: onChange }); }}>{copy.delete}</Button>
        </div>
      </article>)}
    </div>}
    {!!listing.data?.theses.length && <div className="space-y-3">
      <h3 className="text-sm font-semibold">{copy.theses}</h3>
      {listing.data.theses.map(thesis => <article key={thesis.id} className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2"><Badge variant={thesis.status === 'confirmed' ? 'secondary' : 'outline'}>{copy[thesis.status]}</Badge>
          <span className="text-xs text-muted-foreground">{copy.version} {thesis.version} · {copy.updated} {date(thesis.updatedAt, locale)}</span>
          {thesis.flags.map(flag => <Badge key={flag} variant="outline">{copy[flag]}</Badge>)}
        </div>
        {thesis.source ? <>
          <p className="whitespace-pre-wrap break-words text-sm">{thesis.claim}</p>
          {thesis.status === 'candidate' && <p className="text-xs text-muted-foreground">{copy.confirmHint}</p>}
          <details className="text-sm"><summary className="cursor-pointer">{copy.supportingEvidence}</summary>
            <EvidenceList citations={thesis.citations} copy={copy} locale={locale} />
            {listFields.map(field => <div className="mt-2" key={field}><strong>{copy[field]}</strong>
              <ul className="ml-4 list-disc">{thesis[field].map((line, index) => <li className="break-words" key={index}>{line}</li>)}</ul></div>)}
          </details>
          <Link className="text-sm text-primary underline" to={thesis.source.url}>{copy.source} · {copy.version} {thesis.source.reportVersion}</Link>
        </> : <p className="text-sm text-muted-foreground">{copy.sourceDeleted}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {thesis.source && <>
            {thesis.status !== 'confirmed' && <Button size="sm" disabled={busy} onClick={() => update(thesis, 'confirm')}>{copy.confirm}</Button>}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { resetErrors(); setEditing(thesis); }}>{copy.edit}</Button>
            <Button variant="ghost" size="sm" disabled={busy || thesis.status === 'dismissed'} onClick={() => update(thesis, 'dismiss')}>{copy.dismiss}</Button>
            <Button variant="ghost" size="sm" disabled={busy || thesis.status === 'expired'} onClick={() => update(thesis, 'expire')}>{copy.expire}</Button>
            <Label className="gap-2"><Checkbox checked={!thesis.excluded} disabled={busy} aria-label={`${copy.included}: ${thesis.claim.slice(0, 60)}`}
              onCheckedChange={checked => update(thesis, 'exclude', checked !== true)} />{copy.included}</Label>
          </>}
          <Button variant="ghost" size="sm" onClick={() => setHistoryId(thesis.id)}>{copy.versions}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { resetErrors(); actions.deleteThesis.mutate({ id: thesis.id, expectedVersion: thesis.version }, { onSuccess: onChange }); }}>{copy.delete}</Button>
        </div>
      </article>)}
    </div>}
    <Dialog open={Boolean(editable)} onOpenChange={open => { if (!open) setEditing(null); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{copy.edit}</DialogTitle><DialogDescription>{copy.editDescription}</DialogDescription></DialogHeader>
        {editable && <ThesisEditor key={`${editable.id}-${editable.version}`} thesis={editable} copy={copy} busy={busy}
          citations={listing.data?.memories.find(memory => memory.id === editable.memoryId)?.citations ?? []}
          error={message} onCancel={() => setEditing(null)} onSave={content => {
            resetErrors(); actions.updateThesis.mutate({ id: editable.id, input: { action: 'edit', expectedVersion: editable.version, content } },
              { onSuccess: () => { setEditing(null); onChange?.(); } });
          }} />}
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(historyId)} onOpenChange={open => { if (!open) setHistoryId(null); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{copy.versions}</DialogTitle><DialogDescription>{copy.description}</DialogDescription></DialogHeader>
        {versions.isLoading && <p role="status">{copy.loading}</p>}
        {versions.error && <p role="alert">{copy.failed}</p>}
        {!historyAvailable && <p>{copy.sourceDeleted}</p>}
        {historyAvailable && versions.data?.map(version => <details key={version.version} className="space-y-2 border-t pt-2">
          <summary className="cursor-pointer text-sm">{copy.version} {version.version} · {copy[version.status]} · {date(version.createdAt, locale)}</summary>
          {version.content ? <div className="text-sm"><p className="whitespace-pre-wrap break-words">{version.content.claim}</p>
            {listFields.map(field => <div className="mt-2" key={field}><strong>{copy[field]}</strong><ul className="ml-4 list-disc">
              {version.content![field].map((line, index) => <li key={index} className="break-words">{line}</li>)}</ul></div>)}
          </div> : <p>{copy.sourceDeleted}</p>}
        </details>)}
      </DialogContent>
    </Dialog>
  </section>;
};

const EvidenceList: FC<{ citations: MemoryCitation[]; copy: MemoryCopy; locale: string }> = ({ citations, copy, locale }) =>
  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{!citations.length && <li>{copy.noEvidence}</li>}
    {citations.map(citation => <li className="break-words" key={citation.evidenceId}>
      {citation.sourceUrl ? <a href={citation.sourceUrl} target="_blank" rel="noreferrer" className="text-primary underline">{citation.title}</a> : citation.title}
      {' · '}{Number.isFinite(Date.parse(citation.fetchedAt)) ? date(citation.fetchedAt, locale) : copy.unverified}
    </li>)}
  </ul>;

const ThesisEditor: FC<{ thesis: ResearchThesis; citations: MemoryCitation[]; copy: MemoryCopy; busy: boolean; error: string;
  onSave: (content: ThesisContent) => void; onCancel: () => void }> = ({ thesis, citations, copy, busy, error, onSave, onCancel }) => {
  const [claim, setClaim] = useState(thesis.claim);
  const [lines, setLines] = useState(Object.fromEntries(listFields.map(field => [field, thesis[field].join('\n')])) as Record<typeof listFields[number], string>);
  const [evidence, setEvidence] = useState(thesis.supportingEvidence.map(ref => ref.evidenceId));
  const [invalid, setInvalid] = useState(false);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const content: ThesisContent = { claim: claim.trim(), supportingEvidence: evidence.map(evidenceId => ({ evidenceId })),
      opposingEvidence: [], assumptions: [], indicators: [], invalidationConditions: [] };
    for (const field of listFields) content[field] = lines[field].split('\n').map(line => line.trim()).filter(Boolean);
    if (!content.claim || content.claim.length > 1500 || listFields.some(field => content[field].length > 20
      || content[field].some(line => line.length > 1500))) { setInvalid(true); return; }
    setInvalid(false); onSave(content);
  };
  return <form onSubmit={submit} className="space-y-4">
    <div className="space-y-2"><Label htmlFor="memory-claim">{copy.claim}</Label><Textarea id="memory-claim" value={claim} maxLength={1500} onChange={event => setClaim(event.target.value)} /></div>
    <fieldset className="space-y-2"><legend className="text-sm">{copy.supportingEvidence}</legend>
      {!citations.length && <p className="text-xs text-muted-foreground">{copy.noEvidence}</p>}
      {citations.map(citation => <Label className="gap-2" key={citation.evidenceId}><Checkbox checked={evidence.includes(citation.evidenceId)}
        onCheckedChange={checked => setEvidence(current => checked ? [...current, citation.evidenceId] : current.filter(id => id !== citation.evidenceId))} />{citation.title}</Label>)}
    </fieldset>
    {listFields.map(field => <div className="space-y-2" key={field}><Label htmlFor={`memory-${field}`}>{copy[field]}</Label>
      <Textarea id={`memory-${field}`} value={lines[field]} placeholder={copy.lines} onChange={event => setLines(current => ({ ...current, [field]: event.target.value }))} /></div>)}
    {(invalid || error) && <p role="alert" className="text-sm text-destructive">{invalid ? copy.invalid : error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy}>{copy.save}</Button><Button type="button" variant="outline" onClick={onCancel}>{copy.cancel}</Button></div>
  </form>;
};
