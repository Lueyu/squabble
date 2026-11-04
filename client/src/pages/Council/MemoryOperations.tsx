import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Market } from '@shared/api.interface';
import type { ArchiveJobState, ResearchArchiveImportResult } from '@shared/research-memory.interface';
import { fetchResearchArchiveJobs, importResearchReports, retryResearchArchive } from '@/api/research-memory';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { MemoryCopy } from './memory-copy';
import { formatMemoryDate, memoryErrorText } from './memory-presentation';

export function MemoryOperations({ ticker, market, copy, locale }: { ticker: string; market?: Market; copy: MemoryCopy; locale: string }) {
  const client = useQueryClient();
  const [state, setState] = useState<ArchiveJobState | ''>('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [importResult, setImportResult] = useState<ResearchArchiveImportResult | null>(null);
  const successStamp = useRef<string | null>(null);
  const query = useQuery({ queryKey: ['research-memory', 'archive-jobs', { ticker, market, state, cursor }],
    queryFn: () => fetchResearchArchiveJobs({ ticker, market, ...(state ? { state } : {}), cursor, limit: 20 }),
    enabled: Boolean(ticker), refetchInterval: 5_000, retry: false });
  const refresh = () => client.invalidateQueries({ queryKey: ['research-memory'] });
  const retry = useMutation({ mutationFn: retryResearchArchive, retry: false, onSuccess: refresh });
  const importer = useMutation({ mutationFn: () => importResearchReports({ ticker, market, limit: 100, cursor: importResult?.nextCursor ?? undefined }),
    retry: false, onSuccess: async result => { setImportResult(result); await refresh(); } });
  // Publication only queues a job. Observe background completion independently of mutation callbacks.
  useEffect(() => {
    if (!query.data) return;
    const next = `${query.data.counts.succeeded}:${query.data.jobs.filter(job => job.state === 'succeeded').map(job => job.id).join(',')}`;
    if (successStamp.current === next) return;
    successStamp.current = next;
    void client.invalidateQueries({ queryKey: ['research-memory'], predicate: item => item.queryKey[1] !== 'archive-jobs' });
  }, [query.data, client]);
  const busy = importer.isPending || retry.isPending;
  const error = query.error ?? retry.error ?? importer.error;
  return <details className="min-w-0 border-t pt-3 text-sm [overflow-wrap:anywhere]">
    <summary className="cursor-pointer font-medium">{copy.archiveOperations}
      {query.data && ` · ${copy.queued} ${query.data.counts.queued} · ${copy.running} ${query.data.counts.running} · ${copy.failedJob} ${query.data.counts.failed}`}</summary>
    <div className="space-y-3 pt-3"><p className="text-xs text-muted-foreground">{copy.archiveHint}</p>
      {error && <p role="alert" className="text-sm text-destructive">{memoryErrorText(error, copy)}</p>}
      <Button size="sm" variant="outline" className="h-auto whitespace-normal" disabled={busy || !ticker}
        onClick={() => { retry.reset(); importer.mutate(); }}>{importResult?.hasMore ? copy.continueImport : copy.importReports}</Button>
      {importResult && <p role="status" className="text-xs">{copy.scanned}: {importResult.scanned} · {copy.imported}: {importResult.queued}</p>}
      <Label className="grid gap-1">{copy.archiveOperations}<select className="w-full rounded-md border bg-background p-2 text-sm" value={state}
        onChange={event => { setState(event.target.value as ArchiveJobState | ''); setCursor(undefined); }}>
        <option value="">{copy.allStates}</option>{(['queued', 'running', 'succeeded', 'failed'] as const).map(value =>
          <option key={value} value={value}>{value === 'failed' ? copy.failedJob : copy[value]}</option>)}</select></Label>
      {query.isLoading && <p role="status">{copy.loading}</p>}
      {!query.isError && query.data && <>
        <p className="text-xs">{copy.succeeded}: {query.data.counts.succeeded} · {copy.failedJob}: {query.data.counts.failed}</p>
        {!query.data.jobs.length && <p>{copy.noJobs}</p>}
        {query.data.jobs.map(job => <article key={job.id} className="space-y-2 rounded-md border p-3 text-xs">
          <p className="font-medium">{job.ticker} · {copy.version} {job.reportVersion} · {job.state === 'failed' ? copy.failedJob : copy[job.state]}</p>
          <p>{copy.attempts}: {job.attempts} · {copy.updated}: {formatMemoryDate(job.updatedAt, locale, copy.unknown)}</p>
          {job.error && <p>{memoryErrorText(job.error, copy)}</p>}
          <div className="flex flex-wrap items-center gap-3"><Link className="text-primary underline"
            to={`/council?sessionId=${encodeURIComponent(job.sessionId)}&reportId=${encodeURIComponent(job.reportId)}#report-${encodeURIComponent(job.reportId)}-v${job.reportVersion}`}>{copy.source}</Link>
            {job.state === 'failed' && !['MEMORY_DELETED', 'MEMORY_SOURCE_NOT_FOUND', 'MEMORY_SOURCE_NOT_COMPLETED'].includes(job.error ?? '') && <Button size="sm" variant="outline" disabled={busy}
              onClick={() => { importer.reset(); retry.mutate(job.id); }}>{job.error === 'MEMORY_AUTO_ARCHIVE_DISABLED' ? copy.manualArchive : copy.retryArchive}</Button>}</div>
          <details><summary>{copy.technical}</summary>{job.id} · {job.reportId}</details>
        </article>)}
        <div className="flex flex-wrap gap-2">{cursor && <Button size="sm" variant="outline" onClick={() => setCursor(undefined)}>{copy.refresh}</Button>}
          {query.data.nextCursor && <Button size="sm" variant="outline" onClick={() => setCursor(query.data!.nextCursor!)}>{copy.loadMore}</Button>}</div>
      </>}
    </div>
  </details>;
}
