import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PortfolioComparisonPanel from '@/features/portfolio-comparison/PortfolioComparisonPanel';
import CouncilMemberAvatar from '@/pages/Council/CouncilMemberAvatar';
import GuidedOnboarding from '@/features/onboarding/GuidedOnboarding';

/** Opening overview reads current marks and saved NAV; public history warms asynchronously without research. */
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
    <header className="portfolio-page-header"><div><h1>{zh ? '今天，和股友一起看看投资' : 'A fresh look at your investments'}</h1><p>{new Date().toLocaleDateString(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' })} · {zh ? '独立记录，回看每一次判断' : 'Independent records for every investment idea'}</p></div>
      <Button asChild><Link to="/paper?create=1"><Plus size={16} />{zh ? '新建模拟仓' : 'New simulation'}</Link></Button>
    </header>
    <GuidedOnboarding />
    <PortfolioComparisonPanel key={selected ?? 'all'} initialAccountIds={accountIds} showHeadline showAccounts persistView />
    <div className="portfolio-next-steps">
      <section><h2>{zh ? '我的真实资产' : 'My real portfolio'}</h2><p>{zh ? '查看持仓与现金，核对真实成交。模拟实验单独记录，不计入实仓资产。' : 'Review holdings, cash and recorded trades. Simulated funds are kept separate from your real portfolio.'}</p><Button asChild variant="outline"><Link to="/holdings?accountId=real">{zh ? '查看资产与账户' : 'View assets and accounts'}<ArrowRight size={15} /></Link></Button></section>
      <section><div className="flex items-center gap-3"><CouncilMemberAvatar avatar="moderator" role="manager" /><h2>{zh ? '今天的投资日报' : 'Your investment daily'}</h2></div><p>{zh ? '看看股友的模拟行动、未执行的原因，以及对个人持仓的观察。' : 'Review simulated actions, reasons for waiting, and observations about your holdings.'}</p><Button asChild><Link to="/daily">{zh ? '阅读投资日报' : 'Read the investment daily'}<ArrowRight size={15} /></Link></Button></section>
    </div>
    <section className="portfolio-research-entry"><div className="flex items-start gap-4"><CouncilMemberAvatar avatar="value" role="researcher" /><div><h2>{zh ? '有个想法，先和股友聊聊' : 'Have an idea? Talk it through'}</h2><p>{zh ? '不用一次说清楚。一步一步核对规则，再决定应用到哪个模拟仓。' : 'You do not need every detail at once. Clarify the rules step by step, then choose a simulation.'}</p></div></div><Link to="/strategies/new">{zh ? '一起聊出策略' : 'Clarify a strategy'}<ArrowRight size={16} /></Link></section>
  </div>;
}
