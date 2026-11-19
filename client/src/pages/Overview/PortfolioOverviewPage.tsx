import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import { fetchOverallDailyResearch } from '@/api/workspace';
import AnimalAvatar from '@/components/AnimalAvatar';
import { Button } from '@/components/ui/button';
import { holdingsHref } from '@/features/assets/account-context';
import PortfolioComparisonPanel from '@/features/portfolio-comparison/PortfolioComparisonPanel';
import { formatComparisonTime } from '@/features/portfolio-comparison/comparison-chart-options';

export default function PortfolioOverviewPage() {
  const [params] = useSearchParams();
  const location = useLocation();
  if (params.get('investmentStrategyId')) {
    return <Navigate replace to={{ pathname: '/paper', search: location.search, hash: location.hash }} state={location.state} />;
  }
  const reportId = params.get('reportId');
  if (reportId) {
    const remaining = new URLSearchParams(params);
    remaining.delete('reportId');
    return <Navigate replace to={{ pathname: `/analysis/reports/${encodeURIComponent(reportId)}`, search: remaining.toString(), hash: location.hash }} state={location.state} />;
  }
  const selected = params.get('accountIds');
  const initialAccountIds = selected ? [...new Set(['real', ...selected.split(',').filter(Boolean)])] : undefined;
  return <Overview key={selected ?? 'all'} initialAccountIds={initialAccountIds} />;
}

function Overview({ initialAccountIds }: { initialAccountIds?: string[] }) {
  const { i18n } = useTranslation();
  const language = i18n.language;
  const zh = language.startsWith('zh');
  const location = useLocation();
  const returnState = { returnTo: `${location.pathname}${location.search}${location.hash}` };
  const now = new Date();
  const dateOptions = { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  const date = new Intl.DateTimeFormat('sv-SE', dateOptions).format(now);
  const accounts = useQuery({
    queryKey: portfolioWorkspaceKeys.accounts,
    queryFn: portfolioWorkspaceApi.accounts,
    retry: false,
  });
  const daily = useQuery({
    queryKey: ['overall-daily-research', date],
    queryFn: () => fetchOverallDailyResearch(date),
    retry: false,
  });
  const report = daily.data?.reports[0];
  const formerTeamIds = new Set((accounts.data ?? []).filter(account => account.formerTeam).map(account => account.id));
  const visibleAccounts = [
    { id: 'real', name: zh ? '我的实仓' : 'My real portfolio', companionId: 'value' as const },
    ...(accounts.data ?? []).filter(account => account.status !== 'archived' && !account.formerTeam),
  ];
  return <div className="portfolio-page portfolio-overview space-y-5">
    <header className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-[32px]">{zh ? '投资总览' : 'Investment overview'}</h1>
      <p className="text-sm text-muted-foreground">
        <time dateTime={date}>{new Intl.DateTimeFormat(language, { ...dateOptions, month: 'long', day: 'numeric' }).format(now)}</time>
        {' · '}{zh ? '北京时间' : 'Beijing time'}
      </p>
    </header>
    <PortfolioComparisonPanel initialAccountIds={initialAccountIds} defaultExcludedAccountIds={formerTeamIds} persistView />
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <section className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
        <h2 className="mb-4 text-lg font-semibold">{zh ? '我的账户' : 'My accounts'}</h2>
        <ul className="divide-y border-y last:border-b-0">
          {visibleAccounts.map(account => <li key={account.id} className="flex min-h-14 min-w-0 items-center justify-between gap-2 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <AnimalAvatar avatar={account.companionId ?? 'moderator'} role="researcher" className="size-7" />
              <span className="min-w-0 break-words text-sm font-semibold">{account.name}</span>
            </div>
            <Button asChild variant="ghost" size="sm" className="shrink-0 px-0 text-primary">
              <Link to={holdingsHref(account.id)} state={returnState} aria-label={zh ? `查看持仓 · ${account.name}` : `View holdings · ${account.name}`}>
                {zh ? '查看持仓' : 'View holdings'}<ArrowRight size={15} aria-hidden="true" />
              </Link>
            </Button>
          </li>)}
        </ul>
        {accounts.isError && <p role="status" className="mt-2 text-sm text-muted-foreground">{zh ? '暂时无法读取模拟账户。' : 'Simulation accounts are temporarily unavailable.'}</p>}
      </section>
      <section className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5">
        <h2 className="text-lg font-semibold">{zh ? '今天的投资日报' : 'Today’s investment daily'}</h2>
        {report ? <>
          <p className="break-words font-medium">{report.title}</p>
          <p className="text-xs text-muted-foreground"><time dateTime={report.createdAt}>{formatComparisonTime(report.createdAt, language)}</time>
            {' · '}{zh ? '已发布' : 'Published'}</p>
        </> : <p className="text-sm text-muted-foreground" role="status">
          {daily.isPending ? (zh ? '正在读取日报…' : 'Loading the daily report…') :
            daily.isError ? (zh ? '暂时无法读取日报。' : 'The daily report is temporarily unavailable.') :
            (zh ? '今天还没有已发布的总体日报。' : 'No overall daily report has been published today.')}
        </p>}
        <Button asChild size="sm" variant="ghost" className="px-0 text-primary">
          <Link to="/daily" state={returnState}>{zh ? '阅读投资日报' : 'Read the investment daily'}<ArrowRight size={15} aria-hidden="true" /></Link>
        </Button>
      </section>
    </div>
  </div>;
}
