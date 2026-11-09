import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowRight, Check, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchPortfolioComparison } from '@/api/portfolio-comparison';
import type { PortfolioComparisonMetric, PortfolioComparisonPeriod } from '@shared/portfolio-comparison.interface';
import PortfolioComparisonChart from './PortfolioComparisonChart';
import { accountColor, comparisonGapLabel } from './comparison-chart-options';

interface Props { accountIds?: string[]; initialAccountIds?: string[]; compact?: boolean; showAccounts?: boolean; showHeadline?: boolean }

export default function PortfolioComparisonPanel({ accountIds, initialAccountIds, compact, showAccounts, showHeadline }: Props) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [period, setPeriod] = useState<PortfolioComparisonPeriod>('1M');
  const [metric, setMetric] = useState<PortfolioComparisonMetric>('equity');
  const [selectedIds, setSelectedIds] = useState<string[] | null>(initialAccountIds ?? null);
  const [showSettings, setShowSettings] = useState(false);
  const comparison = useQuery({ queryKey: ['portfolio-comparison', period, accountIds ?? 'all'],
    queryFn: () => fetchPortfolioComparison(period, accountIds), refetchInterval: 60_000 });
  const money = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 2 }).format(value);
  const percentage = (value: number | null | undefined) => value == null ? (zh ? '待核对' : 'Unavailable') : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  const series = comparison.data?.series ?? [];
  const isSelected = (id: string) => selectedIds === null || selectedIds.includes(id);
  const selected = series.filter(item => isSelected(item.accountId));
  const real = series.find(item => item.kind === 'real');
  const toggle = (id: string) => setSelectedIds(previous => {
    const current = previous ?? series.map(item => item.accountId);
    return current.includes(id) ? current.filter(value => value !== id) : [...current, id];
  });
  const label = (item: typeof series[number]) => item.kind === 'real' ? (zh ? '实仓' : 'Real portfolio') : item.name;
  const status = (value: string) => ({ real: zh ? '真实资产' : 'Real assets', running: zh ? '运行中' : 'Running', paused: zh ? '已暂停' : 'Paused', archived: zh ? '已归档' : 'Archived' })[value] ?? value;
  if (comparison.isPending) return <div className="portfolio-loading" role="status">{zh ? '正在读取账户估值…' : 'Loading saved valuations…'}</div>;
  if (comparison.isError) return <div className="portfolio-notice" role="alert"><AlertCircle size={18} /><span>{zh ? '账户估值暂时无法读取。' : 'Unable to read account valuations.'}</span><Button variant="outline" onClick={() => void comparison.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>;
  return <section className="portfolio-comparison" aria-label={zh ? '账户表现' : 'Account performance'}>
    {showHeadline && <div className="portfolio-hero">
      <div><p className="portfolio-eyebrow">{zh ? '我的实仓 · 最近一次净资产估值' : 'My portfolio · Latest saved net assets'}</p>
        <div className="portfolio-amount">{money(real?.equityUsd)}</div>
        <p className="portfolio-valuation-time">{real?.valuationAsOf ? `${zh ? '估值截至' : 'Valued at'} ${new Date(real.valuationAsOf).toLocaleString(zh ? 'zh-CN' : 'en-US')}` : (zh ? '导入资产后开始记录估值' : 'Import your assets to start recording valuations')}</p>
      </div>
      <div className="portfolio-metric-toggle" role="group" aria-label={zh ? '图表指标' : 'Chart metric'}>
        <Button variant={metric === 'equity' ? 'default' : 'outline'} onClick={() => setMetric('equity')} aria-pressed={metric === 'equity'}>{zh ? '资产金额' : 'Equity'}</Button>
        <Button variant={metric === 'return' ? 'default' : 'outline'} onClick={() => setMetric('return')} aria-pressed={metric === 'return'}>{zh ? '收益率 %' : 'Return %'}</Button>
      </div>
    </div>}
    <div className="portfolio-chart-controls">
      <div className="portfolio-periods" role="group" aria-label={zh ? '时间范围' : 'Period'}>
        {(['1D', '1W', '1M', '3M', 'YTD', 'ALL'] as const).map((value, index) => <Button key={value} size="sm" variant={period === value ? 'default' : 'ghost'} aria-pressed={period === value} onClick={() => setPeriod(value)}>{zh ? ['1日', '1周', '1月', '3月', '今年', '全部'][index] : value}</Button>)}
      </div>
      <div className="portfolio-chart-actions">
        {!showHeadline && <select aria-label={zh ? '图表指标' : 'Chart metric'} value={metric} onChange={event => setMetric(event.target.value as PortfolioComparisonMetric)}><option value="equity">{zh ? '资产金额' : 'Equity'}</option><option value="return">{zh ? '收益率 %' : 'Return %'}</option></select>}
        <Button variant="outline" size="sm" aria-expanded={showSettings} onClick={() => setShowSettings(!showSettings)}><SlidersHorizontal size={14} />{zh ? '比较设置' : 'Compare'}</Button>
      </div>
    </div>
    {showSettings && <div className="portfolio-comparison-settings">
      <strong>{zh ? '同图显示的账户' : 'Accounts on this chart'}</strong>
      <div className="portfolio-account-checks">{series.map(item => <label key={item.accountId}><input type="checkbox" checked={isSelected(item.accountId)} onChange={() => toggle(item.accountId)} />{label(item)}</label>)}</div>
      <p>{zh ? '金额包含资金转入转出。收益率仅在区间资金记录与资产起点保持连续时显示；每仓从该区间首个可信估值开始。不同账户的估值时点可能不同。' : 'Equity includes external transfers. Returns appear only with continuous cash-flow and balance records, starting at each account’s first trusted observation in the period. Valuation times can differ.'}</p>
    </div>}
    <div className="portfolio-legend">{series.map(item => <button key={item.accountId} type="button" aria-pressed={isSelected(item.accountId)} className={isSelected(item.accountId) ? '' : 'muted'} onClick={() => toggle(item.accountId)}>
      <span className="portfolio-color-dot" style={{ background: accountColor(item.accountId, item.colorIndex) }} /><span>{label(item)}</span><span className="portfolio-legend-value">{metric === 'equity' ? money(item.equityUsd) : percentage(item.returnPct)}</span>
    </button>)}</div>
    <PortfolioComparisonChart series={selected} metric={metric} compact={compact} />
    <div className="portfolio-chart-caption"><span>{zh ? 'USD · 保存的估值记录 · 缺失日期断线' : 'USD · Saved observations · Gaps remain visible'}</span><span>{zh ? '指向曲线查看估值时点' : 'Point to a line to inspect its valuation'}</span></div>
    {selected.some(item => item.gaps.length) && <details className="portfolio-data-notes"><summary><AlertCircle size={14} />{zh ? '估值与比较说明' : 'Valuation and comparison notes'}</summary>
      {selected.filter(item => item.gaps.length).map(item => <p key={item.accountId}><strong>{label(item)}：</strong>{[...new Set(item.gaps.map(gap => comparisonGapLabel(gap, zh)))].join(zh ? '；' : '; ')}</p>)}</details>}
    {showAccounts && <section className="portfolio-account-section"><div className="portfolio-section-heading"><h2>{zh ? '我的账户' : 'My accounts'}</h2><span>{zh ? `${series.filter(item => item.kind === 'simulation').length} 个独立模拟仓` : `${series.filter(item => item.kind === 'simulation').length} independent simulations`}</span></div>
      <div className="portfolio-account-grid">{series.map(item => <Link className="portfolio-account-card" key={item.accountId} to={item.kind === 'real' ? '/holdings' : `/paper/${item.accountId}`}>
        <div className="portfolio-account-card-heading"><span><i className="portfolio-color-dot" style={{ background: accountColor(item.accountId, item.colorIndex) }} />{label(item)}</span><small>{item.kind === 'real' ? (zh ? '实仓' : 'Real') : (zh ? '模拟' : 'Simulation')}</small></div>
        <strong className="portfolio-account-value">{money(item.equityUsd)}</strong>
        <p className={item.returnPct == null ? 'text-muted-foreground' : item.returnPct >= 0 ? 'text-success' : 'text-destructive'}>{percentage(item.returnPct)} <small>{item.returnFrom ? `${zh ? '自' : 'from'} ${new Date(item.returnFrom).toLocaleDateString(zh ? 'zh-CN' : 'en-US')}` : ''}</small></p>
        <div className="portfolio-account-card-footer"><span className={item.status === 'running' ? 'text-success' : ''}>{item.status === 'running' && <Check size={12} />}{status(item.status)}{item.kind === 'simulation' && ` · ${item.strategyCount} ${zh ? '个策略' : 'strategies'}`}</span><span>{zh ? '管理' : 'Manage'} <ArrowRight size={14} /></span></div>
      </Link>)}</div>
    </section>}
  </section>;
}
