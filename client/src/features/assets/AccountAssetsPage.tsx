import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TeamListResult } from '@shared/team-workspace.interface';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import http from '@/api/http';
import { useSimpleExperience } from '@/hooks/use-simple-experience';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { readAssetAccount, assetHref, holdingsHref, SIMULATION_ACCOUNTS_PATH } from './account-context';
import { simulationAccountPath } from '@/utils/portfolio-workspace';
import PaperAccountAssets from './PaperAccountAssets';

/** Ownership comes from team bindings; companion presentation metadata is never a team. */
function useAccountTeams(enabled: boolean) {
  return useQuery({
    queryKey: ['asset-account-teams'], enabled, retry: false,
    queryFn: async () => {
      const items: TeamListResult['items'] = [];
      let cursor: string | undefined;
      do {
        const result = (await http.get<TeamListResult>('/api/teams', { params: { limit: 100, cursor } })).data;
        items.push(...result.items);
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      return items;
    },
  });
}

export function AccountAssetsPage({ real, mode }: { real: ReactNode; mode: 'holdings' | 'transactions' }) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const { enabled: simple } = useSimpleExperience();
  const location = useLocation();
  const navigate = useNavigate();
  const accountViews = useRef(new Map<string, string>());
  let id: string | null = null;
  try { id = readAssetAccount(location.search).id; } catch { /* Explicit invalid context is rendered below. */ }
  const accounts = useQuery({ queryKey: portfolioWorkspaceKeys.accounts, queryFn: portfolioWorkspaceApi.accounts, retry: false });
  const teams = useAccountTeams(id !== null && id !== 'real');
  const selected = accounts.data?.find(item => item.id === id);
  const team = teams.data?.find(item => item.accountId === id && item.binding?.state === 'active');
  useEffect(() => {
    if (id) accountViews.current.set(id, location.search);
  }, [id, location.search]);

  const returnTo = location.pathname + location.search + location.hash;
  const realName = zh ? '我的实仓' : 'My real portfolio';
  const activeAccounts = (accounts.data ?? []).filter(item => item.status !== 'archived' || item.id === id);
  const choices = [
    { id: 'real', name: realName },
    ...activeAccounts.map(item => ({
      id: item.id,
      name: item.name + (item.status === 'archived' ? ' · ' + t('assets.archived') : ''),
    })),
  ];
  if (id && !choices.some(item => item.id === id)) choices.push({ id, name: t('assets.simulation') });
  const switchHref = (nextId: string) => assetHref(location.pathname, nextId, accountViews.current.get(nextId));
  const content = !id
    ? <p role="alert" className="rounded-xl border border-destructive/40 p-6">{t('assets.invalidAccount')}</p>
    : id === 'real' ? real : <PaperAccountAssets key={id} accountId={id} accountName={selected?.name ?? id}
      archived={selected?.status === 'archived'} mode={mode} summary={simple && mode === 'holdings'} teamId={team?.id} />;
  const selectAccount = <Select value={id ?? '__invalid__'} onValueChange={nextId => navigate(switchHref(nextId))}>
    <SelectTrigger id="asset-account-selector" className="w-full max-w-sm" aria-label={t('assets.switchAccount')}><SelectValue /></SelectTrigger>
    <SelectContent>
      {!id && <SelectItem value="__invalid__" disabled>{t('assets.invalidAccount')}</SelectItem>}
      {choices.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
    </SelectContent>
  </Select>;
  const watchlist = id && assetHref('/watchlist', id, new URLSearchParams({ returnTo }).toString());

  if (simple) return <div className="portfolio-page space-y-5">
    {mode === 'holdings' && <header className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-[32px]">{t('holdings.title')}</h1>
      {id === 'real' && <Button asChild><Link to="/import?accountId=real" state={{ returnTo }}>
        {zh ? '导入持仓' : 'Import holdings'}
      </Link></Button>}
    </header>}
    <section className="space-y-3" aria-label={t('assets.accountContext')}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs text-muted-foreground">{zh ? '当前账户' : 'Current account'}</p>
          {choices.length <= 3 && id ? <nav className="account-segments" aria-label={t('assets.switchAccount')}>
            {choices.map(item => <Button key={item.id} asChild variant="ghost" size="sm">
              <Link to={switchHref(item.id)} aria-current={id === item.id ? 'page' : undefined}>{item.name}</Link>
            </Button>)}
          </nav> : selectAccount}
        </div>
        <Button asChild variant="outline" size="sm"><Link to={SIMULATION_ACCOUNTS_PATH} state={{ returnTo }}>
          {zh ? '管理模拟账户' : 'Manage simulation accounts'}
        </Link></Button>
      </div>
      {accounts.isError && <p role="status" className="text-xs text-destructive">{t('assets.accountListUnavailable')}</p>}
    </section>
    {id && <div className="flex flex-wrap items-center justify-between gap-3">
      <nav className="account-segments" aria-label={zh ? '账户账本页面' : 'Account ledger views'}>
        <Button asChild variant="ghost" size="sm">
          <Link to={holdingsHref(id)} state={{ returnTo }} aria-current={mode === 'holdings' ? 'page' : undefined}>{t('assets.holdings')}</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link to={assetHref('/transactions', id)} state={{ returnTo }} aria-current={mode === 'transactions' ? 'page' : undefined}>{t('assets.ledger')}</Link>
        </Button>
      </nav>
      <div className="flex flex-wrap gap-2">
        {watchlist && <Button asChild size="sm" variant="ghost"><Link to={watchlist} state={{ returnTo }}>{t('assets.watchlist')}</Link></Button>}
        {selected && <Button asChild size="sm" variant="ghost"><Link to={simulationAccountPath(id)} state={{ returnTo }}>{zh ? '账户设置' : 'Account settings'}</Link></Button>}
      </div>
    </div>}
    {content}
  </div>;

  return <div className="space-y-5">
    <section className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card p-4" aria-label={t('assets.accountContext')}>
      <div className="min-w-0 space-y-2">
        <label htmlFor="asset-account-selector" className="text-sm font-medium">{t('assets.accountContext')}</label>
        {selectAccount}
        {accounts.isError && <p role="status" className="text-xs text-destructive">{t('assets.accountListUnavailable')}</p>}
      </div>
      {id && <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline"><Link to={assetHref(mode === 'holdings' ? '/transactions' : '/holdings', id)} state={{ returnTo }}>{t(mode === 'holdings' ? 'assets.ledger' : 'assets.viewAssets')}</Link></Button>
        {watchlist && <Button asChild size="sm" variant="ghost"><Link to={watchlist} state={{ returnTo }}>{t('assets.watchlist')}</Link></Button>}
        {id === 'real' && <Button asChild size="sm" variant="ghost"><Link to="/import?accountId=real" state={{ returnTo }}>{t('assets.import')}</Link></Button>}
        {team && <Button asChild size="sm" variant="ghost"><Link to={'/teams/' + encodeURIComponent(team.id)} state={{ returnTo }}>{t('assets.openTeam')}</Link></Button>}
      </div>}
    </section>
    {content}
  </div>;
}

/** The real import workflow must not mount before an explicit real-account choice. */
export function ImportAccountBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  let id: string | null = null;
  try { id = readAssetAccount(location.search).id; } catch { /* Explicit invalid target stays blocked. */ }
  if (id === 'real') return <>{children}</>;
  return <section role="alert" className="space-y-4 rounded-xl border p-6">
    <h1 className="text-xl font-semibold">{t('assets.paperImportUnsupported')}</h1>
    <p className="text-sm text-muted-foreground">{t('assets.paperImportExplanation')}</p>
    <div className="flex flex-wrap gap-2">
      {id && <Button asChild variant="outline"><Link to={holdingsHref(id)}>{t('assets.returnAccount')}</Link></Button>}
      <Button asChild><Link to="/import?accountId=real">{t('assets.chooseRealImport')}</Link></Button>
    </div>
  </section>;
}
