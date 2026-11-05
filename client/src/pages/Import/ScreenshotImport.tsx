import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Camera, CheckCircle2, Loader2, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ImportCommitResult, ImportRowCandidate } from '@shared/api.interface';
import type { NativeAgentImage } from '@shared/native-image.interface';
import { cancelScreenshotJob, commitImport, createScreenshotJob, fetchScreenshotJob } from '@/api';
import { fetchLocalAgents } from '@/api/local-agents';
import { cleanAgentSettings, agentSettingsProblem } from '@/utils/local-agent-settings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  loadScreenshotProvider, preferredScreenshotAgent, saveScreenshotProvider,
  SCREENSHOT_ERROR_CODES, screenshotAgentReady, screenshotFileValid, screenshotImage,
  ScreenshotJobController, screenshotJobActive, validScreenshotRows,
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
  const seenResult = useRef<string | null>(null);
  const [upload, setUpload] = useState<{ image: NativeAgentImage; dataUrl: string; filename: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [provider, setProvider] = useState({ baseUrl: '', model: '', apiKey: '' });
  const [rows, setRows] = useState<ImportRowCandidate[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<ImportCommitResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [controller] = useState(() => new ScreenshotJobController({ create: createScreenshotJob, get: fetchScreenshotJob, cancel: cancelScreenshotJob }));
  const [task, setTask] = useState(controller.snapshot);
  const active = screenshotJobActive(task.job);
  const jobCreatedAt = task.job?.createdAt;
  const locked = task.submitting || task.cancelling || task.uncertain || active;

  useEffect(() => {
    controller.attach(setTask);
    if (!migrated.current) { migrated.current = true; setProvider(loadScreenshotProvider(localStorage)); }
    return () => { fileEpoch.current++; readerRef.current?.abort(); controller.dispose(); };
  }, [controller]);

  useEffect(() => {
    if (!active || task.cancelling || task.missing) return;
    const timer = setTimeout(() => { void controller.refresh(); }, task.error ? 4000 : 1200);
    return () => clearTimeout(timer);
  }, [controller, task, active]);

  useEffect(() => {
    if (!active || !jobCreatedAt) return;
    const started = new Date(jobCreatedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick(); const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, jobCreatedAt]);

  useEffect(() => {
    if (task.job?.status !== 'completed' || !task.job.result || seenResult.current === task.job.id) return;
    seenResult.current = task.job.id;
    setRows(task.job.result.rows.map(row => ({ ...row, avgCost: row.avgCost ?? null })));
    setReviewed(false);
  }, [task.job]);

  const readFile = (file: File) => {
    const epoch = fileEpoch.current + 1;
    fileEpoch.current = epoch;
    readerRef.current?.abort(); controller.reset(); seenResult.current = null;
    setUpload(null); setRows([]); setReviewed(false); setCommitResult(null); setFileError(null); setReading(false);
    if (!screenshotFileValid(file)) { setFileError('INVALID_IMAGE'); return; }
    setReading(true);
    const reader = new FileReader(); readerRef.current = reader;
    reader.onload = () => {
      if (fileEpoch.current !== epoch) return;
      try {
        const dataUrl = String(reader.result ?? '');
        setUpload({ image: screenshotImage(file, dataUrl), dataUrl, filename: file.name });
      } catch { setFileError('INVALID_IMAGE'); }
      setReading(false);
    };
    reader.onerror = () => { if (fileEpoch.current === epoch) { setReading(false); setFileError('INVALID_IMAGE'); } };
    reader.readAsDataURL(file);
  };

  const settings = cleanAgentSettings({ model: agentModel });
  const modelProblem = executor === 'local' ? agentSettingsProblem(settings, selectedAgent) : null;
  const routeReady = executor === 'local'
    ? Boolean(selectedAgent && screenshotAgentReady(selectedAgent) && !modelProblem)
    : Boolean(provider.model.trim() && provider.apiKey.trim());

  const extract = async () => {
    if (!upload || !routeReady || locked || committing || agentsQuery.isPending) return;
    setRows([]); setReviewed(false); setCommitResult(null); seenResult.current = null;
    setExecutorChoice(executor);
    if (executor === 'local' && selectedAgent) {
      setAgentId(selectedAgent.id);
      await controller.start({ requestId: crypto.randomUUID(), image: upload.image, executor: 'local',
        agentId: selectedAgent.id, agentSettings: settings });
    } else {
      saveScreenshotProvider(localStorage, provider);
      await controller.start({ requestId: crypto.randomUUID(), image: upload.image, executor: 'vision',
        baseUrl: provider.baseUrl.trim() || undefined, model: provider.model.trim(), apiKey: provider.apiKey.trim() });
    }
  };

  const commit = async () => {
    if (committed.current || !reviewed || !validScreenshotRows(rows) || locked) return;
    committed.current = true; setCommitting(true);
    const epoch = fileEpoch.current;
    try {
      const result = await commitImport({ source: 'ocr', rows: rows.map(row => ({ ...row,
        ticker: row.ticker.trim(), company: row.company?.trim() || null,
        avgCost: row.avgCost === '' ? null : row.avgCost })), filename: upload?.filename });
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
    || ['SUBMISSION_UNKNOWN', 'POLL_FAILED', 'CANCEL_FAILED'].includes(code) ? code : 'UNKNOWN'}`);

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{t('import.screenshotImport')}</CardTitle></CardHeader>
      <CardContent className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">{t('import.screenshotFlow.intro')}</p>
        <fieldset className="space-y-3" disabled={locked || committing}>
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
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" disabled={committing}
            onChange={event => { if (event.target.files?.[0]) readFile(event.target.files[0]); event.target.value = ''; }} />
          <Button size="sm" onClick={extract} disabled={!upload || reading || locked || committing || !routeReady || agentsQuery.isPending}>
            {task.submitting || active ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Wand2 size={14} className="mr-1" />}
            {t('import.extract')}
          </Button>
          {reading && <Loader2 size={16} className="animate-spin" aria-label={t('import.screenshotFlow.reading')} />}
          {upload && <img src={upload.dataUrl} alt={t('ui.import.screenshotPreview')} className="h-20 max-w-48 rounded-md border border-border object-contain" />}
        </div>
        <p className="text-xs text-muted-foreground">{t('import.screenshotFlow.fileHint')}{upload && ` · ${upload.filename}`}</p>
        {fileError && <p role="alert" className="text-sm text-destructive">{errorText(fileError)}</p>}

        {(task.requestId || task.error) && <div className="space-y-2 rounded-md border border-border p-3 text-sm" aria-live="polite">
          {task.submitting && <p>{t('import.screenshotFlow.submitting')}</p>}
          {task.job && <p>{t(`import.screenshotFlow.${task.job.status === 'failed' || task.job.status === 'cancelled' ? task.job.status : task.job.phase}`)}
            {active && <span className="ml-2 text-xs text-muted-foreground">{t('import.screenshotFlow.elapsed', { seconds: elapsed })}</span>}</p>}
          {task.error && <p role="alert" className="text-destructive">{errorText(task.error)}</p>}
          <div className="flex flex-wrap gap-2">
            {(task.uncertain || task.error === 'POLL_FAILED') && <Button size="sm" variant="outline" onClick={() => controller.refresh()} disabled={task.polling || task.cancelling}>
              {t('import.screenshotFlow.recover')}
            </Button>}
            {(active || task.submitting || task.uncertain) && <Button size="sm" variant="outline" onClick={() => controller.cancel()} disabled={task.cancelling}>
              {t(task.cancelling ? 'import.screenshotFlow.cancelling' : 'import.screenshotFlow.cancel')}
            </Button>}
            {task.missing && <Button size="sm" variant="outline" onClick={() => controller.reset()}>{t('import.screenshotFlow.prepareNewAttempt')}</Button>}
          </div>
        </div>}

        {rows.length > 0 && <fieldset className="space-y-3" disabled={committing}>
          <div><h2 className="text-sm font-medium">{t('import.screenshotFlow.reviewTitle', { count: rows.length })}</h2>
            {task.job?.result?.broker && <p className="text-xs text-muted-foreground">{t('import.screenshotFlow.broker', { broker: task.job.result.broker })}</p>}
            <p className="mt-1 text-xs text-muted-foreground">{t('import.screenshotFlow.reviewHint')}</p></div>
          <div className="max-h-96 overflow-auto rounded-md border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 bg-muted"><tr className="text-left text-xs text-muted-foreground">
                {['tickerColumn', 'nameColumn', 'sharesColumn', 'costColumn'].map(key => <th key={key} className="px-3 py-2 font-medium">{t(`ui.import.${key}`)}</th>)}
                <th className="px-3 py-2 font-medium">{t('import.screenshotFlow.currency')}</th><th className="w-10"><span className="sr-only">{t('import.screenshotFlow.remove')}</span></th>
              </tr></thead>
              <tbody>{rows.map((row, index) => <tr key={index} className="border-t">
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
          {!validScreenshotRows(rows) && <p role="alert" className="text-xs text-destructive">{t('import.screenshotFlow.invalidRows')}</p>}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
            {t('import.screenshotFlow.reviewAcknowledgement')}</label>
          <Button onClick={commit} disabled={committing || !reviewed || !validScreenshotRows(rows) || locked}>
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
