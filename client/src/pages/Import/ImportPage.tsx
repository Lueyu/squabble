/**
 * ImportPage.tsx — 持仓导入中枢页（路由 /import）。
 *
 * 职责边界：
 *  - 三条导入流程共用同一个提交入口 commitImport：
 *    1. CSV 文件导入 — 前端 papaparse 解析，支持编码切换（UTF-8 / GBK，
 *       GBK 用于国内券商导出文件），自动列映射可手动改，可编辑预览后提交；
 *    2. Robinhood CSV — 同一流程的预设：已知表头自动映射；
 *    3. 截图识别导入 — 上传券商截图，用用户自己的多模态 LLM key 抽取
 *       持仓行（key 只存本浏览器 localStorage，与 Finnhub token 同策略），
 *       复核可编辑的抽取结果后提交。
 *  - 导入历史卡片列出最近导入批次与逐行失败原因。
 * 上下游：
 *  - 上游：路由 /import（App 路由表）；
 *  - 下游：@/api 的 commitImport / extractScreenshot / fetchImportHistory、
 *    papaparse、react-query（缓存失效 ['import'] / ['holdings']）。
 * 关键约定：
 *  - CSV 行候选 ImportRowCandidate：shares/avgCost 为 number（前端已清洗，
 *    去除 $ , ￥ HK$ 等），avgCost 可为 null（未映射/不可解析），ticker 为
 *    过滤主键（空 ticker 行丢弃）；
 *  - OCR 供应商配置存 localStorage（OCR_LS 三个 key），baseUrl 有默认值，
 *    key 与 model 空时不可抽取；
 *  - 提交成功后 invalidate ['import'] 与 ['holdings'] 两个查询缓存。
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import Papa from 'papaparse';
import {
  FileSpreadsheet,
  Camera,
  History,
  Upload,
  Loader2,
  CheckCircle2,
  XCircle,
  Wand2,
} from 'lucide-react';

import { commitImport, extractScreenshot, fetchImportHistory } from '@/api';
import type { ImportRowCandidate, ImportSource, OcrExtractResult } from '@shared/api.interface';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';

/** OCR 供应商配置的 localStorage key（仅存浏览器，与 Finnhub token 同策略）。 */
const OCR_LS = { baseUrl: 'sq-ocr-base', model: 'sq-ocr-model', apiKey: 'sq-ocr-key' };

/** CSV 列映射可分配的字段。 */
type MapField = 'ticker' | 'shares' | 'avgCost' | 'company';

/** 通用券商的表头别名表（自动映射建议用）。 */
const FIELD_ALIASES: Record<MapField, string[]> = {
  ticker: ['ticker', 'symbol', 'code', '股票代码', '证券代码', '代码', 'symbol(id)'],
  shares: ['shares', 'quantity', 'qty', '股数', '持仓数量', '数量', '持有数量', '持仓'],
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
  company: ['company', 'name', 'description', '名称', '证券名称', '股票名称', '描述'],
};

/** Robinhood 预设：按已知表头精确匹配（忽略大小写含空格）。 */
const ROBINHOOD_ALIASES: Record<MapField, string[]> = {
  ticker: ['symbol'],
  shares: ['quantity'],
  avgCost: ['average cost', 'avg cost'],
  company: ['description', 'name', 'instrument'],
};

/** 富途牛牛 CSV 预设。 */
const FUTU_ALIASES: Record<MapField, string[]> = {
  ticker: ['代码', 'code', 'symbol', 'ticker'],
  shares: ['数量', '股数', 'qty', 'quantity', 'shares'],
  avgCost: ['成本价', '买入均价', '平均成本', 'cost', 'avg cost', 'price'],
  company: ['名称', '股票名称', 'name', 'company'],
};

/** 老虎证券 CSV 预设。 */
const TIGER_ALIASES: Record<MapField, string[]> = {
  ticker: ['symbol', '代码', 'ticker'],
  shares: ['quantity', '数量', '股数', 'shares'],
  avgCost: ['avg cost', '成本价', 'cost basis', '平均成本'],
  company: ['name', '名称', 'description'],
};

/** 雪球 CSV 预设。 */
const XUEQIU_ALIASES: Record<MapField, string[]> = {
  ticker: ['symbol', '代码', 'ticker'],
  shares: ['volume', '数量', '股数', 'shares', '持有数量'],
  avgCost: ['cost', '成本价', 'avg cost', '买入成本'],
  company: ['name', '名称', '股票名称'],
};

/** 全部券商预设，按下拉选择值组织（label 用 labelKey 渲染时翻译）。 */
const BROKER_PRESETS: Record<string, { labelKey: string; aliases: Record<MapField, string[]> }> = {
  generic: { labelKey: 'import.generic', aliases: FIELD_ALIASES },
  robinhood: { labelKey: 'import.robinhood', aliases: ROBINHOOD_ALIASES },
  futu: { labelKey: 'import.futu', aliases: FUTU_ALIASES },
  tiger: { labelKey: 'import.tiger', aliases: TIGER_ALIASES },
  xueqiu: { labelKey: 'import.xueqiu', aliases: XUEQIU_ALIASES },
};

/**
 * 按预设为表头数组生成列映射建议：字段→列下标。
 * 规则：表头与别名都去掉空白并小写后做等值/包含匹配；每个列只被占用一次
 * （used 集合），先匹配的字段先占列；总成本类表头（totalcost/总成本等）
 * 显式排除在 avgCost 之外。
 */
function suggestForPreset(headers: string[], presetKey: string): Partial<Record<MapField, number>> {
  const aliases = BROKER_PRESETS[presetKey]?.aliases ?? FIELD_ALIASES;
  const out: Partial<Record<MapField, number>> = {};
  const used = new Set<number>();
  for (const field of Object.keys(aliases) as MapField[]) {
    for (let i = 0; i < headers.length; i++) {
      if (used.has(i)) continue;
      const h = headers[i].toLowerCase().replace(/\s+/g, '');
      if (field === 'avgCost' && /^(totalcost|costbasis|总成本|成本总额)/.test(h)) continue;
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

/** 把映射后的 CSV 单元格矩阵转成导入行候选（ticker 空的行丢弃）。 */
function rowsFromMatrix(
  matrix: string[][],
  mapping: Partial<Record<MapField, number>>,
): ImportRowCandidate[] {
  // 非空判断与数值清洗：数字去掉 $ , ￥ HK$ 等货币/千分位符号后 Number 化。
  const has = (v?: string) => v != null && v.trim() !== '';
  const num = (v?: string) => {
    if (!has(v)) return null;
    const n = Number(String(v).replace(/[,$￥HK$]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  return matrix
    .map((cells) => ({
      ticker: mapping.ticker != null ? String(cells[mapping.ticker] ?? '').trim() : '',
      company:
        mapping.company != null && has(cells[mapping.company])
          ? String(cells[mapping.company]).trim()
          : null,
      shares: num(mapping.shares != null ? cells[mapping.shares] : undefined) ?? 0,
      avgCost: num(mapping.avgCost != null ? cells[mapping.avgCost] : undefined),
    }))
    .filter((r) => r.ticker !== '');
}

/** localStorage helpers — OCR 供应商配置的 localStorage 读写；baseUrl 缺省用火山方舟端点。 */
const ocrConfig = {
  load() {
    return {
      baseUrl: localStorage.getItem(OCR_LS.baseUrl) ?? 'https://ark.cn-beijing.volces.com/api/v3',
      model: localStorage.getItem(OCR_LS.model) ?? '',
      apiKey: localStorage.getItem(OCR_LS.apiKey) ?? '',
    };
  },
  save(v: { baseUrl?: string; model?: string; apiKey?: string }) {
    if (v.baseUrl !== undefined) localStorage.setItem(OCR_LS.baseUrl, v.baseUrl);
    if (v.model !== undefined) localStorage.setItem(OCR_LS.model, v.model);
    if (v.apiKey !== undefined) localStorage.setItem(OCR_LS.apiKey, v.apiKey);
  },
};

/**
 * 导入中枢页：顶部模式切换（CSV / 截图识别），下方渲染对应流程组件，
 * 最后固定附导入历史卡片。
 */
function ImportPage() {
  // ---- 状态声明区 ----
  const { t } = useTranslation();
  const [mode, setMode] = useState<'csv' | 'ocr'>('csv');
  // ---- 渲染区 ----
  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold">
          <Upload size={22} className="text-primary" />
          {t('import.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('import.subtitle')}</p>
      </div>

      {/* 模式切换按钮组。 */}
      <div className="flex gap-2">
        <Button
          variant={mode === 'csv' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('csv')}
        >
          <FileSpreadsheet size={14} className="mr-1" /> {t('import.csvFile')}
        </Button>
        <Button
          variant={mode === 'ocr' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('ocr')}
        >
          <Camera size={14} className="mr-1" /> {t('import.screenshot')}
        </Button>
      </div>

      {/* 按模式渲染对应导入流程；历史卡片两种模式都展示。 */}
      {mode === 'csv' ? <CsvImport /> : <OcrImport />}
      <ImportHistoryCard />
    </div>
  );
}

// ---------------------------------------------------------------------
// CSV 导入流程
// ---------------------------------------------------------------------

/** CSV 导入：读文件 → 列映射 → 可编辑预览 → 提交。 */
function CsvImport() {
  // ---- 状态声明区 ----
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [matrix, setMatrix] = useState<string[][]>([]);
  const [encoding, setEncoding] = useState<'utf-8' | 'gbk'>('utf-8');
  const [mapping, setMapping] = useState<Partial<Record<MapField, number>>>({});
  const [buyDate, setBuyDate] = useState('');
  const [source, setSource] = useState<string>('generic');
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
    failed: Array<{ ticker: string; reason: string }>;
  } | null>(null);

  // ---- 事件处理区 ----
  /** 读取 CSV 文件：按当前编码解析，首行作表头，其余作数据矩阵。 */
  const readFile = (file: File) => {
    setFilename(file.name);
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: true });
      const data = (parsed.data as string[][]).filter((r) =>
        r.some((c) => String(c).trim() !== ''),
      );
      // 全空文件：提示并中止。
      if (data.length === 0) {
        toast.warning(t('ui.import.noDataRows'));
        return;
      }
      // 首行表头：空表头按"第 N 列"占位；其余行为数据。
      const hdrs = (data[0] ?? []).map(
        (h, i) => String(h).trim() || t('ui.import.columnNumber', { number: i + 1 }),
      );
      const body = data.slice(1);
      setHeaders(hdrs);
      setMatrix(body);
      setMapping(suggestForPreset(hdrs, source));
      // 检测乱码（U+FFFD 替换符）：常见于 GBK 文件按 UTF-8 读入。
      if (String(text).includes('\uFFFD')) {
        toast.info(t('import.detectedGibberish'));
      }
    };
    reader.readAsText(file, encoding);
  };

  // ---- 派生计算区 ----
  // 预览行随矩阵/映射实时重算。
  const previewRows = matrix.length > 0 ? rowsFromMatrix(matrix, mapping) : [];

  /** 提交导入：成功后展示结果并失效 import / holdings 缓存。 */
  const commit = async () => {
    // 无可导入行时直接提示。
    if (previewRows.length === 0) {
      toast.warning(t('import.noRows'));
      return;
    }
    try {
      setCommitting(true);
      const r = await commitImport({
        source: source === 'robinhood' ? 'robinhood' : 'csv',
        rows: previewRows,
        filename: filename || undefined,
        buyDate: buyDate || undefined,
      });
      setResult(r);
      toast.success(t('import.importComplete', { created: r.created, skipped: r.skipped }));
      queryClient.invalidateQueries({ queryKey: ['import'] });
      queryClient.invalidateQueries({ queryKey: ['holdings'] });
    } catch (error) {
      toast.error(
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          t('import.importFailed'),
      );
    } finally {
      setCommitting(false);
    }
  };

  // ---- 渲染区 ----
  return (
    <Card>
      <CardHeader className="flex flex-col items-stretch gap-3 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="shrink-0 text-sm">{t('import.csvImport')}</CardTitle>
        {/* 工具条：券商预设、编码选择、选文件按钮（触发隐藏的 file input）。 */}
        <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:flex sm:items-center">
          <select
            className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs sm:w-36"
            value={source}
            onChange={(e) => {
              const v = e.target.value;
              setSource(v);
              // 已读入文件时，切换预设立即重算列映射建议。
              if (headers.length > 0) setMapping(suggestForPreset(headers, v));
            }}
          >
            {Object.entries(BROKER_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {t(v.labelKey)}
              </option>
            ))}
          </select>
          <select
            className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-xs sm:w-28"
            value={encoding}
            onChange={(e) => setEncoding(e.target.value as 'utf-8' | 'gbk')}
          >
            <option value="utf-8">UTF-8</option>
            <option value="gbk">{t('import.gbkNote')}</option>
          </select>
          <Button
            className="col-span-2 w-full sm:w-auto"
            size="sm"
            variant="outline"
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={14} className="mr-1" /> {t('import.selectFile')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {/* 未选文件：上传提示占位。什么时候走到这里：matrix 为空。 */}
        {matrix.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {t('import.uploadHint')}
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">
              {filename} · {matrix.length} {t('import.rowsData')} ({t('import.columns')}:{' '}
              {headers.length}){source === 'robinhood' && ` · ${t('import.robinhoodApplied')}`}
            </div>

            {/* 四个字段各自的列映射下拉：可改写自动映射建议。 */}
            <div className="grid gap-3 md:grid-cols-4">
              {(['ticker', 'shares', 'avgCost', 'company'] as MapField[]).map((field) => (
                <div key={field} className="space-y-1.5">
                  <Label className="text-xs">
                    {field === 'ticker'
                      ? t('import.ticker')
                      : field === 'shares'
                        ? t('import.shares')
                        : field === 'avgCost'
                          ? t('import.avgCost')
                          : t('import.company')}
                  </Label>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={mapping[field] ?? ''}
                    onChange={(e) =>
                      setMapping((prev) => ({
                        ...prev,
                        [field]: e.target.value === '' ? undefined : Number(e.target.value),
                      }))
                    }
                  >
                    <option value="">{t('import.noMapping')}</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {/* 预览表：只渲染前 20 行（映射结果实时生效）。 */}
            <div className="max-h-56 overflow-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/50">
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{t('ui.import.tickerColumn')}</th>
                    <th className="px-3 py-2 font-medium">{t('ui.import.nameColumn')}</th>
                    <th className="px-3 py-2 font-medium">{t('ui.import.sharesColumn')}</th>
                    <th className="px-3 py-2 font-medium">{t('ui.import.costColumn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.slice(0, 20).map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-1.5 font-medium">{r.ticker}</td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        {r.company ?? '—'}
                      </td>
                      <td className="px-3 py-1.5 font-mono-nums">{r.shares}</td>
                      <td className="px-3 py-1.5 font-mono-nums">{r.avgCost ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {previewRows.length > 20 && (
              <div className="text-xs text-muted-foreground">
                {t('import.preview20', { count: previewRows.length })}
              </div>
            )}

            {/* 买日期 + 提交按钮：ticker/shares 两列映射必填才能提交。 */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="space-y-1">
                <Label className="text-xs">{t('import.buyDate')}</Label>
                <Input
                  type="date"
                  className="h-9 w-40"
                  value={buyDate}
                  onChange={(e) => setBuyDate(e.target.value)}
                />
              </div>
              <Button
                className="mt-4"
                onClick={commit}
                disabled={committing || mapping.ticker == null || mapping.shares == null}
              >
                {committing ? (
                  <Loader2 size={14} className="mr-1 animate-spin" />
                ) : (
                  <CheckCircle2 size={14} className="mr-1" />
                )}
                {t('import.confirmImport', { count: previewRows.length })}
              </Button>
            </div>
          </>
        )}

        {/* 提交结果：新建/跳过徽章 + 失败明细（最多展示 10 条）。 */}
        {result && (
          <div className="rounded-md border border-border p-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
              >
                {t('import.created')} {result.created}
              </Badge>
              <Badge
                variant="outline"
                className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
              >
                {t('import.skipped')} {result.skipped}
              </Badge>
            </div>
            {result.failed.length > 0 && (
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {result.failed.slice(0, 10).map((f, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <XCircle size={12} className="shrink-0 text-amber-500" />
                    <span>
                      {f.ticker}：{f.reason}
                    </span>
                  </div>
                ))}
                {result.failed.length > 10 && (
                  <div>{t('ui.import.moreFailed', { count: result.failed.length - 10 })}</div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
// 截图识别（OCR）导入流程
// ---------------------------------------------------------------------

/**
 * 截图导入：上传券商截图 → 用户自带 LLM key 抽取持仓行 →
 * 逐行可编辑复核 → 提交。
 */
function OcrImport() {
  // ---- 状态声明区 ----
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [imageBase64, setImageBase64] = useState('');
  const [ocrResult, setOcrResult] = useState<OcrExtractResult | null>(null);
  const [rows, setRows] = useState<ImportRowCandidate[]>([]);
  // 供应商配置初始值从 localStorage 读（懒初始化只执行一次）。
  const [provider, setProvider] = useState(() => ocrConfig.load());
  const [extracting, setExtracting] = useState(false);
  const [committing, setCommitting] = useState(false);

  // ---- 事件处理区 ----
  /** 读图片为 dataURL，仅保留 base64 部分（剥掉 "data:...;base64," 前缀）。 */
  const readFile = (file: File) => {
    setOcrResult(null);
    setRows([]);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      setImageBase64(dataUrl.split(',')[1] ?? '');
    };
    reader.readAsDataURL(file);
  };

  /** 调后端抽取：key/model 必填，成功后写结果与可编辑行，并保存配置。 */
  const extract = async () => {
    // 前置校验：先图后 key。
    if (!imageBase64) {
      toast.warning(t('import.selectScreenshotFirst'));
      return;
    }
    if (!provider.apiKey.trim() || !provider.model.trim()) {
      toast.warning(t('import.needKey'));
      return;
    }
    try {
      setExtracting(true);
      ocrConfig.save(provider);
      const r = await extractScreenshot({
        imageBase64,
        apiKey: provider.apiKey.trim(),
        baseUrl: provider.baseUrl.trim() || undefined,
        model: provider.model.trim(),
      });
      setOcrResult(r);
      setRows(r.rows);
      toast.success(
        t('import.extractSuccess', {
          count: r.rows.length,
          broker: r.broker ? ` (${r.broker})` : '',
        }),
      );
    } catch (error) {
      toast.error(
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          t('import.extractFailed'),
      );
    } finally {
      setExtracting(false);
    }
  };

  /** 提交抽取结果：成功后清空全部草稿状态并失效缓存。 */
  const commit = async () => {
    try {
      setCommitting(true);
      const r = await commitImport({ source: 'ocr', rows });
      toast.success(t('import.importComplete', { created: r.created, skipped: r.skipped }));
      setRows([]);
      setOcrResult(null);
      setImageBase64('');
      queryClient.invalidateQueries({ queryKey: ['import'] });
      queryClient.invalidateQueries({ queryKey: ['holdings'] });
    } catch (error) {
      toast.error(
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          t('import.importFailed'),
      );
    } finally {
      setCommitting(false);
    }
  };

  /** 就地编辑第 i 行的部分字段（不可变更新）。 */
  const updateRow = (i: number, patch: Partial<ImportRowCandidate>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  // ---- 渲染区 ----
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('import.screenshotImport')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        <p className="text-xs text-muted-foreground">{t('import.ocrHint')}</p>

        {/* 供应商配置：端点 / 视觉模型 / API key（key 输入框打码）。 */}
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('import.apiEndpoint')}</Label>
            <Input
              className="h-9"
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
              value={provider.baseUrl}
              onChange={(e) => setProvider((p) => ({ ...p, baseUrl: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('import.visionModel')}</Label>
            <Input
              className="h-9"
              placeholder="e.g. doubao-1.5-vision-pro / gpt-4o-mini"
              value={provider.model}
              onChange={(e) => setProvider((p) => ({ ...p, model: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('import.apiKey')}</Label>
            <Input
              className="h-9"
              type="password"
              placeholder={t('import.apiKeyNote')}
              value={provider.apiKey}
              onChange={(e) => setProvider((p) => ({ ...p, apiKey: e.target.value }))}
            />
          </div>
        </div>

        {/* 选图 + 抽取按钮 + 缩略图预览。 */}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Camera size={14} className="mr-1" /> {t('import.selectScreenshot')}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
          />
          <Button size="sm" onClick={extract} disabled={extracting || !imageBase64}>
            {extracting ? (
              <Loader2 size={14} className="mr-1 animate-spin" />
            ) : (
              <Wand2 size={14} className="mr-1" />
            )}
            {extracting ? t('import.extracting') : t('import.extract')}
          </Button>
          {imageBase64 && (
            <img
              src={`data:image/jpeg;base64,${imageBase64}`}
              alt={t('ui.import.screenshotPreview')}
              className="h-16 rounded-md border border-border object-cover"
            />
          )}
        </div>

        {/* 抽取结果复核表：每行可就地编辑；有行才渲染。 */}
        {rows.length > 0 && (
          <>
            <div className="max-h-56 overflow-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/50">
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{t('ui.import.editableTicker')}</th>
                    <th className="px-3 py-2 font-medium">{t('ui.import.nameColumn')}</th>
                    <th className="px-3 py-2 font-medium">{t('ui.import.editableShares')}</th>
                    <th className="px-3 py-2 font-medium">{t('ui.import.editableCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1">
                        <Input
                          className="h-8"
                          value={r.ticker}
                          onChange={(e) => updateRow(i, { ticker: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1 text-xs text-muted-foreground">
                        {r.company ?? '—'}
                      </td>
                      {/* 股数输入：string <-> number 转换在 value/onChange 处完成。 */}
                      <td className="w-28 px-2 py-1">
                        <Input
                          className="h-8 font-mono-nums"
                          type="number"
                          value={String(r.shares)}
                          onChange={(e) => updateRow(i, { shares: Number(e.target.value) })}
                        />
                      </td>
                      {/* 成本输入：空串还原为 null（未填）。 */}
                      <td className="w-28 px-2 py-1">
                        <Input
                          className="h-8 font-mono-nums"
                          type="number"
                          value={r.avgCost == null ? '' : String(r.avgCost)}
                          onChange={(e) =>
                            updateRow(i, {
                              avgCost: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button onClick={commit} disabled={committing}>
              {committing ? (
                <Loader2 size={14} className="mr-1 animate-spin" />
              ) : (
                <CheckCircle2 size={14} className="mr-1" />
              )}
              {t('import.confirmImport', { count: rows.length })}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
// 导入历史
// ---------------------------------------------------------------------

/** 导入历史卡片：react-query 拉取，列出批次来源/文件名/成功数与时间。 */
function ImportHistoryCard() {
  // ---- 数据获取区 ----
  const { t } = useTranslation();
  const historyQuery = useQuery({
    queryKey: ['import', 'history'],
    queryFn: fetchImportHistory,
  });
  const items = historyQuery.data ?? [];
  // 来源标签：csv/robinhood 用英文原名，ocr 用翻译文案；未知来源原样展示。
  const sourceLabel: Record<string, string> = {
    csv: 'CSV',
    robinhood: 'Robinhood CSV',
    ocr: t('import.screenshot'),
  };

  // ---- 渲染区 ----
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <History size={14} /> {t('import.history')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-4">
        {/* 空历史占位。什么时候走到这里：还没有任何导入批次。 */}
        {items.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('import.noHistory')}
          </div>
        )}
        {/* 历史行：来源徽章 + 文件名 + 成功/总数 + 本地化时间。 */}
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
              {new Date(h.createdAt).toLocaleString(undefined, { hour12: false })}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default ImportPage;
