import { useEffect, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TeamListResult } from '@shared/team-workspace.interface';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import http from '@/api/http';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { readAssetAccount, assetHref, holdingsHref } from './account-context';
import PaperAccountAssets from './PaperAccountAssets';

/** Ownership comes from team bindings; companion presentation metadata is never a team. */
export function useAccountTeams() {
  return useQuery({
    queryKey: ['asset-account-teams'], retry: false,
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

const accountViews = new Map<string, string>();

export function AccountAssetsPage({ real, mode }: { real: ReactNode; mode: 'holdings' | 'transactions' }) {
  const { t } = useTranslation();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  let id: string | null = null;
  try { id = readAssetAccount(location.search).id; } catch { /* Explicit invalid context is rendered below. */ }
  const accounts = useQuery({ queryKey: portfolioWorkspaceKeys.accounts, queryFn: portfolioWorkspaceApi.accounts, retry: false });
  const teams = useAccountTeams();
  const selected = accounts.data?.find(item => item.id === id);
  const team = teams.data?.find(item => item.accountId === id && item.binding?.state === 'active');
  useEffect(() => {
    if (!params.has('accountId')) {
      const next = new URLSearchParams(params); next.set('accountId', 'real'); setParams(next, { replace: true });
    }
  }, [params, setParams]);
  useEffect(() => { if (id) accountViews.set(`${mode}:${id}`, location.search); }, [id, mode, location.search]);
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  return <div className="space-y-5">
    <section className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card p-4" aria-label={t('assets.accountContext')}>
      <div className="min-w-0 space-y-2">
        <label htmlFor="asset-account-selector" className="text-sm font-medium">{t('assets.accountContext')}</label>
        <Select value={id ?? '__invalid__'} onValueChange={nextId => navigate(assetHref(location.pathname, nextId, accountViews.get(`${mode}:${nextId}`)))}>
          <SelectTrigger id="asset-account-selector" className="w-full min-w-60 max-w-lg" aria-label={t('assets.switchAccount')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {!id && <SelectItem value="__invalid__" disabled>{t('assets.invalidAccount')}</SelectItem>}
            <SelectItem value="real">{t('assets.real')}</SelectItem>
            {id && id !== 'real' && !selected && <SelectItem value={id}>{t('assets.simulation')} · {id}</SelectItem>}
            {(accounts.data ?? []).map(account => {
              const ownerTeam = teams.data?.find(item => item.accountId === account.id && item.binding?.state === 'active');
              return <SelectItem key={account.id} value={account.id}>{t('assets.simulation')} · {account.name} · {teams.isPending ? t('common.loading') : teams.isError ? t('assets.teamUnavailable') : ownerTeam?.name ?? t('assets.unbound')}{account.status === 'archived' ? ` · ${t('assets.archived')}` : ''}</SelectItem>;
            })}
          </SelectContent>
        </Select>
        {id && id !== 'real' && <p className="text-xs text-muted-foreground">{t('assets.simulation')} · {selected?.name ?? id} · {teams.isPending ? t('common.loading') : teams.isError ? t('assets.teamUnavailable') : team?.name ?? t('assets.unbound')}{selected?.status === 'archived' ? ` · ${t('assets.archived')}` : ''}</p>}
        {accounts.isError && <p role="status" className="text-xs text-destructive">{t('assets.accountListUnavailable')}</p>}
      </div>
      {id && <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline"><Link to={assetHref(mode === 'holdings' ? '/transactions' : '/holdings', id)} state={{ returnTo }}>{t(mode === 'holdings' ? 'assets.ledger' : 'assets.viewAssets')}</Link></Button>
        <Button asChild size="sm" variant="ghost"><Link to={assetHref('/watchlist', id, new URLSearchParams({ returnTo }).toString())} state={{ returnTo }}>{t('assets.watchlist')}</Link></Button>
        {id === 'real' && <Button asChild size="sm" variant="ghost"><Link to="/import?accountId=real" state={{ returnTo }}>{t('assets.import')}</Link></Button>}
        {team && <Button asChild size="sm" variant="ghost"><Link to={`/teams/${encodeURIComponent(team.id)}`} state={{ returnTo }}>{t('assets.openTeam')}</Link></Button>}
      </div>}
    </section>
    {!id ? <p role="alert" className="rounded-xl border border-destructive/40 p-6">{t('assets.invalidAccount')}</p> : id === 'real' ? real : <PaperAccountAssets key={id} accountId={id} accountName={selected?.name ?? id} archived={selected?.status === 'archived'} mode={mode} />}
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
