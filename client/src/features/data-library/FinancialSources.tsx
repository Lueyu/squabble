import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Database, ExternalLink, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import type {
  DataFinancialConnection, DataFinancialOperation, DataFinancialProvider, DataFinancialQueryResult,
} from '@shared/data-library.interface';
import { dataLibraryApi, dataLibraryKey } from '@/api/data-library';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { NativeSelect } from '@/components/ui/native-select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { dataError, dataTime, operationLabel, safeSourceUrl } from './data-library-labels';
import './data-library.css';
import './financial-sources.css';

const providersKey = [...dataLibraryKey, 'financial'] as const;

function connectionLabel(connection: DataFinancialConnection, zh: boolean): string {
  if (connection.needsReentry) return zh ? '需重新填写密钥' : 'Key needs renewal';
  if (!connection.configured) return zh ? '未配置' : 'Not configured';
  if (!connection.enabled) return zh ? '已停用' : 'Disabled';
  return connection.requiresKey ? zh ? '已配置' : 'Configured' : zh ? '无需密钥' : 'No key required';
}

function issueLabel(code: string | null | undefined, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    KEY_REQUIRED: ['请先保存 API Key。', 'Save an API key first.'],
    CREDENTIAL_UNREADABLE: ['已存密钥无法读取，请重新填写。', 'The saved key cannot be read. Enter it again.'],
    PROVIDER_DISABLED: ['此数据源已停用，请先启用并保存。', 'Enable and save this provider first.'],
    NO_DATA: ['来源没有返回这只证券的可用数据。', 'The provider returned no usable data for this symbol.'],
    UNSUPPORTED_CAPABILITY: ['此来源不支持这项数据查询。', 'This provider does not support this operation.'],
    UNSUPPORTED_MARKET: ['此来源不支持该市场或证券代码。', 'This market or symbol is not supported.'],
    RATE_LIMITED: ['已触及供应商限额，请稍后重试。', 'The provider rate limit was reached. Retry later.'],
    RATE_LIMIT_OR_ENTITLEMENT: ['供应商限额或套餐权限不足。', 'The provider limit or subscription entitlement is insufficient.'],
    UNAUTHORIZED: ['供应商拒绝授权，请核对密钥。', 'Authorization was rejected. Check the API key.'],
    FORBIDDEN: ['当前密钥没有访问权限。', 'The API key does not have access.'],
    INVALID_SYMBOL_OR_KEY: ['请核对证券代码与 API Key。', 'Check the symbol and API key.'],
    SYMBOL_MISMATCH: ['返回的证券与请求不一致，数据未采用。', 'The returned symbol does not match the request.'],
    INVALID_RESPONSE: ['供应商返回内容无法识别。', 'The provider response could not be read.'],
  };
  return labels[code ?? '']?.[zh ? 0 : 1]
    ?? (zh ? '供应商暂未返回可用结果，请稍后重试。' : 'The provider did not return a usable result. Retry later.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function displayValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
}

function QueryResult({ result, zh, language }: {
  result: DataFinancialQueryResult; zh: boolean; language: string;
}) {
  const usable = result.status === 'succeeded' || result.status === 'partial';
  const data: Record<string, unknown> = isRecord(result.data) ? result.data : {};
  const points: Record<string, unknown>[] = Array.isArray(data.points) ? data.points.filter(isRecord) : [];
  const evidence: Record<string, unknown>[] = Array.isArray(data.evidence) ? data.evidence.filter(isRecord) : [];
  const rows: Record<string, unknown>[] = Array.isArray(data.rows) ? data.rows.filter(isRecord) : [];
  const download = useMutation({ retry: false, mutationFn: async () => {
    const blob = await dataLibraryApi.dataset(result.dataset!.datasetVersionId), url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `dataset-${result.dataset!.datasetVersionId}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  const status = {
    succeeded: zh ? '已取得数据' : 'Data received', partial: zh ? '部分数据' : 'Partial data',
    unavailable: zh ? '暂无可用数据' : 'Data unavailable', failed: zh ? '查询失败' : 'Query failed',
  }[result.status];
  const freshness = {
    'end-of-day': zh ? '日终数据' : 'End-of-day data',
    'provider-timestamp': zh ? '来源时间口径' : 'Provider timestamp',
    filing: zh ? '申报与披露数据' : 'Filings and disclosures',
  }[result.freshness];

  return <section className="financial-result" aria-label={zh ? '数据查询结果' : 'Data query result'}>
    <div className={`data-notice ${result.status === 'succeeded' ? '' : 'data-warning'}`} role="status">
      <strong>{status} · {result.symbol} · {operationLabel(result.operation, zh)}</strong>
      <p>{freshness} · {zh ? '取得于' : 'Retrieved'} {dataTime(result.observedAt, language)}</p>
      {usable && <p>{result.dataset ? zh ? '业务数据时间见各行；未知值保持为空。' : 'Business timestamps are recorded per row; unknown values remain null.' : `${zh ? '结果标注时间' : 'Result timestamp'}: ${dataTime(result.asOf, language)}`}</p>}
      {(!usable || result.errorCode) && <p>{issueLabel(result.errorCode, zh)}</p>}
    </div>
    {usable && result.dataset && <section className="data-notice space-y-2" aria-label={zh ? '完整数据集' : 'Full dataset'}>
      <p>{zh ? `完整保存 ${result.dataset.rowCount} 行；当前预览 ${result.dataset.sampleSize} 行${result.dataset.truncated ? '（已截取预览）' : ''}。` : `${result.dataset.rowCount} full rows saved; previewing ${result.dataset.sampleSize} rows${result.dataset.truncated ? ' (truncated preview)' : ''}.`}</p>
      <p>{zh ? '覆盖' : 'Coverage'}: {result.dataset.coverage.status} · {zh ? '延迟情况' : 'Delay'}: {result.dataset.coverage.delayed === null ? zh ? '未知' : 'unknown' : String(result.dataset.coverage.delayed)}</p>
      {!!result.dataset.coverage.missing.length && <p className="break-words">{result.dataset.coverage.missing.slice(0,10).join(' · ')}{result.dataset.coverage.missing.length > 10 ? ' …' : ''}</p>}
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={download.isPending} onClick={() => download.mutate()}>{zh ? '下载全部行' : 'Download all rows'}</Button>
        {result.libraryReference && <Button asChild variant="outline"><Link to={`/data?source=${encodeURIComponent(result.libraryReference.sourceId)}`}>{zh ? '查看保存版本' : 'View saved version'}</Link></Button>}</div>
      {download.isError && <p role="alert">{dataError(download.error, zh)}</p>}
      {rows.length > 0 && <details><summary>{zh ? '查看行样本' : 'View row sample'}</summary><pre className="overflow-x-auto text-xs">{JSON.stringify(rows, null, 2)}</pre></details>}
    </section>}
    {usable && result.operation === 'quote' && <dl className="financial-quote">
      <div><dt>{zh ? '价格' : 'Price'}</dt><dd>{displayValue(data.price)} {displayValue(data.currency) === '—' ? '' : displayValue(data.currency)}</dd></div>
      <div><dt>{zh ? '前收盘' : 'Previous close'}</dt><dd>{displayValue(data.previousClose)}</dd></div>
    </dl>}
    {usable && points.length > 0 && <div className="financial-history">
      <table><caption>{zh ? `最近 ${Math.min(points.length, 20)} 个交易日 · 原始收盘价` : `Latest ${Math.min(points.length, 20)} sessions · Unadjusted close`}</caption>
        <thead><tr><th>{zh ? '日期' : 'Date'}</th><th>{zh ? '收盘价' : 'Close'}</th></tr></thead>
        <tbody>{points.slice(-20).reverse().map((point: Record<string, unknown>, index: number) => <tr key={`${displayValue(point.date)}-${index}`}><td>{displayValue(point.date)}</td><td>{displayValue(point.close)}</td></tr>)}</tbody>
      </table>
    </div>}
    {usable && evidence.length > 0 && <div className="financial-evidence">
      {evidence.slice(0, 8).map((item: Record<string, unknown>, index: number) => <article key={index}>
        <h4>{displayValue(item.title) === '—' ? `${zh ? '来源条目' : 'Source item'} ${index + 1}` : displayValue(item.title)}</h4>
        <p>{displayValue(item.content)}</p>
      </article>)}
    </div>}
    {result.sources.length > 0 && <div className="financial-sources-list">
      <h4>{zh ? '来源与获取时间' : 'Sources and retrieval times'}</h4>
      {result.sources.map((source: DataFinancialQueryResult['sources'][number], index: number) => {
        const url = safeSourceUrl(source.url);
        return <div key={`${source.title}-${index}`}>
          {url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.title}<ExternalLink size={12} aria-hidden /></a> : <span>{source.title}</span>}
          <time>{dataTime(source.fetchedAt, language)}</time>
        </div>;
      })}
    </div>}
    {usable && result.data !== null && <details className="data-query-result">
      <summary>{result.dataset ? zh ? '查看预览与元数据' : 'View preview and metadata' : zh ? '查看完整结构化结果' : 'View the full structured result'}</summary>
      <pre>{JSON.stringify(result.data, null, 2)}</pre>
    </details>}
  </section>;
}

function ProviderConfiguration({ connection, zh, language }: {
  connection: DataFinancialConnection; zh: boolean; language: string;
}) {
  const client = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const [clearing, setClearing] = useState(false);
  const structured = connection.provider === 'aktools' || connection.provider === 'tushare';
  const [symbol, setSymbol] = useState(structured ? '000001' : 'AAPL');
  const [exchange, setExchange] = useState('SZSE');
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0,10));
  const [adjustment, setAdjustment] = useState<'unadjusted' | 'forward' | 'backward'>('unadjusted');
  const [operationDraft, setOperationDraft] = useState<DataFinancialOperation | null>(null);
  const enabled = enabledDraft ?? connection.enabled;
  const operation = connection.capabilities.find((item: DataFinancialOperation) => item === operationDraft)
    ?? connection.capabilities[0];
  const hk = connection.provider === 'aktools' && operation === 'financials';
  const dirty = Boolean(apiKey.trim()) || enabled !== connection.enabled;
  const keyNeeded = connection.requiresKey && (!connection.configured || connection.needsReentry);

  async function refresh(): Promise<void> {
    await Promise.all([
      client.invalidateQueries({ queryKey: providersKey }),
      client.invalidateQueries({ queryKey: ['settings', 'integrations'] }),
    ]);
  }

  const save = useMutation({
    retry: false,
    mutationFn: () => dataLibraryApi.saveProvider(connection.provider, {
      enabled, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }),
    onSuccess: async () => { setApiKey(''); await refresh(); setEnabledDraft(null); },
  });
  const test = useMutation({
    retry: false, mutationFn: () => dataLibraryApi.testProvider(connection.provider), onSuccess: refresh,
  });
  const query = useMutation({
    retry: false,
    mutationFn: () => dataLibraryApi.queryProvider({ provider: connection.provider, symbol: symbol.trim().toUpperCase(), operation,
      ...(structured ? { market: hk ? 'HK' as const : 'CN' as const, exchange: hk ? 'HKEX' : exchange, from, to,
        ...(connection.provider === 'aktools' && operation === 'daily-history' ? { adjustment } : {}) } : {}) }),
  });
  const remove = useMutation({
    retry: false, mutationFn: () => dataLibraryApi.removeProvider(connection.provider),
    onSuccess: async () => {
      setApiKey(''); setEnabledDraft(null); setClearing(false); test.reset(); query.reset(); save.reset();
      await refresh();
    },
  });
  const busy = save.isPending || test.isPending || query.isPending || remove.isPending;
  const canRequest = connection.enabled && connection.configured && !connection.needsReentry && !dirty;
  const testOk = test.data?.ok ?? connection.lastTestOk;
  const testedAt = test.data?.testedAt ?? connection.lastTestAt;
  const testCode = test.data?.code ?? connection.lastTestCode;
  const inputId = `financial-key-${connection.provider}`;

  return <section className="data-panel financial-configuration" aria-labelledby="financial-provider-title">
    <header className="financial-heading"><h2 id="financial-provider-title">{connection.name}</h2><Badge variant="secondary">{connectionLabel(connection, zh)}</Badge></header>
    <p className="financial-description">{connection.description}</p>
    {connection.provider === 'aktools' && <p className="data-notice">{zh ? '由部署者配置固定本地 AKTools MCP 地址；在工具连接中发现并授权 get_data 为只读、允许公开数据后可查询。A 股日线需明确交易所；港股利润表请填写五位代码。' : 'The deployer configures a fixed local AKTools MCP endpoint. Discover the connection and approve get_data as read-only for public data. A-share history requires an explicit exchange; HK income statements use a five-digit symbol.'}</p>}
    <form className="financial-settings" onSubmit={event => { event.preventDefault(); test.reset(); query.reset(); save.mutate(); }}>
      {connection.requiresKey && <label className="data-field" htmlFor={inputId}>API Key
        <Input id={inputId} type="password" autoComplete="new-password" maxLength={4096} value={apiKey}
          disabled={busy} placeholder={connection.hasApiKey ? zh ? '已加密保存，留空保留' : 'Encrypted key saved; leave blank to keep' : zh ? '输入供应商 API Key' : 'Enter the provider API key'}
          onChange={event => { setApiKey(event.target.value); save.reset(); }} />
        <span>{zh ? '密钥只用于访问该供应商，不会作为研究资料发送给模型。' : 'The key is used only for this provider and is excluded from research material.'}</span>
      </label>}
      {connection.needsReentry && <p className="data-notice data-warning" role="alert">{issueLabel('CREDENTIAL_UNREADABLE', zh)}</p>}
      <div className="financial-capabilities"><h3>{zh ? '可查询的数据' : 'Available data'}</h3>
        <div>{connection.capabilities.map((capability: DataFinancialOperation) => <Badge variant="outline" key={capability}>{operationLabel(capability, zh)}</Badge>)}</div>
        <p>{zh ? '覆盖市场' : 'Markets'}：{connection.markets.join(' · ') || '—'}</p>
      </div>
      <label className="financial-enabled"><span>{zh ? '启用研究查询' : 'Enable research queries'}</span><Switch checked={enabled} disabled={busy} onCheckedChange={(value: boolean) => { setEnabledDraft(value); save.reset(); }} /></label>
      {connection.provider === 'public' && <p className="financial-hint">{zh ? '控制数据中心和研究工具中的公开行情查询。账户估值与模拟盘的基础报价仍按原规则运行。' : 'Controls public quote queries in the data center and research tool. Account valuation and simulation price feeds continue under their existing rules.'}</p>}
      <div className="financial-actions">
        <Button type="submit" disabled={busy || !dirty || (keyNeeded && !apiKey.trim())}>{save.isPending && <LoaderCircle className="animate-spin" />}{zh ? '保存设置' : 'Save settings'}</Button>
        <Button type="button" variant="outline" disabled={busy || !canRequest} onClick={() => test.mutate()}>{test.isPending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{zh ? '测试连接' : 'Test connection'}</Button>
        {connection.hasApiKey && <Button type="button" variant="ghost" disabled={busy} onClick={() => setClearing(true)}>{zh ? '清除密钥' : 'Clear key'}</Button>}
      </div>
      {dirty && <p className="financial-hint">{zh ? '有未保存的修改。保存后再测试或查询。' : 'There are unsaved changes. Save before testing or querying.'}</p>}
      {save.isSuccess && !dirty && <p className="financial-hint" role="status">{zh ? '设置已保存，尚未因此验证连接。' : 'Settings saved. This does not verify the connection.'}</p>}
      {save.isError && <p role="alert" className="text-sm text-destructive">{dataError(save.error, zh)}</p>}
    </form>
    {test.isPending ? <p className="data-notice" role="status">{zh ? '正在向供应商请求样例数据…' : 'Requesting sample data from the provider…'}</p>
      : test.isError ? <p className="data-notice data-warning" role="alert">{zh ? '连接测试未完成，请稍后重试。' : 'The connection test did not complete. Retry later.'}</p>
        : testedAt && testOk !== null ? <div className={`data-notice ${testOk ? '' : 'data-warning'}`} role="status">
          <div className="financial-test-title">{testOk ? <CheckCircle2 size={17} aria-hidden /> : <TriangleAlert size={17} aria-hidden />}<strong>{testOk ? zh ? '上次连接测试成功' : 'Last connection test succeeded' : zh ? '上次连接测试失败' : 'Last connection test failed'}</strong></div>
          <p>{dataTime(testedAt, language)}</p>{!testOk && <p>{issueLabel(testCode, zh)}</p>}
          <p>{zh ? '配额与接口权限仍以供应商账户为准。' : 'Quotas and endpoint access depend on the provider account.'}</p>
        </div> : <p className="financial-hint">{zh ? '尚未测试连接。' : 'The connection has not been tested.'}</p>}
    <form className="financial-query" onSubmit={event => { event.preventDefault(); query.mutate(); }}>
      <h3>{zh ? '查询一只证券' : 'Look up a security'}</h3>
      <div className="financial-query-fields">
        <label className="data-field">{zh ? '证券代码' : 'Symbol'}<Input required maxLength={20} pattern="[A-Za-z0-9][A-Za-z0-9.\^\-]{0,19}" value={symbol} disabled={busy} onChange={event => setSymbol(event.target.value)} placeholder="AAPL" /></label>
        <label className="data-field">{zh ? '数据类型' : 'Data type'}<NativeSelect value={operation ?? ''} disabled={busy || !operation} onChange={event => {
          const next = connection.capabilities.find((item: DataFinancialOperation) => item === event.target.value);
          if (next) setOperationDraft(next);
        }}>{connection.capabilities.map((capability: DataFinancialOperation) => <option key={capability} value={capability}>{operationLabel(capability, zh)}</option>)}</NativeSelect></label>
        {structured && <>
          <label className="data-field">{zh ? '市场 / 交易所' : 'Market / exchange'}<NativeSelect value={hk ? 'HKEX' : exchange} disabled={busy || hk} onChange={event => setExchange(event.target.value)}>
            {hk ? <option value="HKEX">HK · HKEX</option> : <><option value="SZSE">CN · SZSE</option><option value="SSE">CN · SSE</option>{connection.provider === 'tushare' && <option value="BSE">CN · BSE</option>}</>}
          </NativeSelect></label>
          <label className="data-field">{zh ? '开始日期' : 'From'}<Input value={from} placeholder="YYYY-MM-DD" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" required disabled={busy} onChange={event => setFrom(event.target.value)} /></label>
          <label className="data-field">{zh ? '结束日期' : 'To'}<Input value={to} placeholder="YYYY-MM-DD" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}" required disabled={busy} onChange={event => setTo(event.target.value)} /></label>
          {connection.provider === 'aktools' && operation === 'daily-history' && <label className="data-field">{zh ? '复权' : 'Adjustment'}<NativeSelect value={adjustment} disabled={busy} onChange={event => {
            if (event.target.value === 'unadjusted' || event.target.value === 'forward' || event.target.value === 'backward') setAdjustment(event.target.value);
          }}><option value="unadjusted">{zh ? '不复权' : 'Unadjusted'}</option><option value="forward">{zh ? '前复权' : 'Forward adjusted'}</option><option value="backward">{zh ? '后复权' : 'Backward adjusted'}</option></NativeSelect></label>}
        </>}
        <Button type="submit" disabled={busy || !canRequest || !symbol.trim() || !operation}>{query.isPending && <LoaderCircle className="animate-spin" />}{zh ? '查询数据' : 'Query data'}</Button>
      </div>
      <p className="financial-hint">{connection.provider === 'alpha-vantage'
        ? zh ? 'Alpha Vantage 返回日终数据，不用作模拟盘实时成交报价。' : 'Alpha Vantage returns end-of-day data, not real-time simulation execution prices.'
        : zh ? '只展示实际返回的数据与来源时间。缺失的数据保持缺失。' : 'Only actual provider results and timestamps are shown. Missing data remains missing.'}</p>
    </form>
    {query.isError && <p role="alert" className="data-notice data-warning">{zh ? '查询未完成，未取得新的结果。请稍后重试。' : 'The query did not complete and no new result was received. Retry later.'}</p>}
    {query.data && <QueryResult result={query.data} zh={zh} language={language} />}
    <AlertDialog open={clearing} onOpenChange={(open: boolean) => { if (!remove.isPending) setClearing(open); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{zh ? `清除 ${connection.name} 的密钥？` : `Clear the ${connection.name} key?`}</AlertDialogTitle>
        <AlertDialogDescription>{zh ? '已保存的密钥会移除，之后需要重新配置才能使用此来源。现有研究记录仍会保留。' : 'The saved key will be removed. Configure it again before using this source. Existing research records remain.'}</AlertDialogDescription></AlertDialogHeader>
        {remove.isError && <p role="alert" className="text-sm text-destructive">{dataError(remove.error, zh)}</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={remove.isPending}>{zh ? '取消' : 'Cancel'}</AlertDialogCancel>
          <AlertDialogAction disabled={remove.isPending} onClick={event => { event.preventDefault(); remove.mutate(); }}>{zh ? '确认清除' : 'Clear key'}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}

export default function FinancialSources() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [selected, setSelected] = useState<DataFinancialProvider | null>(null);
  const providers = useQuery({ queryKey: providersKey, queryFn: dataLibraryApi.providers, retry: false });
  const active = providers.data?.providers.find((connection: DataFinancialConnection) => connection.provider === selected)
    ?? providers.data?.providers[0];

  if (providers.isPending) return <div className="data-panel data-empty" role="status"><LoaderCircle className="animate-spin" />{zh ? '正在读取数据源…' : 'Loading data providers…'}</div>;
  if (providers.isError) return <div className="data-panel data-empty" role="alert"><TriangleAlert /><p>{zh ? '数据源配置暂时无法读取。' : 'Provider settings could not be loaded.'}</p><Button variant="outline" onClick={() => void providers.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>;
  if (!active) return <div className="data-panel data-empty"><Database /><p>{zh ? '当前没有可用的数据源。' : 'No providers are available.'}</p></div>;

  return <div className="data-config-layout financial-layout">
    <aside className="data-panel financial-provider-list" aria-label={zh ? '选择数据源' : 'Choose a data provider'}>
      <h2>{zh ? '可用数据源' : 'Data providers'}</h2>
      <div className="data-list">{providers.data?.providers.map((connection: DataFinancialConnection) => <button
        type="button" key={connection.provider} className="data-item financial-provider"
        aria-pressed={active.provider === connection.provider} onClick={() => setSelected(connection.provider)}>
        <strong>{connection.name}</strong>
        <span>{connection.capabilities.map((capability: DataFinancialOperation) => operationLabel(capability, zh)).join(' · ')}</span>
        <Badge variant="secondary">{connectionLabel(connection, zh)}</Badge>
      </button>)}</div>
    </aside>
    <ProviderConfiguration key={active.provider} connection={active} zh={zh} language={i18n.language} />
  </div>;
}
