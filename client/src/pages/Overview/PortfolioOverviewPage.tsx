import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PortfolioComparisonPanel from '@/features/portfolio-comparison/PortfolioComparisonPanel';

/** Opening overview only reads saved observations and never schedules research. */
export default function PortfolioOverviewPage() {
  const { i18n } = useTranslation();
  const [params] = useSearchParams();
  const location = useLocation();
  // Persisted channel links predate the overview route. Preserve their exact
  // strategy or immutable report target without mounting any overview readers.
  if (params.get('investmentStrategyId')) {
    return <Navigate replace to={{ pathname: '/paper', search: params.toString(), hash: location.hash }} />;
  }
  const reportId = params.get('reportId');
  if (reportId) {
    const remaining = new URLSearchParams(params);
    remaining.delete('reportId');
    return <Navigate replace to={{ pathname: `/analysis/reports/${encodeURIComponent(reportId)}`, search: remaining.toString(), hash: location.hash }} />;
  }
  const selected = params.get('accountIds');
  const accountIds = selected ? [...new Set(['real', ...selected.split(',').filter(Boolean)])] : undefined;
  const zh = i18n.language.startsWith('zh');
  return <div className="portfolio-page">
    <header className="portfolio-page-header"><div><h1>{zh ? '投资总览' : 'Portfolio overview'}</h1><p>{zh ? '观察表现，验证每一个策略。' : 'Follow performance. Put every strategy to the test.'}</p></div>
      <Button asChild><Link to="/paper?create=1"><Plus size={16} />{zh ? '新建模拟仓' : 'New simulation'}</Link></Button>
    </header>
    <PortfolioComparisonPanel key={selected ?? 'all'} initialAccountIds={accountIds} showHeadline showAccounts />
    <div className="portfolio-research-entry"><div><h2>{zh ? '下一步，回到研究' : 'Next, return to your research'}</h2><p>{zh ? '阅读判断与依据，再决定是否调整某个模拟仓的策略。' : 'Read the evidence before changing a simulation’s strategy.'}</p></div><Link to="/analysis">{zh ? '查看研究报告' : 'Read research reports'}<ArrowRight size={16} /></Link></div>
  </div>;
}
