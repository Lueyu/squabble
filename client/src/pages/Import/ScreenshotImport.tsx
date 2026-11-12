import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CloudUpload,
  FileImage,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  ImportBatch,
  ImportBatchCommit,
  ImportBatchRow,
  ImportExecutor,
} from '@shared/screenshot-import.interface';
import { fetchLocalAgents } from '@/api/local-agents';
import {
  cancelImportBatch,
  commitImportBatch,
  createImportBatch,
  editImportRow,
  fetchImportBatch,
  fetchImportBatches,
  IMPORT_QUERY_KEYS,
  previewImportBatch,
  recoverImportBatch,
  retryImportImage,
  reselectImportImage,
  startImportBatch,
  uploadImportImage,
} from '@/api/import-batches';
import {
  cleanAgentSettings,
  agentSettingsProblem,
} from '@/utils/local-agent-settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  loadScreenshotProvider,
  preferredScreenshotAgent,
  saveScreenshotProvider,
  screenshotImage,
  screenshotSelectionError,
} from './screenshot-import';
import { ImportSavedNextSteps } from './ImportSavedNextSteps';
const statusText: Record<string, string> = {
  draft: '等待你选好截图',
  queued: '已排队，马上开始',
  running: '股友正在认真看图',
  paused: '需要你帮个小忙',
  completed: '这组截图看完啦',
  cancelled: '已停止',
  failed: '这张需要再试一次',
  unknown: '正在核对原任务状态',
};
const stateActive = (batch?: ImportBatch | null) =>
  batch && ['queued', 'running'].includes(batch.status);
const pending = (row: ImportBatchRow) =>
  row.confirmed && row.committedRevision !== row.revision;
const errorText = (error: unknown) => {
  const code =
    (
      error as {
        response?: {
          data?: {
            message?: string;
            error?: { message?: string };
          };
        };
      }
    )?.response?.data?.error?.message ??
    (error as { response?: { data?: { message?: string } } })?.response?.data
      ?.message ??
    '';
  const labels: Record<string, string> = {
    HOLDINGS_CHANGED: '持仓刚刚有了变化，已刷新差异，请核对后再保存。',
    BATCH_CHANGED: '又有新的识别结果到了，已为你刷新，请再点一次。',
    IMAGE_EXPIRED_RESELECT: '这张原图已过期，请重新选择这张截图。',
    ROWS_REQUIRE_REVIEW: '还有持仓没有核对好，请先确认数量、成本与冲突。',
    TASK_STATUS_UNKNOWN: '原任务的状态还没有确认。先查询原任务，不会重复识别。',
    IDEMPOTENCY_CONFLICT: '这次保存的内容发生了变化，请刷新核对。',
  };
  return labels[code] ?? '这一步暂时没完成，已保留你的核对内容，请再试一次。';
};
const readImage = (file: File) =>
  new Promise<ReturnType<typeof screenshotImage>>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(screenshotImage(file, String(reader.result)));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('INVALID_IMAGE'));
    reader.readAsDataURL(file);
  });
export default function ScreenshotImport({
  onSavePendingChange,
}: { onSavePendingChange?: (pending: boolean) => void } = {}) {
  const { t, i18n } = useTranslation(),
    zh = i18n.language.startsWith('zh'),
    navigate = useNavigate(),
    queryClient = useQueryClient();
  const copy = (cn: string, en: string) => (zh ? cn : en);
  const agentsQuery = useQuery({
    queryKey: ['settings', 'local-agents'],
    queryFn: fetchLocalAgents,
    refetchInterval: 10000,
  });
  const recent = useQuery({
    queryKey: ['import', 'batches'],
    queryFn: fetchImportBatches,
  });
  const [id, setId] = useState<string | null>(null),
    [fresh, setFresh] = useState(false),
    [files, setFiles] = useState<File[]>([]);
  const [executor, setExecutor] = useState<'local' | 'vision'>('local'),
    [agentId, setAgentId] = useState(''),
    [agentModel, setAgentModel] = useState('');
  const [provider, setProvider] = useState({
    baseUrl: '',
    model: '',
    apiKey: '',
  });
  const [busy, setBusy] = useState(false),
    [uploadCount, setUploadCount] = useState(0),
    [error, setError] = useState('');
  const [savedBatchId, setSavedBatchId] = useState<string | null>(null);
  const [saveUnknown, setSaveUnknown] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Partial<ImportBatchRow>>>(
    {},
  );
  const commitRequest = useRef<{
    batchId: string;
    input: ImportBatchCommit;
  } | null>(null),
    creatingId = useRef<string | null>(null),
    fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setProvider(loadScreenshotProvider(localStorage));
  }, []);
  useEffect(() => {
    if (!id && !fresh && recent.data?.length) setId(recent.data[0].id);
  }, [recent.data, id, fresh]);
  const batchQuery = useQuery({
    queryKey: ['import', 'batch', id],
    queryFn: () => fetchImportBatch(id!),
    enabled: !!id,
    refetchInterval: (query) =>
      stateActive(query.state.data as ImportBatch | undefined) ? 1500 : false,
  });
  const batch = batchQuery.data;
  const saveLocked = busy || saveUnknown;
  const preview = useQuery({
    queryKey: ['import', 'preview', id, batch?.revision],
    queryFn: () => previewImportBatch(id!),
    enabled: !!id && !!batch?.rows.length,
  });
  const selectedAgent =
    agentsQuery.data?.find((agent) => agent.id === agentId) ??
    preferredScreenshotAgent(agentsQuery.data ?? []);
  const settings = cleanAgentSettings({ model: agentModel });
  const ready =
    executor === 'local'
      ? !!selectedAgent && !agentSettingsProblem(settings, selectedAgent)
      : !!provider.model.trim() && !!provider.apiKey.trim();
  const refresh = async () => {
    await Promise.all([batchQuery.refetch(), recent.refetch()]);
  };
  const accept = (value: ImportBatch) => {
    setId(value.id);
    queryClient.setQueryData(['import', 'batch', value.id], value);
  };
  const action = async (run: () => Promise<void>, recoveringSave = false) => {
    if (busy || (commitRequest.current && !recoveringSave)) return;
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (failure) {
      setError(errorText(failure));
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const route = (): ImportExecutor =>
    executor === 'local'
      ? {
          executor: 'local',
          agentId: selectedAgent!.id,
          agentSettings: settings,
        }
      : { executor: 'vision', ...provider };
  const upload = () =>
    action(async () => {
      const batchId = creatingId.current ?? crypto.randomUUID();
      creatingId.current = batchId;
      let current = await createImportBatch({ id: batchId, executor: route() });
      accept(current);
      setFresh(false);
      setUploadCount(0);
      for (let index = 0; index < files.length; index++) {
        const file = files[index],
          image = await readImage(file);
        current = await uploadImportImage(batchId, {
          id: crypto.randomUUID(),
          filename: file.name,
          image,
        });
        accept(current);
        setUploadCount(index + 1);
      }
      if (executor === 'vision') saveScreenshotProvider(localStorage, provider);
      accept(await startImportBatch(batchId));
      setFiles([]);
      creatingId.current = null;
      await recent.refetch();
    });
  const saveRow = (row: ImportBatchRow) =>
    action(async () => {
      const latest = await fetchImportBatch(id!);
      accept(
        await editImportRow(
          id!,
          row.id,
          { ...drafts[row.id], confirmed: true },
          latest.revision,
        ),
      );
      setDrafts((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      commitRequest.current = null;
    });
  const confirmAll = () =>
    action(async () => {
      let current = await fetchImportBatch(id!);
      for (const row of current.rows.filter(
        (row) =>
          !row.confirmed &&
          !row.issues?.length &&
          !row.conflicts?.length &&
          !drafts[row.id],
      ))
        current = await editImportRow(
          id!,
          row.id,
          { confirmed: true },
          current.revision,
        );
      accept(current);
      commitRequest.current = null;
    });
  const commit = (analyze: boolean) =>
    action(async () => {
      if (!commitRequest.current && (!batch || !preview.data || !id)) return;
      if (
        commitRequest.current &&
        commitRequest.current.input.analyze !== analyze
      ) return;
      commitRequest.current ??= {
        batchId: id!,
        input: {
          requestKey: crypto.randomUUID(),
          expectedRevision: batch!.revision,
          holdingsRevision: preview.data!.holdingsRevision,
          rowIds: batch!.rows.filter(pending).map((row) => row.id),
          analyze,
        },
      };
      const original = commitRequest.current;
      onSavePendingChange?.(true);
      let sent = false;
      try {
        // A batch read may already contain the durable receipt after a lost response.
        const latest = saveUnknown
          ? await fetchImportBatch(original.batchId)
          : undefined;
        const prior = latest?.receipts.find(
          receipt => receipt.requestKey === original.input.requestKey,
        );
        if (latest) accept(latest);
        const receipt = prior ?? await (async () => {
          sent = true;
          return commitImportBatch(original.batchId, original.input);
        })();
        setSavedBatchId(original.batchId);
        commitRequest.current = null;
        setSaveUnknown(false);
        onSavePendingChange?.(false);
        for (const queryKey of IMPORT_QUERY_KEYS)
          await queryClient.invalidateQueries({ queryKey: [...queryKey] });
        toast.success(
          copy(
            `已保存 ${receipt.created + receipt.updated} 只持仓`,
            'Your holdings are saved',
          ),
        );
        await refresh();
        if (original.input.analyze) navigate('/research/portfolio');
      } catch (failure) {
        const status = (
          failure as {
            response?: {
              status?: number;
            };
          }
        )?.response?.status;
        if (
          sent && status && status >= 400 && status < 500 &&
          status !== 408 && status !== 429
        ) {
          commitRequest.current = null;
          setSaveUnknown(false);
          onSavePendingChange?.(false);
        } else if (commitRequest.current) {
          setSaveUnknown(true);
        }
        throw failure;
      }
    }, true);
  const changeDraft = (row: ImportBatchRow, patch: Partial<ImportBatchRow>) =>
    !commitRequest.current && setDrafts((current) => ({
      ...current,
      [row.id]: { ...current[row.id], ...patch },
    }));
  const done =
    batch?.images.filter((image) =>
      ['completed', 'failed', 'cancelled'].includes(image.status),
    ).length ?? 0;
  const confirmed = batch?.rows.filter(pending).length ?? 0;
  return (
    <section className="min-w-0 space-y-5 rounded-3xl border border-border/60 bg-gradient-to-br from-emerald-50/60 via-background to-amber-50/50 p-4 dark:from-emerald-950/20 dark:to-amber-950/10 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-2xl dark:bg-emerald-900"
          >
            🦉
          </span>
          <div>
            <h2 className="text-lg font-semibold">
              {copy(
                '把截图交给股友，一起理清持仓',
                'Let’s sort your holdings together',
              )}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {copy(
                '看完一张就能核对一张，离开页面也会继续。',
                'Review each image as it finishes. Work continues when you leave.',
              )}
            </p>
          </div>
        </div>
        {batch && (
          <Button
            variant="outline"
            size="sm"
            disabled={saveLocked}
            onClick={() => {
              if (commitRequest.current) return;
              setId(null);
              setFresh(true);
              setDrafts({});
              setFiles([]);
              creatingId.current = null;
              commitRequest.current = null;
            }}
          >
            {copy('新的一组截图', 'New batch')}
          </Button>
        )}
      </div>
      {!!recent.data?.length && (
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <Clock3 size={15} />
          <span className="shrink-0">{copy('接着核对', 'Resume')}</span>
          <select
            className="h-9 min-w-0 flex-1 rounded-xl border bg-background px-2 text-sm"
            aria-label={copy('选择截图批次', 'Choose an image batch')}
            value={id ?? ''}
            disabled={saveLocked}
            onChange={(event) => {
              if (commitRequest.current) return;
              setId(event.target.value);
              setFresh(false);
              setDrafts({});
              commitRequest.current = null;
            }}
          >
            <option value="">
              {copy('选择之前的截图', 'Choose an earlier batch')}
            </option>
            {recent.data.map((item) => (
              <option key={item.id} value={item.id}>
                {new Date(item.createdAt).toLocaleString()} ·{' '}
                {item.images.length} {copy('张', 'images')} ·{' '}
                {copy(statusText[item.status] ?? item.status, item.status)}
              </option>
            ))}
          </select>
        </label>
      )}
      {!batch && (
        <>
          <div className="space-y-3 rounded-2xl border border-dashed border-emerald-300/70 bg-background/70 p-6 text-center">
            <CloudUpload className="mx-auto mb-2 text-emerald-600" size={32} />
            <p className="font-medium">
              {copy(
                '一次选好同一账户的持仓截图',
                'Choose holdings images from one account',
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {copy(
                '最多20张，支持 PNG、JPG、WebP。重叠的持仓不会重复相加。',
                'Up to 20 PNG, JPG or WebP images. Overlapping rows are never added twice.',
              )}
            </p>
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <Camera size={16} className="mr-2" />
              {copy('选择截图', 'Choose screenshots')}
            </Button>
            <input
              ref={fileRef}
              className="hidden"
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const selected = Array.from(event.target.files ?? []),
                  problem = screenshotSelectionError(selected);
                if (problem) {
                  setError(
                    copy(
                      '请选1–20张清晰截图，单张不超过8MB，总计不超过160MB。',
                      'Choose 1–20 images, up to 8MB each and 160MB total.',
                    ),
                  );
                } else {
                  setFiles(selected);
                  setError('');
                }
                event.target.value = '';
              }}
            />
            {files.length > 0 && (
              <p className="text-sm text-emerald-700 dark:text-emerald-300">
                {copy(
                  `选好了 ${files.length} 张`,
                  `${files.length} images ready`,
                )}
              </p>
            )}
          </div>
          <details
            className="rounded-2xl border bg-background/70 p-4"
            open={!selectedAgent}
          >
            <summary className="cursor-pointer text-sm font-medium">
              {copy('请这位股友帮忙', 'Choose your helper')} ·{' '}
              {executor === 'local'
                ? (selectedAgent?.name ?? copy('本地连接', 'Local connection'))
                : copy('自选视觉模型', 'Your vision model')}{' '}
              <ChevronDown className="inline" size={14} />
            </summary>
            <fieldset
              className="mt-4 grid gap-3 sm:grid-cols-2"
              disabled={busy}
            >
              <div className="space-y-1">
                <Label htmlFor="screenshot-executor">
                  {copy('识别来源', 'Recognition source')}
                </Label>
                <select
                  id="screenshot-executor"
                  className="h-10 w-full rounded-xl border bg-background px-3"
                  value={executor}
                  onChange={(event) =>
                    setExecutor(event.target.value as 'local' | 'vision')
                  }
                >
                  <option value="local">
                    {copy('已连接的本地股友', 'Connected local helper')}
                  </option>
                  <option value="vision">
                    {copy('我自己的视觉API', 'My own vision API')}
                  </option>
                </select>
              </div>
              {executor === 'local' ? (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="screenshot-agent">
                      {copy('股友', 'Helper')}
                    </Label>
                    <select
                      id="screenshot-agent"
                      className="h-10 w-full rounded-xl border bg-background px-3"
                      value={selectedAgent?.id ?? ''}
                      onChange={(event) => setAgentId(event.target.value)}
                    >
                      <option value="">
                        {copy('选择股友', 'Choose helper')}
                      </option>
                      {agentsQuery.data
                        ?.filter((agent) => agent.connected && agent.imageInput)
                        .map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                            {agent.busy
                              ? copy(' · 正在忙，会排队', ' · busy')
                              : ''}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="screenshot-model">
                      {copy(
                        '使用的模型（留空沿用设置）',
                        'Model (leave empty to use settings)',
                      )}
                    </Label>
                    <Input
                      id="screenshot-model"
                      value={agentModel}
                      onChange={(event) => setAgentModel(event.target.value)}
                      list="screenshot-models"
                    />
                    <datalist id="screenshot-models">
                      {selectedAgent?.models?.map((model) => (
                        <option key={model.id} value={model.id} />
                      ))}
                    </datalist>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="vision-model">
                      {t('import.visionModel')}
                    </Label>
                    <Input
                      id="vision-model"
                      value={provider.model}
                      onChange={(event) =>
                        setProvider({ ...provider, model: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="vision-url">
                      {t('import.apiEndpoint')}
                    </Label>
                    <Input
                      id="vision-url"
                      value={provider.baseUrl}
                      onChange={(event) =>
                        setProvider({
                          ...provider,
                          baseUrl: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="vision-key">{t('import.apiKey')}</Label>
                    <Input
                      id="vision-key"
                      type="password"
                      autoComplete="off"
                      value={provider.apiKey}
                      onChange={(event) =>
                        setProvider({ ...provider, apiKey: event.target.value })
                      }
                    />
                  </div>
                </>
              )}
            </fieldset>
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy || !files.length || !ready} onClick={upload}>
              {busy ? (
                <Loader2 className="mr-2 animate-spin" size={16} />
              ) : (
                <Sparkles className="mr-2" size={16} />
              )}{' '}
              {busy
                ? copy(
                    `已上传 ${uploadCount}/${files.length} 张`,
                    `Uploaded ${uploadCount}/${files.length}`,
                  )
                : copy('开始整理截图', 'Read my screenshots')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {copy(
                '原图仅在本机保留24小时，结果和核对记录会保存。',
                'Images stay on this computer for 24 hours. Results and edits are kept.',
              )}
            </p>
          </div>
        </>
      )}
      {batch && (
        <>
          <div className="rounded-2xl bg-background/80 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {stateActive(batch) ? (
                  <Loader2
                    size={18}
                    className="animate-spin text-emerald-600"
                  />
                ) : (
                  <CheckCircle2 size={18} className="text-emerald-600" />
                )}
                <p className="font-medium">
                  {copy(statusText[batch.status] ?? batch.status, batch.status)}
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                {copy(
                  `已处理 ${done}/${batch.images.length} 张 · 认出 ${batch.rows.length} 只持仓`,
                  `${done}/${batch.images.length} images · ${batch.rows.length} holdings`,
                )}
              </p>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {batch.images.map((image) => (
                <div
                  key={image.id}
                  className="flex min-w-0 items-center gap-3 rounded-xl border border-border/60 p-3"
                >
                  <FileImage
                    size={20}
                    className="shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" title={image.filename}>
                      {image.filename}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {copy(
                        statusText[image.status] ??
                          (image.status === 'completed'
                            ? '看好啦'
                            : image.status === 'queued'
                              ? '等股友看图'
                              : image.status === 'running'
                                ? '正在看图'
                                : image.status),
                        image.status,
                      )}
                      {image.rowCount !== undefined
                        ? copy(
                            ` · ${image.rowCount} 行，可核对${image.problemCount ? `，${image.problemCount}行不清楚` : ''}`,
                            ` · ${image.rowCount} rows, ${image.problemCount ?? 0} need review`,
                          )
                        : ''}
                      {!image.fileAvailable
                        ? copy(' · 原图已过期', ' · image expired')
                        : ''}
                    </p>
                    {image.error && (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        {image.error.includes('AUTH') ||
                        image.error.includes('LOGIN')
                          ? copy(
                              '请到设置重新连接这位股友',
                              'Reconnect this helper in settings',
                            )
                          : image.error.includes('UNSUPPORTED')
                            ? copy(
                                '这位股友目前看不了这张图',
                                'This helper cannot read this image',
                              )
                            : copy(
                                '识别没有完成，已保留其他结果',
                                'Recognition did not finish; other results are safe',
                              )}
                      </p>
                    )}
                  </div>
                  {image.status === 'failed' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={saveLocked || !image.fileAvailable}
                      aria-label={copy(
                        `只重试 ${image.filename}`,
                        `Retry ${image.filename} only`,
                      )}
                      onClick={() =>
                        action(async () =>
                          accept(await retryImportImage(id!, image.id)),
                        )
                      }
                    >
                      <RefreshCw size={14} />
                    </Button>
                  )}
                  {!image.fileAvailable &&
                    ['failed', 'cancelled'].includes(image.status) && (
                      <label className="relative cursor-pointer rounded-lg border px-2 py-2 text-xs focus-within:ring-2 focus-within:ring-ring">
                        {copy('重选并识别这张', 'Reselect this image')}
                        <input
                          className="absolute inset-0 w-full cursor-pointer opacity-0"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          disabled={saveLocked}
                          aria-label={copy(
                            `重新选择 ${image.filename}`,
                            `Reselect ${image.filename}`,
                          )}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file)
                              void action(async () =>
                                accept(
                                  await reselectImportImage(
                                    id!,
                                    image.id,
                                    await readImage(file),
                                  ),
                                ),
                              );
                          }}
                        />
                      </label>
                    )}
                </div>
              ))}
            </div>
            {batch.pauseReason && (
              <p
                role="status"
                className="mt-3 text-sm text-amber-700 dark:text-amber-300"
              >
                {batch.pauseReason === 'TASK_STATUS_UNKNOWN'
                  ? copy(
                      '先核对原任务是否结束，避免重复识别。',
                      'Check the original task before trying again.',
                    )
                  : copy(
                      '这组截图已暂停。修复连接或模型设置后，继续剩余截图。',
                      'This batch is paused. Fix the connection or model, then continue.',
                    )}{' '}
                <a href="/settings/agents" className="underline">
                  {copy('打开连接设置', 'Connection settings')}
                </a>
              </p>
            )}
            {batch.executor.executor === 'vision' &&
              batch.status === 'paused' && (
                <div className="mt-3 space-y-1">
                  <Label htmlFor="resume-vision-key">
                    {copy(
                      '重新填写你的API Key以继续（只保存在本次进程内）',
                      'Re-enter your API key to continue (kept in memory only)',
                    )}
                  </Label>
                  <Input
                    id="resume-vision-key"
                    type="password"
                    autoComplete="off"
                    value={provider.apiKey}
                    onChange={(event) =>
                      setProvider({ ...provider, apiKey: event.target.value })
                    }
                  />
                </div>
              )}
            <div className="mt-3 flex flex-wrap gap-2">
              {batch.status === 'draft' && (
                <Button
                  size="sm"
                  disabled={saveLocked || !batch.images.length}
                  onClick={() =>
                    action(async () => accept(await startImportBatch(id!)))
                  }
                >
                  {copy('先识别已上传的截图', 'Read uploaded images')}
                </Button>
              )}
              {batch.status === 'paused' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saveLocked}
                  onClick={() =>
                    action(async () =>
                      accept(
                        batch.images.some((image) => image.status === 'unknown')
                          ? await recoverImportBatch(id!)
                          : await startImportBatch(
                              id!,
                              batch.executor.executor === 'vision'
                                ? { ...batch.executor, apiKey: provider.apiKey }
                                : undefined,
                            ),
                      ),
                    )
                  }
                >
                  {copy(
                    batch.images.some((image) => image.status === 'unknown')
                      ? '查询原任务'
                      : '继续剩余截图',
                    batch.images.some((image) => image.status === 'unknown')
                      ? 'Check original task'
                      : 'Continue remaining',
                  )}
                </Button>
              )}
              {stateActive(batch) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saveLocked}
                  onClick={() =>
                    action(async () => accept(await cancelImportBatch(id!)))
                  }
                >
                  {copy('停止这组识别', 'Stop this batch')}
                </Button>
              )}
            </div>
          </div>
          {!!batch.rows.length && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-semibold">
                    {copy(
                      '一起核对，保存你确认的部分',
                      'Review and save the holdings you trust',
                    )}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {copy(
                      '已有持仓会更新数量和成本，截图里没有的持仓会保留。',
                      'Existing quantities and costs will update. Unmentioned holdings stay as they are.',
                    )}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saveLocked}
                  onClick={confirmAll}
                >
                  {copy('确认没有疑问的行', 'Confirm clear rows')}
                </Button>
              </div>
              {batch.rows.map((row, index) => {
                const value = { ...row, ...drafts[row.id] },
                  change = preview.data?.changes.find(
                    (change) => change.rowId === row.id,
                  ),
                  saved =
                    row.committedRevision === row.revision &&
                    row.committedRevision !== undefined;
                return (
                  <article
                    key={row.id}
                    className={`rounded-2xl border bg-background/90 p-4 ${row.conflicts?.length || row.issues?.length ? 'border-amber-300/70' : 'border-border/60'}`}
                  >
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-xs text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                          {index + 1}
                        </span>
                        {value.company ||
                          value.ticker ||
                          copy('这行还没看清', 'Needs a closer look')}
                        <span className="text-xs font-normal text-muted-foreground">
                          {saved
                            ? copy('已保存', 'Saved')
                            : row.confirmed
                              ? copy('已核对', 'Reviewed')
                              : copy('待核对', 'Review')}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {row.sourceImageIds
                          .map(
                            (source) =>
                              batch.images.find((image) => image.id === source)
                                ?.filename ?? source,
                          )
                          .join(' · ')}
                      </p>
                    </div>
                    {row.issues?.length > 0 && (
                      <p className="mb-3 text-xs text-amber-700 dark:text-amber-300">
                        {copy(
                          '这几个字段没看清，请对照截图填写：',
                          'Please correct these fields: ',
                        )}
                        {row.issues
                          .map(
                            (issue) =>
                              ({
                                ticker: copy('代码', 'ticker'),
                                shares: copy('数量', 'quantity'),
                                avgCost: copy('成本', 'cost'),
                                currency: copy('币种', 'currency'),
                              })[issue.field] ?? issue.field,
                          )
                          .join('、')}
                        {row.raw && (
                          <span>
                            {' '}
                            · {JSON.stringify(row.raw).slice(0, 240)}
                          </span>
                        )}
                      </p>
                    )}
                    {!!row.conflicts?.length && (
                      <div className="mb-3 space-y-1 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                        {row.conflicts.map((conflict) => (
                          <p key={conflict.field}>
                            {copy(
                              '截图之间不一致，请选定或填写正确值：',
                              'Screenshots disagree; choose or type the correct value: ',
                            )}
                            {conflict.field}{' '}
                            {conflict.candidates.map(
                              (candidate, candidateIndex) => (
                                <button
                                  key={candidateIndex}
                                  className="mx-1 rounded border border-amber-400 px-2 py-1"
                                  disabled={saveLocked}
                                  onClick={() =>
                                    changeDraft(row, {
                                      [conflict.field]: candidate.value,
                                    })
                                  }
                                >
                                  {String(candidate.value ?? '—')} ·{' '}
                                  {candidate.sourceImageIds
                                    .map(
                                      (source) =>
                                        batch.images.find(
                                          (image) => image.id === source,
                                        )?.filename,
                                    )
                                    .join(', ')}
                                </button>
                              ),
                            )}
                          </p>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                      {(
                        [
                          'ticker',
                          'company',
                          'shares',
                          'avgCost',
                          'currentPrice',
                        ] as const
                      ).map((field) => (
                        <div className="min-w-0 space-y-1" key={field}>
                          <Label
                            className="text-xs"
                            htmlFor={`import-${row.id}-${field}`}
                          >
                            {field === 'ticker'
                              ? t('import.ticker')
                              : field === 'company'
                                ? t('import.company')
                                : field === 'shares'
                                  ? t('import.shares')
                                  : field === 'currentPrice'
                                    ? copy('截图现价', 'Screenshot price')
                                    : t('import.avgCost')}
                          </Label>
                          <Input
                            id={`import-${row.id}-${field}`}
                            disabled={saveLocked}
                            value={value[field] ?? ''}
                            inputMode={
                              ['shares', 'avgCost', 'currentPrice'].includes(
                                field,
                              )
                                ? 'decimal'
                                : undefined
                            }
                            onChange={(event) =>
                              changeDraft(row, {
                                [field]:
                                  (field === 'avgCost' ||
                                    field === 'currentPrice') &&
                                  event.target.value === ''
                                    ? null
                                    : event.target.value,
                              })
                            }
                          />
                        </div>
                      ))}
                      <div className="space-y-1">
                        <Label
                          className="text-xs"
                          htmlFor={`import-${row.id}-market`}
                        >
                          {copy('市场', 'Market')}
                        </Label>
                        <select
                          id={`import-${row.id}-market`}
                          className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                          value={value.market ?? ''}
                          disabled={saveLocked}
                          onChange={(event) =>
                            changeDraft(row, {
                              market: event.target.value
                                ? (event.target.value as 'US' | 'HK' | 'CN')
                                : undefined,
                            })
                          }
                        >
                          <option value="">
                            {copy('按代码识别', 'From ticker')}
                          </option>
                          <option value="US">{copy('美股', 'US')}</option>
                          <option value="HK">{copy('港股', 'HK')}</option>
                          <option value="CN">{copy('A股', 'CN')}</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label
                          className="text-xs"
                          htmlFor={`import-${row.id}-currency`}
                        >
                          {copy('币种', 'Currency')}
                        </Label>
                        <select
                          id={`import-${row.id}-currency`}
                          className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                          value={value.currency ?? ''}
                          disabled={saveLocked}
                          onChange={(event) =>
                            changeDraft(row, {
                              currency: event.target.value || null,
                            })
                          }
                        >
                          <option value="">
                            {copy(
                              '请选择并确认币种',
                              'Choose and confirm currency',
                            )}
                          </option>
                          {['USD', 'HKD', 'CNY'].map((currency) => (
                            <option key={currency} value={currency}>
                              {currency}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">
                        {change?.kind === 'update'
                          ? copy(
                              `更新持仓：数量 ${change.before?.shares} → ${row.shares}，成本 ${change.before?.avgCost ?? '—'} → ${row.avgCost ?? '—'}`,
                              `Update: quantity ${change.before?.shares} → ${row.shares}, cost ${change.before?.avgCost ?? '—'} → ${row.avgCost ?? '—'}`,
                            )
                          : change?.kind === 'new'
                            ? copy('新增到你的持仓', 'Add to your holdings')
                            : change?.kind === 'unchanged'
                              ? copy(
                                  '与现有持仓一致',
                                  'Matches your current holding',
                                )
                              : copy(
                                  '请补全并核对',
                                  'Complete and review this row',
                                )}
                      </p>
                      <Button
                        size="sm"
                        variant={
                          row.confirmed && !drafts[row.id] ? 'ghost' : 'outline'
                        }
                        disabled={saveLocked || (saved && !drafts[row.id])}
                        onClick={() => saveRow(row)}
                      >
                        <Check size={14} className="mr-1" />
                        {copy(
                          drafts[row.id]
                            ? '保存核对修改'
                            : row.confirmed
                              ? '重新确认'
                              : '这行核对好了',
                          drafts[row.id]
                            ? 'Save edits'
                            : row.confirmed
                              ? 'Confirm again'
                              : 'Looks right',
                        )}
                      </Button>
                    </div>
                  </article>
                );
              })}
              <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-background/95 p-4 shadow-sm backdrop-blur dark:border-emerald-900">
                <p className="text-sm">
                  {copy(
                    `这次保存 ${confirmed} 只已核对持仓`,
                    `${confirmed} reviewed holdings ready to save`,
                  )}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {copy(
                      '剩余截图和未核对行可以稍后继续。',
                      'You can finish the remaining images and rows later.',
                    )}
                  </span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={
                      busy ||
                      (!saveUnknown && (!confirmed || preview.isPending)) ||
                      commitRequest.current?.input.analyze === true
                    }
                    onClick={() => commit(false)}
                  >
                    {busy && <Loader2 size={15} className="mr-2 animate-spin" />}
                    {saveUnknown && commitRequest.current?.input.analyze === false
                      ? copy('核对本次保存结果', 'Check this save result')
                      : copy('保存持仓', 'Save holdings')}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      (!saveUnknown && (!confirmed || preview.isPending)) ||
                      commitRequest.current?.input.analyze === false
                    }
                    onClick={() => commit(true)}
                  >
                    <Sparkles size={15} className="mr-2" />
                    {saveUnknown && commitRequest.current?.input.analyze === true
                      ? copy('核对本次保存结果', 'Check this save result')
                      : copy('保存并开始研究', 'Save and start research')}
                  </Button>
                </div>
              </div>
            </div>
          )}
          {saveUnknown && (
            <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
              {copy(
                '先核对本次保存结果，再修改持仓或开始新的保存。',
                'Check this save result before editing holdings or starting another save.',
              )}
            </p>
          )}
          {!!batch.receipts.length && (
            <p
              role="status"
              className="text-xs text-emerald-700 dark:text-emerald-300"
            >
              {copy(
                `已经保存 ${batch.receipts.length} 次，完成的部分都在。`,
                `Saved ${batch.receipts.length} times. Your confirmed work is safe.`,
              )}
            </p>
          )}
          {(savedBatchId === id || !!batch.receipts.length) && <ImportSavedNextSteps />}
        </>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {error}
        </p>
      )}
    </section>
  );
}
