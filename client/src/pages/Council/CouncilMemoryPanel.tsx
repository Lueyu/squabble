import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Market } from '@shared/api.interface';
import type { ResearchThesis, UpdateResearchThesis } from '@shared/research-memory.interface';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useResearchMemory, useResearchMemoryActions, useResearchMemoryPreferences } from '@/hooks/use-research-memory';
import { memoryCopy } from './memory-copy';
import { formatMemoryDate, memoryErrorText } from './memory-presentation';
import { MemoryThesisDetails } from './MemoryThesisDetails';
import { MemoryEditorSession } from './MemoryEditorSession';
import { MemoryVersions } from './MemoryVersions';
import { MemoryOperations } from './MemoryOperations';
import { MemoryMonitorSession } from './MemoryMonitorSession';

interface CouncilMemoryPanelProps {
  ticker: string; market?: Market; topic?: string; language?: 'zh-CN' | 'en'; onChange?: () => void;
}
export function CouncilMemoryPanel(props: CouncilMemoryPanelProps) {
  return <MemoryPanel key={`${props.ticker}:${props.market ?? ''}:${props.topic ?? ''}`} {...props} />;
}
function MemoryPanel({ ticker, market, topic, language, onChange }: CouncilMemoryPanelProps) {
  const { i18n } = useTranslation();
  const locale = language ?? (i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en');
  const copy = memoryCopy[locale];
  const listing = useResearchMemory({ ticker, market, topic });
  const preferences = useResearchMemoryPreferences();
  const actions = useResearchMemoryActions();
  const [editing, setEditing] = useState<{ thesis: ResearchThesis; mode: 'edit' | 'confirm' } | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [monitoring, setMonitoring] = useState<ResearchThesis | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const monitorOpener = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const allMutations = [actions.preferences, actions.updateMemory, actions.deleteMemory, actions.updateThesis, actions.deleteThesis];
  const error = allMutations.find(action => action.error)?.error ?? listing.error ?? preferences.error;
  const busy = allMutations.some(action => action.isPending);
  const reset = () => allMutations.forEach(action => action.reset());
  const update = (thesis: ResearchThesis, action: UpdateResearchThesis['action'], excluded?: boolean) => {
    reset(); actions.updateThesis.mutate({ id: thesis.id, input: { expectedVersion: thesis.version, action, excluded } }, { onSuccess: onChange });
  };
  const active = (thesis: ResearchThesis) => ['accepted', 'confirmed'].includes(thesis.status) && !thesis.excluded && thesis.sourceStatus === 'available';
  const theses = listing.error ? [] : listing.data?.theses ?? [];
  const cards = (items: ResearchThesis[]) => items.map(thesis => <article key={thesis.id} className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-3 sm:p-4">
    <MemoryThesisDetails thesis={thesis} copy={copy} locale={locale} onMonitors={event => { monitorOpener.current = event.currentTarget; setMonitoring(thesis); }} />
    <div className="flex flex-wrap items-center gap-2">
      {thesis.source && thesis.sourceStatus === 'available' && <>
        {thesis.status !== 'confirmed' && <Button size="sm" disabled={busy} onClick={event => { opener.current = event.currentTarget; reset(); setEditing({ thesis, mode: 'confirm' }); }}>{copy.confirm}</Button>}
        <Button variant="outline" size="sm" disabled={busy} onClick={event => { opener.current = event.currentTarget; reset(); setEditing({ thesis, mode: 'edit' }); }}>{copy.edit}</Button>
        <Button variant="ghost" size="sm" disabled={busy || thesis.status === 'dismissed'} onClick={() => update(thesis, 'dismiss')}>{copy.dismiss}</Button>
        <Button variant="ghost" size="sm" disabled={busy || thesis.status === 'expired'} onClick={() => update(thesis, 'expire')}>{copy.expire}</Button>
        <Label className="gap-2"><Checkbox checked={!thesis.excluded} disabled={busy} aria-label={`${copy.included}: ${thesis.claim.slice(0, 60)}`}
          onCheckedChange={checked => update(thesis, 'exclude', checked !== true)} />{copy.included}</Label>
      </>}
      <Button variant="ghost" size="sm" onClick={event => { opener.current = event.currentTarget; setHistoryId(thesis.id); }}>{copy.versions}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { reset(); actions.deleteThesis.mutate({ id: thesis.id, expectedVersion: thesis.version }, { onSuccess: onChange }); }}>{copy.delete}</Button>
    </div>
  </article>);
  return <section ref={panel} tabIndex={-1} className="min-w-0 space-y-4 rounded-lg border border-border p-3 sm:p-4" data-ai-section-type="card-list">
    <div><h2 className="font-semibold">{copy.title}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{copy.description}</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{memoryErrorText(error, copy)}</p>}
    {listing.isLoading && <p role="status">{copy.loading}</p>}
    {!ticker && <p className="text-sm text-muted-foreground">{copy.noTicker}</p>}
    {listing.data && !listing.error && <>
      <div className="space-y-3"><h3 className="text-sm font-semibold">{copy.active}</h3>
        {!theses.some(active) && <p className="text-sm text-muted-foreground">{copy.noActive}</p>}{cards(theses.filter(active))}</div>
      {!!theses.filter(thesis => !active(thesis)).length && <details><summary className="cursor-pointer text-sm font-medium">{copy.otherTheses} ({theses.filter(thesis => !active(thesis)).length})</summary>
        <div className="mt-3 space-y-3">{cards(theses.filter(thesis => !active(thesis)))}</div></details>}
    </>}
    {preferences.data && <div className="flex flex-wrap gap-4 border-t pt-3">
      {(['autoArchive', 'recallEnabled'] as const).map(key => <Label key={key} className="flex items-start gap-2 text-sm">
        <Switch checked={preferences.data[key]} disabled={busy} aria-label={key === 'autoArchive' ? copy.archive : copy.recall}
          onCheckedChange={checked => { reset(); actions.preferences.mutate({ ...preferences.data!, [key]: checked }, { onSuccess: onChange }); }} />
        {key === 'autoArchive' ? copy.archive : copy.recall}</Label>)}
    </div>}
    {ticker && <MemoryOperations ticker={ticker} market={market} copy={copy} locale={locale} />}
    {listing.data && !listing.error && <details className="min-w-0 border-t pt-3 [overflow-wrap:anywhere]">
      <summary className="cursor-pointer text-sm font-medium">{copy.history} ({listing.data.memories.length})</summary>
      {!listing.data.memories.length && <p className="mt-2 text-sm text-muted-foreground">{copy.empty}</p>}
      <div className="space-y-3 pt-3">{listing.data.memories.map(memory => <article key={memory.id} className="space-y-2 rounded-md border p-3 text-sm">
        <p className="text-xs text-muted-foreground">{memory.ticker} · {memory.topic === 'general' ? copy.general : memory.topic}
          {memory.source && ` · ${copy.version} ${memory.source.reportVersion} · ${formatMemoryDate(memory.source.reportCreatedAt, locale, copy.unknown)}`}</p>
        <p className="whitespace-pre-wrap">{memory.sourceStatus === 'source-deleted' ? copy.sourceDeleted : memory.sourceStatus === 'not-yet-known' ? copy.sourcePending : memory.summary}</p>
        {memory.source && <Link className="text-primary underline" to={memory.source.url}>{copy.source}</Link>}
        <div className="flex flex-wrap items-center gap-3"><Label className="gap-2"><Checkbox checked={!memory.excluded} disabled={busy || !memory.source}
          aria-label={`${copy.included}: ${memory.ticker} ${memory.source?.reportVersion ?? ''}`}
          onCheckedChange={checked => { reset(); actions.updateMemory.mutate({ id: memory.id, excluded: checked !== true }, { onSuccess: onChange }); }} />{copy.included}</Label>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { reset(); actions.deleteMemory.mutate(memory.id, { onSuccess: onChange }); }}>{copy.delete}</Button></div>
      </article>)}</div>
    </details>}
    <Dialog open={Boolean(monitoring)} onOpenChange={open => { if (!open) setMonitoring(null); }}>
      <DialogContent showCloseButton={false} className="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={event => { event.preventDefault(); (monitorOpener.current?.isConnected ? monitorOpener.current : panel.current)?.focus(); }}>
        <DialogHeader><DialogTitle>{copy.monitors}</DialogTitle><DialogDescription>{copy.monitorScope}</DialogDescription></DialogHeader>
        {monitoring && <MemoryMonitorSession key={monitoring.id} snapshot={monitoring} copy={copy} locale={locale} listingError={listing.error}
          listed={listing.data?.theses.find(thesis => thesis.id === monitoring.id)} />}
        <DialogClose asChild><Button variant="ghost" className="justify-self-end">{copy.close}</Button></DialogClose>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(editing)} onOpenChange={open => { if (!open) setEditing(null); }}>
      <DialogContent showCloseButton={false} className="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}><DialogHeader>
        <DialogTitle>{editing?.mode === 'confirm' ? copy.confirm : copy.edit}</DialogTitle><DialogDescription>{copy.editDescription}</DialogDescription></DialogHeader>
        {editing && <MemoryEditorSession snapshot={editing.thesis} mode={editing.mode} copy={copy} busy={busy} error={actions.updateThesis.error} accessError={listing.error}
          unavailable={listing.data?.theses.find(thesis => thesis.id === editing.thesis.id)?.sourceStatus}
          onCancel={() => setEditing(null)} onReload={thesis => { reset(); setEditing({ thesis, mode: editing.mode }); }}
          onSave={input => { reset(); actions.updateThesis.mutate({ id: editing.thesis.id, input }, { onSuccess: () => { setEditing(null); onChange?.(); } }); }} />}
        <DialogClose asChild><Button variant="ghost" className="justify-self-end">{copy.close}</Button></DialogClose>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(historyId)} onOpenChange={open => { if (!open) setHistoryId(null); }}>
      <DialogContent showCloseButton={false} className="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}><DialogHeader>
        <DialogTitle>{copy.versions}</DialogTitle><DialogDescription>{copy.description}</DialogDescription></DialogHeader>
        {historyId && <MemoryVersions id={historyId} copy={copy} locale={locale} />}
        <DialogClose asChild><Button variant="ghost" className="justify-self-end">{copy.close}</Button></DialogClose>
      </DialogContent>
    </Dialog>
  </section>;
}
