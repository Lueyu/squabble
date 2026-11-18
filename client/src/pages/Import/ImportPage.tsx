/**
 * @file pages/Import/ImportPage.tsx
 * @description Route `/import`: portfolio import hub.
 *
 * Three flows sharing one commit path:
 *  1. CSV 文件导入 — client-side parsing (papaparse) with encoding switch
 *     (UTF-8 / GBK for domestic brokers), auto column mapping with manual
 *     override, editable preview, then commit.
 *  2. Robinhood CSV — a preset over the same flow: known headers are mapped
 *     automatically.
 *  3. 截图识别导入 — upload a brokerage screenshot, extract rows with the
 *     connected image-capable agent or a transient vision API key, review
 *     the editable extraction, then explicitly confirm the import.
 *
 * Import history card lists recent runs with per-row failure reasons.
 */
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import Papa from 'papaparse';
import {
  FileSpreadsheet,
  Camera,
  History,
  Upload,
  Loader2,
  XCircle,
} from 'lucide-react';

import { fetchImportHistory } from '@/api';
import { confirmMappedImport, IMPORT_QUERY_KEYS } from '@/api/import-batches';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ImportRowCandidate } from '@shared/api.interface';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { ImportAccountBoundary } from '@/features/assets/AccountAssetsPage';
import ScreenshotImport from './ScreenshotImport';
import TransactionImport from './TransactionImport';
import { ImportSavedNextSteps } from './ImportSavedNextSteps';
import { OnboardingStepper } from '@/features/onboarding/OnboardingStepper';
import { workspaceOwnerScope } from '@/utils/workspace-tab-recovery';
import { readCsvImportRecovery, readScreenshotRecovery, saveCsvImportRecovery } from './import-continuation';

/** Field keys the CSV mapper can assign. */
type MapField = 'ticker' | 'shares' | 'avgCost' | 'company';

/** Header aliases used for auto-mapping suggestions. */
const FIELD_ALIASES: Record<MapField, string[]> = {
  ticker: [
    'ticker',
    'symbol',
    'code',
    '股票代码',
    '证券代码',
    '代码',
    'symbol(id)',
  ],
  shares: [
    'shares',
    'quantity',
    'qty',
    '股数',
    '持仓数量',
    '数量',
    '持有数量',
    '持仓',
  ],
  avgCost: [
    'avgcost',
    'averagecost',
    'avgcostbasis',
    'price',
    '成本价',
    '买入成本',
    '成本',
    '均价',
    '平均成本',
    '购买价',
  ],
  company: [
    'company',
    'name',
    'description',
    '名称',
    '证券名称',
    '股票名称',
    '描述',
  ],
};

/** Robinhood preset: map by exact known headers (case-insensitive contains). */
const ROBINHOOD_ALIASES: Record<MapField, string[]> = {
  ticker: ['symbol'],
  shares: ['quantity'],
  avgCost: ['average cost', 'avg cost'],
  company: ['description', 'name', 'instrument'],
};

/** Futu (富途牛牛) CSV preset. */
const FUTU_ALIASES: Record<MapField, string[]> = {
  ticker: ['代码', 'code', 'symbol', 'ticker'],
  shares: ['数量', '股数', 'qty', 'quantity', 'shares'],
  avgCost: ['成本价', '买入均价', '平均成本', 'cost', 'avg cost', 'price'],
  company: ['名称', '股票名称', 'name', 'company'],
};

/** Tiger (老虎证券) CSV preset. */
const TIGER_ALIASES: Record<MapField, string[]> = {
  ticker: ['symbol', '代码', 'ticker'],
  shares: ['quantity', '数量', '股数', 'shares'],
  avgCost: ['avg cost', '成本价', 'cost basis', '平均成本'],
  company: ['name', '名称', 'description'],
};

/** Xueqiu (雪球) CSV preset. */
const XUEQIU_ALIASES: Record<MapField, string[]> = {
  ticker: ['symbol', '代码', 'ticker'],
  shares: ['volume', '数量', '股数', 'shares', '持有数量'],
  avgCost: ['cost', '成本价', 'avg cost', '买入成本'],
  company: ['name', '名称', '股票名称'],
};

/** All broker presets keyed by selector value (labels translated at render). */
const BROKER_PRESETS: Record<
  string,
  { labelKey: string; aliases: Record<MapField, string[]> }
> = {
  generic: { labelKey: 'import.generic', aliases: FIELD_ALIASES },
  robinhood: { labelKey: 'import.robinhood', aliases: ROBINHOOD_ALIASES },
  futu: { labelKey: 'import.futu', aliases: FUTU_ALIASES },
  tiger: { labelKey: 'import.tiger', aliases: TIGER_ALIASES },
  xueqiu: { labelKey: 'import.xueqiu', aliases: XUEQIU_ALIASES },
};

function suggestForPreset(
  headers: string[],
  presetKey: string,
): Partial<Record<MapField, number>> {
  const aliases = BROKER_PRESETS[presetKey]?.aliases ?? FIELD_ALIASES;
  const out: Partial<Record<MapField, number>> = {};
  const used = new Set<number>();
  for (const field of Object.keys(aliases) as MapField[]) {
    for (let i = 0; i < headers.length; i++) {
      if (used.has(i)) continue;
      const h = headers[i].toLowerCase().replace(/\s+/g, '');
      if (
        field === 'avgCost' &&
        /^(totalcost|costbasis|总成本|成本总额)/.test(h)
      )
        continue;
      if (
        aliases[field].some((a) => {
          const normalized = a.toLowerCase().replace(/\s+/g, '');
          return h === normalized || h.includes(normalized);
        })
      ) {
        out[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return out;
}

/** Turn mapped CSV cells into import row candidates. */
function rowsFromMatrix(
  matrix: string[][],
  mapping: Partial<Record<MapField, number>>,
): ImportRowCandidate[] {
  const has = (v?: string) => v != null && v.trim() !== '';
  const num = (v?: string) => {
    if (!has(v)) return null;
    const n = Number(String(v).replace(/[,$￥HK$]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  return matrix
    .map((cells) => ({
      ticker:
        mapping.ticker != null
          ? String(cells[mapping.ticker] ?? '').trim()
          : '',
      company:
        mapping.company != null && has(cells[mapping.company])
          ? String(cells[mapping.company]).trim()
          : null,
      shares:
        num(mapping.shares != null ? cells[mapping.shares] : undefined) ?? 0,
      avgCost: num(
        mapping.avgCost != null ? cells[mapping.avgCost] : undefined,
      ),
    }))
    .filter((r) => r.ticker !== '');
}

/** localStorage helpers for screenshot settings live in screenshot-import.ts. */

function ImportPage() {
  return <ImportAccountBoundary><RealImportPage /></ImportAccountBoundary>;
}

function RealImportPage() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params] = useSearchParams();
  const onboarding = params.get('onboarding') === '1';
  const [mode, setMode] = useState<'csv' | 'ocr'>(() => {
    if (readScreenshotRecovery()) return 'ocr';
    return onboarding || readCsvImportRecovery()?.kind === 'pending' ? 'csv' : 'ocr';
  });
  const [savePending, setSavePending] = useState(() =>
    readCsvImportRecovery()?.kind === 'pending' || Boolean(readScreenshotRecovery()));
  return (
    <div className="space-y-4">
      {onboarding && <OnboardingStepper step="holdings" zh={zh} />}
      <div>
        <h1 className={onboarding ? 'text-2xl font-semibold sm:text-3xl' : 'flex items-center gap-2 font-serif text-2xl font-semibold'}>
          {!onboarding && <Upload size={22} className="text-primary" />}
          {onboarding ? (zh ? '导入我的持仓' : 'Import my holdings') : t('import.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {onboarding ? (zh ? '选择券商导出的持仓文件，核对后保存到我的实仓。' : 'Choose a file from your broker and review it before saving to your real portfolio.') : t('import.subtitle')}
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          variant={mode === 'csv' ? 'default' : 'outline'}
          size="sm"
          disabled={savePending}
          onClick={() => setMode('csv')}
        >
          <FileSpreadsheet size={14} className="mr-1" /> {t('import.csvFile')}
        </Button>
        <Button
          variant={mode === 'ocr' ? 'default' : 'outline'}
          size="sm"
          disabled={savePending}
          onClick={() => setMode('ocr')}
        >
          <Camera size={14} className="mr-1" /> {t('import.screenshot')}
        </Button>
      </div>

      {mode === 'csv' ? (
        <CsvImport onSavePendingChange={setSavePending} onboarding={onboarding} />
      ) : (
        <ScreenshotImport onSavePendingChange={setSavePending} onboarding={onboarding} />
      )}
      {!onboarding && <><TransactionImport /><ImportHistoryCard /></>}
    </div>
  );
}

// ---------------------------------------------------------------------
// CSV flow
// ---------------------------------------------------------------------

function CsvImport({
  onSavePendingChange,
  onboarding = false,
}: { onSavePendingChange?: (pending: boolean) => void; onboarding?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const zh = i18n.language.startsWith('zh');
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [recovery] = useState(readCsvImportRecovery);
  const [filename, setFilename] = useState(recovery?.kind === 'pending' ? recovery.input.filename ?? '' : recovery?.filename ?? '');
  const [headers, setHeaders] = useState<string[]>([]);
  const [matrix, setMatrix] = useState<string[][]>([]);
  const [encoding, setEncoding] = useState<'utf-8' | 'gbk'>('utf-8');
  const [mapping, setMapping] = useState<Partial<Record<MapField, number>>>({});
  const [buyDate, setBuyDate] = useState('');
  const [source, setSource] = useState<string>('generic');
  const [committing, setCommitting] = useState(false);
  const [saveUnknown, setSaveUnknown] = useState(recovery?.kind === 'pending');
  const [result, setResult] = useState<Awaited<ReturnType<typeof confirmMappedImport>> | null>(
    onboarding && recovery?.kind === 'saved' ? recovery.result : null,
  );
  const requestIntent = useRef<Parameters<
    typeof confirmMappedImport
  >[0] | null>(recovery?.kind === 'pending' ? recovery.input : null);
  const inFlight = useRef(false);
  const saveLocked = committing || saveUnknown;

  const readFile = (file: File) => {
    if (requestIntent.current) return;
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (requestIntent.current) return;
      const text = String(reader.result ?? '');
      const parsed = Papa.parse<string[]>(text, {
        header: false,
        skipEmptyLines: true,
      });
      const data = (parsed.data as string[][]).filter((r) =>
        r.some((c) => String(c).trim() !== ''),
      );
      if (data.length === 0) {
        toast.warning(t('ui.import.noDataRows'));
        return;
      }
      const hdrs = (data[0] ?? []).map(
        (h, i) =>
          String(h).trim() || t('ui.import.columnNumber', { number: i + 1 }),
      );
      const body = data.slice(1);
      saveCsvImportRecovery(null);
      setFilename(file.name);
      setHeaders(hdrs);
      setMatrix(body);
      setMapping(suggestForPreset(hdrs, source));
      if (String(text).includes('\uFFFD')) {
        toast.info(t('import.detectedGibberish'));
      }
    };
    reader.readAsText(file, encoding);
  };

  const previewRows = requestIntent.current?.rows ?? rowsFromMatrix(matrix, mapping);

  const commit = async (analyze = false) => {
    if (
      inFlight.current ||
      (requestIntent.current && requestIntent.current.analyze !== analyze)
    ) return;
    if (previewRows.length === 0) {
      toast.warning(t('import.noRows'));
      return;
    }
    const owner = workspaceOwnerScope();
    const input = requestIntent.current ?? {
        source: source === 'robinhood' ? 'robinhood' : 'csv',
        rows: previewRows,
        filename: filename || undefined,
        buyDate: buyDate || undefined,
        analyze,
        requestKey: crypto.randomUUID(),
    } as const;
    if (!saveCsvImportRecovery({ kind: 'pending', input }) && onboarding && !requestIntent.current) {
      toast.error(zh ? '无法在此浏览器保留保存回执。请启用会话存储后重试。' : 'This browser could not retain the save request. Enable session storage and retry.');
      return;
    }
    requestIntent.current = input;
    try {
      inFlight.current = true;
      setCommitting(true);
      onSavePendingChange?.(true);
      const r = await confirmMappedImport(input);
      if (workspaceOwnerScope() !== owner) return;
      saveCsvImportRecovery({ kind: 'saved', result: r, filename: input.filename });
      requestIntent.current = null;
      setSaveUnknown(false);
      onSavePendingChange?.(false);
      setResult(r);
      toast.success(
        t('import.importComplete', { created: r.created, skipped: r.skipped }),
      );
      for (const queryKey of IMPORT_QUERY_KEYS)
        await queryClient.invalidateQueries({ queryKey: [...queryKey] });
      if (input.analyze) navigate('/research/portfolio');
    } catch (error) {
      if (workspaceOwnerScope() !== owner) return;
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (
        status && status >= 400 && status < 500 &&
        status !== 408 && status !== 429
      ) {
        saveCsvImportRecovery(null);
        requestIntent.current = null;
        setSaveUnknown(false);
        onSavePendingChange?.(false);
      } else if (requestIntent.current) {
        setSaveUnknown(true);
      }
      toast.error(
        (error as { response?: { data?: { message?: string } } })?.response
          ?.data?.message ?? t('import.importFailed'),
      );
    } finally {
      inFlight.current = false;
      setCommitting(false);
    }
  };

  const hasReview = matrix.length > 0 || saveUnknown;
  const canSave = !committing && (saveUnknown || (mapping.ticker != null && mapping.shares != null));
  const mappingFields = (
    <div className="grid gap-3 md:grid-cols-4">
      {(['ticker', 'shares', 'avgCost', 'company'] as MapField[]).map(field => (
        <label key={field} className="space-y-1.5 text-xs">
          <span>{t(`import.${field}`)}</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={mapping[field] ?? ''}
            disabled={saveLocked}
            onChange={e => !requestIntent.current && setMapping(prev => ({
              ...prev, [field]: e.target.value === '' ? undefined : Number(e.target.value),
            }))}
          >
            <option value="">{t('import.noMapping')}</option>
            {headers.map((label, index) => <option key={index} value={index}>{label}</option>)}
          </select>
        </label>
      ))}
    </div>
  );

  return <div className="space-y-4">
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{onboarding ? (zh ? '表格文件' : 'Spreadsheet file') : t('import.csvImport')}</CardTitle>
        {filename && <Badge variant="secondary" className="text-primary">{zh ? '已读取' : 'File read'}</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        {filename ? <p className="break-all font-medium">{filename}</p> : <p className="text-sm text-muted-foreground">{t('import.uploadHint')}</p>}
        {hasReview && <p className="text-xs text-muted-foreground">
          {previewRows.length} {zh ? '条待核对持仓' : 'positions to review'}
        </p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={saveLocked} onClick={() => fileRef.current?.click()}>
            {filename ? (zh ? '重新选择文件' : 'Choose another file') : t('import.selectFile')}
          </Button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" disabled={saveLocked}
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) readFile(file);
              e.target.value = '';
            }}
          />
          {(!onboarding || !filename) && <>
            <select aria-label={zh ? '券商' : 'Broker'} className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
              value={source} disabled={saveLocked} onChange={e => {
                if (requestIntent.current) return;
                const preset = e.target.value;
                setSource(preset);
                if (headers.length) setMapping(suggestForPreset(headers, preset));
              }}>
              {Object.entries(BROKER_PRESETS).map(([key, item]) => <option key={key} value={key}>{t(item.labelKey)}</option>)}
            </select>
            <select aria-label={zh ? '文件编码' : 'File encoding'} className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
              value={encoding} disabled={saveLocked} onChange={e => {
                if (!requestIntent.current) setEncoding(e.target.value === 'gbk' ? 'gbk' : 'utf-8');
              }}>
              <option value="utf-8">UTF-8</option><option value="gbk">{t('import.gbkNote')}</option>
            </select>
          </>}
        </div>
      </CardContent>
    </Card>

    {hasReview && (!result || !onboarding) && <Card>
      <CardHeader><CardTitle>{zh ? '核对持仓' : 'Review holdings'}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{zh ? '目标账户 · 我的实仓' : 'Destination · Real portfolio'}</p>
        {matrix.length > 0 && (onboarding
          ? <details open={mapping.ticker == null || mapping.shares == null} className="space-y-3">
              <summary className="cursor-pointer text-sm text-muted-foreground">{zh ? '检查列对应关系和起始日期' : 'Check column mapping and start date'}</summary>
              {mappingFields}
              <Label className="grid w-fit gap-1 text-xs">{t('import.buyDate')}<Input type="date" className="h-9 w-40" value={buyDate} disabled={saveLocked} onChange={e => {
                if (!requestIntent.current) setBuyDate(e.target.value);
              }} /></Label>
            </details>
          : mappingFields)}
        <ul className="max-h-72 divide-y overflow-auto border-y">
          {previewRows.slice(0, 20).map((row, index) => <li key={index} className="flex items-start justify-between gap-3 py-3 text-sm">
            <div className="min-w-0">
              <p className="break-words font-medium">{row.company || row.ticker}</p>
              {row.company && <p className="break-all text-xs text-muted-foreground">{row.ticker}</p>}
            </div>
            <div className="shrink-0 text-right">
              <p className="tabular-nums">{row.shares} {zh ? '股' : 'shares'}</p>
              {row.avgCost != null && <p className="text-xs tabular-nums text-muted-foreground">
                {zh ? '成本' : 'Cost'} {row.avgCost}{row.currency && ` ${row.currency}`}
              </p>}
            </div>
          </li>)}
        </ul>
        {previewRows.length > 20 && <p className="text-xs text-muted-foreground">{t('import.preview20', { count: previewRows.length })}</p>}
        <div className="flex flex-wrap items-end gap-2">
          {!onboarding && <Label className="grid gap-1 text-xs">{t('import.buyDate')}<Input type="date" className="h-9 w-40" value={buyDate} disabled={saveLocked} onChange={e => {
            if (!requestIntent.current) setBuyDate(e.target.value);
          }} /></Label>}
          <Button
            onClick={() => commit(false)}
            disabled={!canSave || (saveUnknown && requestIntent.current?.analyze === true)}
          >
            {committing && <Loader2 size={14} className="animate-spin" />}
            {saveUnknown && requestIntent.current?.analyze === false ? (zh ? '核对本次保存结果' : 'Check this save result') : (zh ? '保存持仓' : 'Save holdings')}
          </Button>
          {(!onboarding || requestIntent.current?.analyze) && <Button
            variant="outline"
            onClick={() => commit(true)}
            disabled={!canSave || (saveUnknown && requestIntent.current?.analyze === false)}
          >
            {saveUnknown && requestIntent.current?.analyze === true ? (zh ? '核对本次保存结果' : 'Check this save result') : (zh ? '保存并开始研究' : 'Save and start research')}
          </Button>}
          {onboarding && <Button asChild variant="ghost"><Link to="/holdings?accountId=real">{zh ? '返回持仓' : 'Back to holdings'}</Link></Button>}
        </div>
        {saveUnknown && <p role="status" className="text-sm text-muted-foreground">
          {zh ? '先核对本次保存结果，再修改持仓或开始新的保存。' : 'Check this save result before editing holdings or starting another save.'}
        </p>}
        <p className="text-xs text-muted-foreground">{zh
          ? '已有持仓会更新数量和成本，文件里没有的持仓会保留。'
          : 'Existing quantities and costs update. Holdings missing from this file are retained.'}</p>
      </CardContent>
    </Card>}

    {result && <Card>
      <CardContent className="space-y-2 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-primary">{t('import.created')} {result.created}</Badge>
          {result.updated > 0 && <Badge variant="secondary">{zh ? '已更新' : 'Updated'} {result.updated}</Badge>}
          {result.skipped > 0 && <Badge variant="outline">{t('import.skipped')} {result.skipped}</Badge>}
        </div>
        {result.failed.slice(0, 10).map(row => <p className="text-sm text-destructive" key={row.ticker}>
          <XCircle size={14} className="mr-1 inline" />{row.ticker} · {row.reason}
        </p>)}
        {result.failed.length > 10 && <p className="text-sm">{t('ui.import.moreFailed', { count: result.failed.length - 10 })}</p>}
        {(result.created > 0 || result.updated > 0) && <ImportSavedNextSteps />}
      </CardContent>
    </Card>}
  </div>;
}

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------

function ImportHistoryCard() {
  const { t } = useTranslation();
  const historyQuery = useQuery({
    queryKey: ['import', 'history'],
    queryFn: fetchImportHistory,
  });
  const items = historyQuery.data ?? [];
  const sourceLabel: Record<string, string> = {
    csv: 'CSV',
    robinhood: 'Robinhood CSV',
    ocr: t('import.screenshot'),
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <History size={14} /> {t('import.history')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-4">
        {items.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('import.noHistory')}
          </div>
        )}
        {items.map((h) => (
          <div
            key={h.id}
            className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
          >
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {sourceLabel[h.source] ?? h.source}
            </Badge>
            <span className="truncate text-foreground/90">
              {h.filename ?? t('import.noFilename')}
            </span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {t('import.created')} {h.rowsImported}/{h.rowsTotal} ·{' '}
              {new Date(h.createdAt).toLocaleString(undefined, {
                hour12: false,
              })}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default ImportPage;
