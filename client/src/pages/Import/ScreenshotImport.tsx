import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Camera, CheckCircle2, Loader2, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ImportCommitResult, ImportRowCandidate } from '@shared/api.interface';
import { cancelScreenshotJob, commitImport, createScreenshotJob, fetchScreenshotJob } from '@/api';
import { fetchLocalAgents } from '@/api/local-agents';
import { cleanAgentSettings, agentSettingsProblem } from '@/utils/local-agent-settings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  loadScreenshotProvider, preferredScreenshotAgent, saveScreenshotProvider,
  SCREENSHOT_ERROR_CODES, screenshotAgentReady, screenshotAgentQueueReady, screenshotImage, screenshotSelectionError,
  screenshotReviewProblem, ScreenshotBatchController, screenshotJobActive,
  type ScreenshotBatchItem, type ScreenshotBatchRow,
} from './screenshot-import';

export default function ScreenshotImport() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({ queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents, refetchInterval: 10000 });
  const agents = agentsQuery.data ?? [];
  const preferredAgent = preferredScreenshotAgent(agents);
  const [executorChoice, setExecutorChoice] = useState<'local' | 'vision' | null>(null);
  const [agentId, setAgentId] = useState('');
  const [agentModel, setAgentModel] = useState('');
  const executor = executorChoice ?? (preferredAgent ? 'local' : 'vision');
  const selectedAgent = agentId ? agents.find(agent => agent.id === agentId) : preferredAgent;
  const fileRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<FileReader | null>(null);
  const fileEpoch = useRef(0);
  const migrated = useRef(false);
  const committed = useRef(false);
  const seenRowsCount = useRef(0);
  const [uploads, setUploads] = useState<ScreenshotBatchItem[]>([]);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [provider, setProvider] = useState({ baseUrl: '', model: '', apiKey: '' });
  const [rows, setRows] = useState<ScreenshotBatchRow[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<ImportCommitResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [controller] = useState(() => new ScreenshotBatchController({ create: createScreenshotJob, get: fetchScreenshotJob, cancel: cancelScreenshotJob }));
  const [batch, setBatch] = useState(controller.snapshot);
  const task = batch.task;
  const active = screenshotJobActive(task.job);
  const jobCreatedAt = task.job?.createdAt;
  const locked = task.submitting || task.cancelling || task.uncertain || active;
  const queued = batch.files.some(file => file.status === 'queued');
  const queueFinished = batch.files.length > 0 && !queued && !batch.files.some(file => file.status === 'running') && (batch.stopped || !locked);
  const reviewProblem = screenshotReviewProblem(rows);

  useEffect(() => {
    controller.attach(setBatch);
    if (!migrated.current) { migrated.current = true; setProvider(loadScreenshotProvider(localStorage)); }
    return () => { fileEpoch.current++; readerRef.current?.abort(); controller.dispose(); };
  }, [controller]);

  useEffect(() => {
    if (!active || task.cancelling || task.missing || batch.paused) return;
    const timer = setTimeout(() => { void controller.job.refresh(); }, task.error ? 4000 : 1200);
    return () => clearTimeout(timer);
  }, [controller, task, active, batch.paused]);

  useEffect(() => {
    if (!active || !jobCreatedAt) return;
    const started = new Date(jobCreatedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick(); const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, jobCreatedAt]);

  useEffect(() => {
    if (batch.rows.length <= seenRowsCount.current) return;
    const added = batch.rows.slice(seenRowsCount.current);
    setRows(current => [...current, ...added]);
    seenRowsCount.current = batch.rows.length;
    setReviewed(false);
  }, [batch.rows]);

  const readFiles = (files: File[]) => {
    const problem = screenshotSelectionError(files);
    if (problem) { setFileError(problem); return; }
    const epoch = fileEpoch.current + 1;
    fileEpoch.current = epoch;
    readerRef.current?.abort(); controller.replace([]); seenRowsCount.current = 0;
    setUploads([]); setRows([]); setReviewed(false); setCommitResult(null); setFileError(null); setReading(false);
    setReading(true);
    const loaded: ScreenshotBatchItem[] = [];
    const readNext = (index: number) => {
      if (fileEpoch.current !== epoch) return;
      if (index === files.length) { setUploads(loaded); controller.replace(loaded); setReading(false); return; }
      const file = files[index];
      const reader = new FileReader(); readerRef.current = reader;
      reader.onload = () => {
        if (fileEpoch.current !== epoch) return;
        try {
          const dataUrl = String(reader.result ?? '');
          loaded.push({ image: screenshotImage(file, dataUrl), dataUrl, filename: file.name });
          readNext(index + 1);
        } catch { setFileError('INVALID_IMAGE'); setReading(false); }
      };
      reader.onerror = () => { if (fileEpoch.current === epoch) { setReading(false); setFileError('INVALID_IMAGE'); } };
      reader.readAsDataURL(file);
    };
    readNext(0);
  };

  const settings = cleanAgentSettings({ model: agentModel });
  const modelProblem = executor === 'local' ? agentSettingsProblem(settings, selectedAgent) : null;
  const routeReady = executor === 'local'
    ? Boolean(selectedAgent && screenshotAgentReady(selectedAgent) && !modelProblem)
    : Boolean(provider.model.trim() && provider.apiKey.trim());
  const queueRouteReady = executor === 'local'
    ? Boolean(selectedAgent && screenshotAgentQueueReady(selectedAgent) && !modelProblem)
    : routeReady;
  const routeReadyRef = useRef(queueRouteReady);
  routeReadyRef.current = queueRouteReady;

  const extract = async () => {
    if (!uploads.length || !routeReady || batch.started || locked || committing || agentsQuery.isPending) return;
    setRows([]); seenRowsCount.current = 0; setReviewed(false); setCommitResult(null);
    setExecutorChoice(executor);
    if (executor === 'local' && selectedAgent) {
      setAgentId(selectedAgent.id);
      await controller.start(item => ({ requestId: crypto.randomUUID(), image: item.image, executor: 'local',
        agentId: selectedAgent.id, agentSettings: settings }), () => routeReadyRef.current);
    } else {
      saveScreenshotProvider(localStorage, provider);
      await controller.start(item => ({ requestId: crypto.randomUUID(), image: item.image, executor: 'vision',
        baseUrl: provider.baseUrl.trim() || undefined, model: provider.model.trim(), apiKey: provider.apiKey.trim() }), () => routeReadyRef.current);
    }
  };

  const commit = async () => {
    if (committed.current || !reviewed || reviewProblem || !queueFinished) return;
    committed.current = true; setCommitting(true);
    const epoch = fileEpoch.current;
    try {
      const result = await commitImport({ source: 'ocr', rows: rows.map(({ sourceFile: _sourceFile, ...row }) => ({ ...row,
        ticker: row.ticker.trim(), company: row.company?.trim() || null,
        avgCost: row.avgCost === '' ? null : row.avgCost })), filename: uploads.map(item => item.filename).join(', ').slice(0, 255) });
      queryClient.invalidateQueries({ queryKey: ['import'] });
      queryClient.invalidateQueries({ queryKey: ['holdings'] });
      if (epoch !== fileEpoch.current) return;
      setCommitResult(result); setRows([]); setReviewed(false);
      toast.success(t('import.importComplete', { created: result.created, skipped: result.skipped }));
    } catch {
      if (epoch === fileEpoch.current) toast.error(t('import.importFailed'));
    } finally {
      committed.current = false;
      if (epoch === fileEpoch.current) setCommitting(false);
    }
  };

  const updateRow = (index: number, patch: Partial<ImportRowCandidate>) => {
    setRows(current => current.map((row, i) => i === index ? { ...row, ...patch } : row));
    setReviewed(false);
  };
  const errorText = (code: string) => t(`import.screenshotFlow.errors.${SCREENSHOT_ERROR_CODES.has(code)
    || ['SUBMISSION_UNKNOWN', 'POLL_FAILED', 'CANCEL_FAILED', 'INVALID_IMAGE', 'FILE_COUNT', 'TOTAL_SIZE'].includes(code) ? code : 'UNKNOWN'}`);

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{t('import.screenshotImport')}</CardTitle></CardHeader>
      <CardContent className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">{t('import.screenshotFlow.intro')}</p>
        <fieldset className="space-y-3" disabled={batch.started || committing}>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="screenshot-executor">{t('import.screenshotFlow.executor')}</Label>
              <select id="screenshot-executor" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={executor} onChange={event => setExecutorChoice(event.target.value as 'local' | 'vision')}>
                <option value="local">{t('import.screenshotFlow.local')}</option>
                <option value="vision">{t('import.screenshotFlow.vision')}</option>
              </select>
            </div>
            {executor === 'local' && <div className="space-y-1.5">
              <Label htmlFor="screenshot-agent">{t('import.screenshotFlow.agent')}</Label>
              <select id="screenshot-agent" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={selectedAgent?.id ?? ''} onChange={event => { setExecutorChoice('local'); setAgentId(event.target.value); setAgentModel(''); }}>
                {!selectedAgent && <option value="">{t('import.screenshotFlow.noAgent')}</option>}
                {agents.filter(agent => agent.imageInput === true).map(agent => <option key={agent.id} value={agent.id} disabled={!screenshotAgentReady(agent)}>
                  {agent.name}{!screenshotAgentReady(agent) ? ` · ${t(agent.busy ? 'import.screenshotFlow.busy' : 'import.screenshotFlow.unavailable')}` : ''}
                </option>)}
              </select>
            </div>}
          </div>
          {agentsQuery.isPending ? <p className="text-xs text-muted-foreground">{t('import.screenshotFlow.loadingAgents')}</p>
            : !preferredAgent && <p className="text-xs text-muted-foreground">{t('import.screenshotFlow.noAgentHint')} <a className="underline" href="/settings/agents">{t('import.screenshotFlow.manageAgents')}</a></p>}
          {executor === 'local' ? <div className="space-y-2">
            <Label htmlFor="screenshot-agent-model">{t('import.visionModel')}</Label>
            <Input id="screenshot-agent-model" list="screenshot-agent-models" value={agentModel}
              disabled={selectedAgent?.models === undefined} placeholder={t('import.screenshotFlow.defaultModel')}
              onChange={event => setAgentModel(event.target.value)} />
            <datalist id="screenshot-agent-models">{selectedAgent?.models?.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
            <p className="text-xs text-muted-foreground">{t('import.screenshotFlow.modelVisionNotice')}</p>
            {modelProblem && <p role="alert" className="text-xs text-destructive">{t('import.screenshotFlow.modelInvalid')}</p>}
          </div> : <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5"><Label htmlFor="screenshot-api-base">{t('import.apiEndpoint')}</Label>
              <Input id="screenshot-api-base" value={provider.baseUrl} placeholder="https://api.example.com/v1"
                onChange={event => setProvider(current => ({ ...current, baseUrl: event.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="screenshot-api-model">{t('import.visionModel')}</Label>
              <Input id="screenshot-api-model" value={provider.model} placeholder={t('import.screenshotFlow.visionModelHint')}
                onChange={event => setProvider(current => ({ ...current, model: event.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="screenshot-api-key">{t('import.apiKey')}</Label>
              <Input id="screenshot-api-key" type="password" autoComplete="off" value={provider.apiKey}
                placeholder={t('import.screenshotFlow.keyMemoryOnly')}
                onChange={event => setProvider(current => ({ ...current, apiKey: event.target.value }))} /></div>
          </div>}
        </fieldset>
        <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">{t(executor === 'local'
          ? 'import.screenshotFlow.localPrivacy' : 'import.screenshotFlow.apiPrivacy')}</p>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" disabled={committing} onClick={() => fileRef.current?.click()}>
            <Camera size={14} className="mr-1" />{t('import.selectScreenshot')}
          </Button>
          <input ref={fileRef} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" disabled={committing}
            onChange={event => { if (event.target.files?.length) readFiles(Array.from(event.target.files)); event.target.value = ''; }} />
          <Button size="sm" onClick={extract} disabled={!uploads.length || reading || batch.started || locked || committing || !routeReady || agentsQuery.isPending}>
            {task.submitting || active ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Wand2 size={14} className="mr-1" />}
            {t('import.extract')}
          </Button>
          {reading && <Loader2 size={16} className="animate-spin" aria-label={t('import.screenshotFlow.reading')} />}
          {uploads[0]?.dataUrl && <img src={uploads[0].dataUrl} alt={t('ui.import.screenshotPreview')} className="h-20 max-w-48 rounded-md border border-border object-contain" />}
        </div>
        <p className="text-xs text-muted-foreground">{t('import.screenshotFlow.fileHint')}</p>
        {fileError && <p role="alert" className="text-sm text-destructive">{errorText(fileError)}</p>}

        {batch.files.length > 0 && <div className="space-y-1 rounded-md border border-border p-3 text-sm" aria-live="polite">
          {batch.files.map((file, index) => <p key={index}>
            <span className="font-medium">{file.filename}</span> · {t(`import.screenshotFlow.fileStatus.${file.status}`)}
            {file.error && <span className="ml-2 text-destructive">{errorText(file.error)}</span>}
          </p>)}
          {batch.paused && <p role="alert" className="text-destructive">{t(batch.pauseReason === 'ROUTE_UNAVAILABLE'
            ? 'import.screenshotFlow.routeUnavailable' : 'import.screenshotFlow.batchPaused')}</p>}
          {batch.paused && !locked && queued && <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => controller.resume()} disabled={!queueRouteReady}>{t('import.screenshotFlow.resumeRemaining')}</Button>
            <Button size="sm" variant="outline" onClick={() => { controller.skipRemaining(); setReviewed(false); }}>{t('import.screenshotFlow.skipRemaining')}</Button>
          </div>}
        </div>}

        {(task.requestId || task.error) && <div className="space-y-2 rounded-md border border-border p-3 text-sm" aria-live="polite">
          {task.submitting && <p>{t('import.screenshotFlow.submitting')}</p>}
          {task.job && <p>{t(`import.screenshotFlow.${task.job.status === 'failed' || task.job.status === 'cancelled' ? task.job.status : task.job.phase}`)}
            {active && <span className="ml-2 text-xs text-muted-foreground">{t('import.screenshotFlow.elapsed', { seconds: elapsed })}</span>}</p>}
          {task.error && <p role="alert" className="text-destructive">{errorText(task.error)}</p>}
          <div className="flex flex-wrap gap-2">
            {(task.uncertain || task.error === 'POLL_FAILED') && <Button size="sm" variant="outline" onClick={() => controller.recover()} disabled={task.polling || task.cancelling}>
              {t('import.screenshotFlow.recover')}
            </Button>}
            {(active || task.submitting || task.uncertain || queued) && <Button size="sm" variant="outline" onClick={() => { controller.cancel(); setReviewed(false); }} disabled={task.cancelling}>
              {t(task.cancelling ? 'import.screenshotFlow.cancelling' : 'import.screenshotFlow.cancel')}
            </Button>}
          </div>
        </div>}

        {rows.length > 0 && <fieldset className="space-y-3" disabled={committing}>
          <div><h2 className="text-sm font-medium">{t('import.screenshotFlow.reviewTitle', { count: rows.length })}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('import.screenshotFlow.reviewHint')}</p></div>
          {batch.files.some(file => file.status === 'failed' || file.status === 'cancelled') &&
            <p role="alert" className="text-xs text-destructive">{t('import.screenshotFlow.partialWarning')}</p>}
          <div className="max-h-96 overflow-auto rounded-md border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 bg-muted"><tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('import.screenshotFlow.sourceFile')}</th>
                {['tickerColumn', 'nameColumn', 'sharesColumn', 'costColumn'].map(key => <th key={key} className="px-3 py-2 font-medium">{t(`ui.import.${key}`)}</th>)}
                <th className="px-3 py-2 font-medium">{t('import.screenshotFlow.currency')}</th><th className="w-10"><span className="sr-only">{t('import.screenshotFlow.remove')}</span></th>
              </tr></thead>
              <tbody>{rows.map((row, index) => <tr key={index} className="border-t">
                <td className="max-w-40 truncate px-3 py-1 text-xs text-muted-foreground" title={row.sourceFile}>{row.sourceFile}</td>
                <td className="min-w-28 px-2 py-1"><Input className="h-8" aria-label={t('import.screenshotFlow.rowTicker', { row: index + 1 })}
                  value={row.ticker} onChange={event => updateRow(index, { ticker: event.target.value })} /></td>
                <td className="min-w-36 px-2 py-1"><Input className="h-8" aria-label={t('import.screenshotFlow.rowCompany', { row: index + 1 })}
                  value={row.company ?? ''} onChange={event => updateRow(index, { company: event.target.value || null })} /></td>
                <td className="min-w-28 px-2 py-1"><Input className="h-8 font-mono-nums" type="number" min="0" step="any" aria-label={t('import.screenshotFlow.rowShares', { row: index + 1 })}
                  value={row.shares} onChange={event => updateRow(index, { shares: event.target.value })} /></td>
                <td className="min-w-32 px-2 py-1"><Input className="h-8 font-mono-nums" type="number" min="0" step="any" aria-label={t('import.screenshotFlow.rowCost', { row: index + 1 })}
                  placeholder={t('import.screenshotFlow.unknownCost')} value={row.avgCost ?? ''} onChange={event => updateRow(index, { avgCost: event.target.value === '' ? null : event.target.value })} /></td>
                <td className="min-w-24 px-3 py-1 text-xs text-muted-foreground">{row.currency || t('import.screenshotFlow.autoCurrency')}</td>
                <td className="px-1"><Button size="sm" variant="ghost" aria-label={t('import.screenshotFlow.removeRow', { row: index + 1 })}
                  onClick={() => { setRows(current => current.filter((_, i) => i !== index)); setReviewed(false); }}><Trash2 size={14} /></Button></td>
              </tr>)}</tbody>
            </table>
          </div>
          {reviewProblem && <p role="alert" className="text-xs text-destructive">{t(`import.screenshotFlow.${reviewProblem === 'INVALID_ROWS' ? 'invalidRows'
            : reviewProblem === 'ROW_LIMIT' ? 'rowLimit' : 'duplicateTickers'}`)}</p>}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
            {t('import.screenshotFlow.reviewAcknowledgement')}</label>
          <Button onClick={commit} disabled={committing || !reviewed || Boolean(reviewProblem) || !queueFinished}>
            {committing ? <Loader2 size={14} className="mr-1 animate-spin" /> : <CheckCircle2 size={14} className="mr-1" />}
            {t('import.confirmImport', { count: rows.length })}
          </Button>
        </fieldset>}
        {commitResult && <div role="status" className="space-y-1 rounded-md border border-border p-3 text-sm">
          <p>{t('import.importComplete', { created: commitResult.created, skipped: commitResult.skipped })}</p>
          {commitResult.failed.map((failure, index) => <p key={index} className="text-xs text-muted-foreground">{failure.ticker}: {failure.reason}</p>)}
        </div>}
      </CardContent>
    </Card>
  );
}
