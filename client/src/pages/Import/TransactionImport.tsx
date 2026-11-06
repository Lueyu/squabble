import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { createScreenshotJob, fetchScreenshotJob, cancelScreenshotJob } from '@/api';
import { fetchLocalAgents } from '@/api/local-agents';
import { createTransactionBatch, previewTransactionBatch, commitTransactionBatch } from '@/api/transaction-imports';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { screenshotImage, screenshotAgentReady, SCREENSHOT_ERROR_CODES } from './screenshot-import';
import type { TransactionImportCandidate, TransactionImportPreview } from '@shared/transaction-import.interface';
import { readTransactionMatrix } from '@/utils/transaction-file';
import { transactionCashDelta } from '@/utils/transaction-cash';

type Field = keyof TransactionImportCandidate;
const fields: Field[] = ['txDate', 'txTime', 'txType', 'ticker', 'shares', 'price', 'fees', 'currency', 'brokerId', 'recordKind'];
const aliases: Record<Field, string[]> = {
  txDate: ['txdate', 'date', '成交日期', '交易日期', '日期'], txTime: ['txtime', 'time', '成交时间', '时间'],
  txType: ['txtype', 'type', 'action', '买卖方向', '交易类型', '类型'], ticker: ['ticker', 'symbol', '代码', '证券代码'],
  shares: ['shares', 'quantity', 'amount', '数量', '发生金额', '金额'], price: ['price', '成交价', '价格'],
  fees: ['fees', 'commission', '手续费', '费用'], currency: ['currency', '币种', '货币'],
  brokerId: ['brokerid', 'executionid', 'tradeid', '成交编号', '流水号'], recordKind: ['recordkind', '记录分类'], notes: ['notes', '备注'],
};
const normalizeType = (value: string) => ({ '买入': 'Buy', '卖出': 'Sell', '入金': 'Deposit', '存入': 'Deposit', '出金': 'Withdrawal', '取出': 'Withdrawal', '费用': 'Fee', buy: 'Buy', sell: 'Sell', deposit: 'Deposit', withdrawal: 'Withdrawal', fee: 'Fee' }[value.toLowerCase()] ?? value);
const failure = (error: unknown) => {
  const body=(error as {response?:{data?:{message?:string;error?:{message?:string}}}})?.response?.data;
  return body?.error?.message??body?.message??String(error);
};
const savedJob = () => { try { return localStorage.getItem('sq-transaction-import-job'); } catch { return null; } };
const rememberJob = (id: string | null) => { try { if (id) localStorage.setItem('sq-transaction-import-job', id); else localStorage.removeItem('sq-transaction-import-job'); } catch { /* Storage is optional. */ } };

export default function TransactionImport() {
  const { t, i18n } = useTranslation(), zh = i18n.language.startsWith('zh'), queryClient = useQueryClient();
  const copy = (cn: string, en: string) => zh ? cn : en;
  const labels: Record<Field, string> = { txDate: copy('日期', 'Date'), txTime: copy('时间', 'Time'), txType: copy('类型', 'Type'), ticker: copy('代码', 'Ticker'), shares: copy('数量 / 金额', 'Quantity / amount'), price: copy('成交价', 'Price'), fees: copy('费用', 'Fees'), currency: copy('币种', 'Currency'), brokerId: copy('券商流水号', 'Broker reference'), recordKind: copy('记录分类', 'Record kind'), notes: copy('备注', 'Notes') };
  const describe = (code: string) => ({ INVALID_DATE: copy('请核对日期（年-月-日）', 'Check the date (YYYY-MM-DD)'), MISSING_CURRENCY: copy('请选择币种', 'Select a currency'), INVALID_AMOUNT: copy('请核对数量或金额', 'Check the quantity or amount'), MISSING_PRICE: copy('请补充成交价', 'Enter the execution price'), MISSING_FEES: copy('请核对费用，无费用时明确填 0', 'Verify fees; explicitly enter 0 if none'), DOCUMENT_KIND_MISMATCH: copy('记录种类与所选分类不符', 'This record does not match the selected document type'), MISSING_TICKER: copy('请补充证券代码', 'Enter the security code'), BROKER_ID_CONFLICT: copy('相同流水号的金额不同，请核对原记录', 'The same broker reference has different amounts; check the original record'), AMBIGUOUS_IDENTITY: copy('有多笔相同金额的成交，请补充流水号', 'Several executions have identical amounts; add the broker reference'), INVALID_TIME: copy('时间格式为 时:分:秒', 'Use HH:mm:ss for the time'), BALANCE_MISMATCH: copy('现金汇总与账本不符，需要核对', 'The balance summary differs from the ledger; reconcile it'), INVALID_RECORD_KIND: copy('请选择记录分类', 'Choose a record classification'), INVALID_FIELD_TYPES: copy('字段格式有误，请重新核对', 'Review the invalid field format'), LEDGER_CHANGED: copy('账本刚有变化，请重新预览后确认', 'The ledger changed; refresh the preview before confirming'), ROW_COUNT_LIMIT: copy('请上传 1–500 条记录', 'Upload 1–500 records'), FILE_SIZE_LIMIT: copy('文件上限为 8 MB', 'Maximum file size is 8 MB'), CSV_PARSE_FAILED: copy('CSV 格式无法读取，请检查分隔符和引号', 'Check CSV delimiters and quoting'), ROWS_REQUIRE_REVIEW: copy('请先核对有问题的记录', 'Review the flagged records first') }[code] ?? code);
  const [kind, setKind] = useState<'trades' | 'cash-flows'>('trades'), [broker, setBroker] = useState(''), [account, setAccount] = useState('');
  const humanReason = (code: string) => ['CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION', 'CASH_CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION'].includes(code)
    ? copy('这笔记录已包含在确认的资产起点中，请先核对持仓或现金起点。', 'This record is included in a confirmed asset starting balance. Reconcile the positions or cash starting balance first.')
    : code === 'POSITION_IDENTITY_REQUIRES_RECONCILIATION'
      ? copy('同一证券存在多个代码写法，请先核对重复持仓和交易记录。', 'This security has conflicting ticker aliases. Reconcile its duplicate holdings and transaction records first.')
      : code === 'POSITION_CURRENCY_MISMATCH'
        ? copy('成交币种与持仓或证券市场币种不一致，请核对后再入账。', 'The execution currency differs from the position or security market currency. Verify it before saving.')
        : code === 'BASELINE_OVERLAP'
    ? copy('这笔记录可能已包含在持仓或现金起点中。核对后，只有起点之后的新记录才能勾选下方声明并重新预览。', 'This record may already be included in the starting positions or cash. Verify it, then acknowledge below and preview again only if it occurred after the starting balance.')
    : code === 'BEFORE_POSITION_BASELINE' || code === 'BEFORE_CASH_BASELINE'
      ? copy('这笔记录早于已确认的资产起点，不能再次累加。请先核对原持仓或现金记录。', 'This record predates the confirmed asset starting point and cannot be added again. Reconcile the original positions or cash first.')
      : code === 'MISSING_IDENTITY' ? copy('请补充券商流水号或可核对的准确时间，避免把独立记录误判为重复。', 'Add the broker reference or verifiable execution time so separate records are not mistaken for duplicates.') : describe(code);
  const [afterOpening, setAfterOpening] = useState(false);
  const [source, setSource] = useState<'csv' | 'excel' | 'screenshot'>('csv'), [filename, setFilename] = useState('');
  const [matrix, setMatrix] = useState<string[][]>([]), [mapping, setMapping] = useState<Partial<Record<Field, number>>>({});
  const [rows, setRows] = useState<TransactionImportCandidate[]>([]), [preview, setPreview] = useState<TransactionImportPreview | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [jobId, setJobId] = useState<string | null>(savedJob);
  const request = useRef<{ key: string; signature: string } | null>(null), extraction = useRef<string | null>(null);
  useEffect(() => {
    if (savedJob()) return;
    let saved: string | null = null;
    try { saved = localStorage.getItem('sq-transaction-import-preview'); } catch { /* Storage is optional. */ }
    if (saved) void previewTransactionBatch(saved).then(result => { setPreview(result); setSelected([]); setRows(result.rows.map(row => row.raw)); setBroker(result.input.broker); setAccount(result.input.account); setKind(result.input.kind); setSource(result.input.source); setFilename(result.input.filename ?? ''); setAfterOpening(result.input.baselineScope === 'after-opening'); }).catch(() => { try { localStorage.removeItem('sq-transaction-import-preview'); } catch { /* Storage is optional. */ } });
  }, []);
  const agents = useQuery({ queryKey: ['settings', 'local-agents'], queryFn: fetchLocalAgents });
  const ready = agents.data?.find(screenshotAgentReady);
  const job = useQuery({ queryKey: ['transaction-import', 'screenshot', jobId], queryFn: () => fetchScreenshotJob(jobId!), enabled: !!jobId,
    refetchInterval: query => ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1500 : false });
  useEffect(() => {
    if (job.data?.status === 'completed' && extraction.current !== job.data.id) {
      extraction.current = job.data.id; setSource('screenshot'); if (job.data.result?.documentKind) setKind(job.data.result.documentKind); setRows(job.data.result?.ledgerRows ?? []); setMatrix([]); setPreview(null);
    }
  }, [job.data]);
  const activeJob = !!jobId && (!job.data || ['queued', 'running'].includes(job.data.status));
  const mapRows = (grid: string[][], map: Partial<Record<Field, number>>) => grid.slice(1).filter(row => row.some(Boolean)).map(cells => {
    const row = Object.fromEntries(fields.map(field => [field, map[field] === undefined ? '' : cells[map[field]!] ?? ''])) as TransactionImportCandidate;
    row.txType = normalizeType(String(row.txType ?? '').trim());
    row.txDate = String(row.txDate ?? '').replace(/\//g, '-').slice(0, 10);
    return row;
  });
  async function fileChanged(file?: File) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setError(copy('文件上限 8 MB', 'Maximum file size is 8 MB')); return; }
    setBusy(true); setError(''); setPreview(null); setRows([]); setMatrix([]); setFilename(file.name);
    try {
      if (file.type.startsWith('image/')) {
        if (!ready) throw new Error(copy('请先连接支持图片的本地股友。', 'Connect an image-capable local agent first.'));
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
        const id = crypto.randomUUID();
        setSource('screenshot'); rememberJob(id); setJobId(id); setRows([]); setMatrix([]);
        await createScreenshotJob({ requestId: id, image: screenshotImage(file, dataUrl), executor: 'local', agentId: ready.id, purpose: kind });
        await queryClient.invalidateQueries({ queryKey: ['transaction-import', 'screenshot', id] });
      } else {
        rememberJob(null); setJobId(null);
        const grid = await readTransactionMatrix(file);
        setSource(file.name.toLowerCase().endsWith('.xlsx') ? 'excel' : 'csv');
        const suggestion: Partial<Record<Field, number>> = {};
        for (const field of fields) { const index = grid[0].findIndex(header => aliases[field].includes(header.toLowerCase().replace(/\s+/g, ''))); if (index >= 0) suggestion[field] = index; }
        setMatrix(grid); setMapping(suggestion); setRows(mapRows(grid, suggestion));
      }
    } catch (reason) { setError(failure(reason)); } finally { setBusy(false); }
  }
  async function buildPreview() {
    setBusy(true); setError('');
    try { const result = await createTransactionBatch({ kind, broker, account, source, filename, rows, baselineScope: afterOpening ? 'after-opening' : undefined }); setPreview(result); rememberJob(null); setJobId(null); try { localStorage.setItem('sq-transaction-import-preview', result.id); } catch { /* Storage is optional. */ } setSelected(result.rows.filter(row => row.status === 'ready').map(row => row.id)); request.current = null; }
    catch (reason) { setError(failure(reason)); } finally { setBusy(false); }
  }
  const selectedCash = new Map<string, number>(), selectedShares = new Map<string, number>();
  for (const row of preview?.rows ?? []) if (selected.includes(row.id) && row.value) {
    const value = row.value;
    selectedCash.set(value.currency!, (selectedCash.get(value.currency!) ?? 0) + transactionCashDelta({ txType: value.txType, shares: String(value.shares), price: String(value.price), fees: String(value.fees ?? 0) }));
    if (value.ticker) selectedShares.set(value.ticker, (selectedShares.get(value.ticker) ?? 0) + value.shares * (value.txType === 'Sell' ? -1 : 1));
  }
  async function save() {
    if (!preview) return;
    const payload = { revision: preview.revision, ledgerRevision: preview.ledgerRevision, rowIds: selected }, signature = JSON.stringify(payload);
    if (request.current?.signature !== signature) request.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const receipt = await commitTransactionBatch(preview.id, { ...payload, requestKey: request.current.key });
      toast.success(copy(`已入账 ${receipt.created} 条，重复 ${receipt.duplicates} 条`, `Saved ${receipt.created}; duplicates ${receipt.duplicates}`));
      setPreview(await previewTransactionBatch(preview.id)); setSelected([]); request.current = null;
      window.dispatchEvent(new CustomEvent('portfolio-updated')); await queryClient.invalidateQueries();
    } catch (reason) { setError(failure(reason)); } finally { setBusy(false); }
  }
  return <Card><CardHeader><CardTitle>{copy('成交和资金流水导入', 'Import trades and cash flows')}</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">{copy('先选择记录种类，再核对日期、币种和费用。持仓快照请使用上面的持仓导入；现金汇总和成交结算只用于核对，不重复入账。', 'Choose a record type, then verify dates, currencies and fees. Use the holdings import for position snapshots. Balance summaries and trade settlements are references and do not create cash flows.')}</p>
    <div className="grid gap-3 sm:grid-cols-3"><label>{copy('记录种类', 'Record type')}<select className="mt-1 w-full rounded border bg-background p-2" value={kind} disabled={activeJob} onChange={event => { setKind(event.target.value as typeof kind); setRows([]); setMatrix([]); setPreview(null); }}><option value="trades">{copy('成交记录', 'Trades')}</option><option value="cash-flows">{copy('资金流水', 'Cash flows')}</option></select></label>
      <label>{copy('券商', 'Broker')}<Input value={broker} onChange={event => { setBroker(event.target.value); setPreview(null); }} /></label><label>{copy('账户标记（用于去重）', 'Account label (for deduplication)')}<Input value={account} onChange={event => { setAccount(event.target.value); setPreview(null); }} /></label></div>
    <label className="block text-sm">{copy('CSV / Excel (.xlsx) / 成交或流水截图', 'CSV / Excel (.xlsx) / trade or cash-flow screenshot')}<Input type="file" accept=".csv,.xlsx,image/png,image/jpeg,image/webp" disabled={busy || activeJob} onChange={event => void fileChanged(event.target.files?.[0])} /></label>
    {source === 'excel' && <p className="text-xs text-muted-foreground">{copy('正在预览第一个工作表；其余工作表请单独导入。', 'Previewing the first worksheet. Import other worksheets separately.')}</p>}
    {activeJob && <p className="text-sm">{copy('正在识别截图，请等待原任务。', 'Reading the screenshot; waiting for the original task.')} <Button variant="outline" onClick={async () => { try { await cancelScreenshotJob(jobId!); await job.refetch(); } catch (reason) { setError(failure(reason)); } }}>{copy('停止', 'Stop')}</Button> <Button variant="ghost" onClick={() => void job.refetch()}>{copy('查询原任务', 'Check original task')}</Button></p>}
    {job.data?.status === 'failed' && <p role="alert">{t(`import.screenshotFlow.errors.${SCREENSHOT_ERROR_CODES.has(job.data.error?.code??'')?job.data.error!.code:'UNKNOWN'}`)}</p>}
    {!!matrix.length && <div className="grid gap-2 sm:grid-cols-3">{fields.map(field => <label className="text-xs" key={field}>{labels[field]}<select className="block w-full rounded border bg-background p-2" value={mapping[field] ?? ''} onChange={event => { const next = { ...mapping, [field]: event.target.value === '' ? undefined : Number(event.target.value) }; setMapping(next); setRows(mapRows(matrix, next)); setPreview(null); }}><option value="">{copy('未映射', 'Unmapped')}</option>{matrix[0].map((header, index) => <option key={index} value={index}>{header}</option>)}</select></label>)}</div>}
    {!!rows.length && <div className="max-h-96 overflow-auto"><table className="w-full text-xs"><thead><tr>{fields.map(field => <th key={field} className="p-1 text-left">{labels[field]}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{fields.map(field => { const options = field === 'recordKind' ? { transaction: copy('独立成交 / 资金流', 'Trade / cash flow'), settlement: copy('成交结算（仅核对）', 'Trade settlement (reference)'), balance: copy('现金汇总（仅核对）', 'Balance summary (reference)') } : field === 'txType' ? { Buy: copy('买入', 'Buy'), Sell: copy('卖出', 'Sell'), Deposit: copy('入金', 'Deposit'), Withdrawal: copy('出金', 'Withdrawal'), Fee: copy('费用', 'Fee') } : field === 'currency' ? { USD: 'USD', HKD: 'HKD', CNY: 'CNY' } : null;
      const change = (value: string) => { setRows(current => current.map((item, at) => at === index ? { ...item, [field]: value } : item)); setPreview(null); };
      return <td key={field} className="p-1">{options ? <select className="h-8 min-w-28 rounded border bg-background text-xs" aria-label={`${labels[field]} ${index + 1}`} value={String(row[field] ?? '')} onChange={event => change(event.target.value)}><option value="">{copy('请核对', 'Review')}</option>{Object.entries(options).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <Input className="h-8 min-w-24 text-xs" aria-label={`${labels[field]} ${index + 1}`} value={String(row[field] ?? '')} onChange={event => change(event.target.value)} />}</td>; })}</tr>)}</tbody></table></div>}
    {!!rows.length && <Button variant="outline" disabled={busy || !broker.trim() || !account.trim()} onClick={() => void buildPreview()}>{copy('预览入账差异', 'Preview ledger changes')}</Button>}
    {!!rows.length && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={afterOpening} onChange={event => { setAfterOpening(event.target.checked); setPreview(null); }} /><span>{copy('我已核对：本批记录发生在已导入的持仓或已确认的现金余额之后，尚未包含在这些起点中。', 'I verified that these records occurred after the imported positions or confirmed cash balances and are not already included in those starting balances.')}</span></label>}
    {preview && <div className="space-y-2"><p className="text-sm">{[...selectedCash].map(([currency, delta]) => { const before = preview.balances.find(balance => balance.currency === currency)?.before ?? 0; return `${currency} ${before.toFixed(2)} → ${(before + delta).toFixed(2)}`; }).join(' · ')}</p><p className="text-sm">{[...selectedShares].map(([ticker, delta]) => { const before = preview.positions.find(position => position.ticker === ticker)?.before ?? 0; return `${ticker} ${before} → ${before + delta}`; }).join(' · ')}</p>{preview.balances.some(balance => balance.status !== 'confirmed') && <p className="text-xs text-muted-foreground">{copy('部分起始现金尚未确认，请在今日页核对后查看完整资产。', 'Some starting cash balances are unconfirmed. Confirm them on Today to view complete assets.')}</p>}{preview.rows.map((row, index) => <label className="flex items-start gap-2 text-sm" key={row.id}><input type="checkbox" checked={selected.includes(row.id)} disabled={row.status !== 'ready'} onChange={event => setSelected(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id))} /><span>{index + 1}. {row.raw.txDate} {row.raw.txType} {row.raw.ticker} {row.raw.shares} {row.raw.currency} — {({ ready: copy('可入账', 'Ready'), duplicate: copy('重复，已跳过', 'Duplicate; skipped'), review: copy('需要核对', 'Review required'), reference: copy('核对参考，不记账', 'Reference; no ledger entry') })[row.status]} {row.issues.map(humanReason).join(', ')}</span></label>)}<Button disabled={busy || !selected.length} onClick={() => void save()}>{copy(`确认入账 ${selected.length} 条`, `Confirm ${selected.length} records`)}</Button></div>}
    {error && <p role="alert" className="break-words text-sm text-destructive">{humanReason(error)}</p>}
  </CardContent></Card>;
}
