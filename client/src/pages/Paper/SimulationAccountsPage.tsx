import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  portfolioWorkspaceApi,
  portfolioWorkspaceKeys,
} from '@/api/portfolio-workspace';
import { Button } from '@/components/ui/button';
import {
  accountStatusLabel,
  portfolioMoney,
  simulationAccountPath,
  simulationStrategyPath,
} from '@/utils/portfolio-workspace';
import CreateSimulationAccount from './CreateSimulationAccount';
import AccountStatusControl from './AccountStatusControl';
import LegacyDecisionPage from './LegacyDecisionPage';
import type { PortfolioCompanionId } from '@shared/portfolio-workspace.interface';
import AnimalAvatar from '@/components/AnimalAvatar';
import { companionById } from '@/features/companions/companions';
import CompanionPicker from '@/features/companions/CompanionPicker';
import DeleteCompanionAccount from '@/features/companions/DeleteCompanionAccount';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function SimulationAccountsPage() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const returnState = { returnTo: `${location.pathname}${location.search}` };
  const library = params.get('view') === 'library';
  const setLibrary = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set('view', 'library'); else next.delete('view');
    setParams(next, { replace: true });
  };
  const [selectedCompanion, setSelectedCompanion] = useState<PortfolioCompanionId>('value');
  const [creating, setCreating] = useState(
    () => params.get('seedReal') === '1' || params.get('create') === '1',
  );
  const filter = ['running', 'paused', 'archived'].includes(params.get('status') ?? '') ? params.get('status')! : 'all';
  const setFilter = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('status'); else next.set('status', value);
    setParams(next, { replace: true });
  };
  const accounts = useQuery({
    queryKey: portfolioWorkspaceKeys.accounts,
    queryFn: portfolioWorkspaceApi.accounts,
    retry: false,
  });
  const strategyId = params.get('investmentStrategyId');
  const orderId = params.get('orderId');
  if (params.has('strategyId'))
    return (
      <LegacyDecisionPage
        strategyId={params.get('strategyId')!}
        versionId={params.get('sourceReportVersionId') || undefined}
      />
    );
  const items = accounts.data ?? [];
  const filtered = items.filter((account) =>
    filter === 'all'
      ? account.status !== 'archived'
      : account.status === filter,
  );
  const closeCreate = () => {
    setCreating(false);
    if (params.has('seedReal') || params.has('create')) {
      const next = new URLSearchParams(params);
      next.delete('seedReal');
      next.delete('create');
      setParams(next, { replace: true });
    }
  };
  const targetPath = (id: string) =>
    strategyId
      ? simulationStrategyPath(id, strategyId)
      : `${simulationAccountPath(id)}${orderId ? `?orderId=${encodeURIComponent(orderId)}` : ''}`;
  return (
    <div className="portfolio-page companion-accounts-page">
      <header className="portfolio-page-header">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[26px]">
            {zh ? '模拟账户' : 'Simulation accounts'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {zh
              ? '独立记录每个模拟账户的持仓、策略和成交，与真实账户分开比较。'
              : 'Review holdings, strategies and trades for each simulation, separately from your real account.'}
          </p>
        </div>
        <div className="companion-page-actions flex flex-wrap gap-2"><Button variant="outline" onClick={() => setLibrary(true)}>{zh ? '账户风格' : 'Account styles'}</Button>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} />
          {zh ? '新建模拟账户' : 'New simulation account'}
        </Button></div>
      </header>
      {(strategyId || orderId) && (
        <div
          role="status"
          className="rounded-xl bg-primary/5 px-5 py-4 text-sm leading-6"
        >
          {strategyId
            ? zh
              ? '策略已保存在资料库。请选择要查看或编辑的模拟账户。'
              : 'The strategy is saved in your library. Choose the simulation account to review or edit.'
            : zh
              ? '请选择成交所属账户。账户内只显示该账户的记录。'
              : 'Choose the account for this trade. Each account only shows its own records.'}
        </div>
      )}
      <div
        className="companion-account-filters flex flex-wrap gap-2"
        role="group"
        aria-label={zh ? '账户状态' : 'Account status'}
      >
        {[
          ['all', zh ? '全部' : 'All'],
          ['running', zh ? '运行中' : 'Running'],
          ['paused', zh ? '已暂停' : 'Paused'],
          ['archived', zh ? '已归档' : 'Archived'],
        ].map(([value, label]) => (
          <Button
            key={value}
            variant={filter === value ? 'default' : 'ghost'}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}{' '}
            <span className="tabular-nums opacity-70">
              {
                items.filter((item) =>
                  value === 'all'
                    ? item.status !== 'archived'
                    : item.status === value,
                ).length
              }
            </span>
          </Button>
        ))}
      </div>
      {accounts.isPending && (
        <p
          role="status"
          className="py-16 text-center text-sm text-muted-foreground"
        >
          {zh ? '正在读取模拟账户…' : 'Loading simulation accounts…'}
        </p>
      )}
      {accounts.isError && (
        <div role="alert" className="space-y-3 rounded-xl border p-6">
          <p>
            {zh
              ? '账户暂时无法读取，已保存的记录仍保留。'
              : 'Accounts could not be loaded. Saved records are retained.'}
          </p>
          <Button variant="outline" onClick={() => void accounts.refetch()}>
            {zh ? '重新读取' : 'Reload'}
          </Button>
        </div>
      )}
      {!accounts.isPending && !accounts.isError && !filtered.length && (
        <section className="flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-16 text-center">
          <Wallet size={32} className="text-primary" />
          <h2 className="text-lg font-medium">
            {items.length
              ? zh
                ? '此状态下暂无账户'
                : 'No accounts with this status'
              : zh
                ? '从一个清晰的投资想法开始'
                : 'Start with one clear investment idea'}
          </h2>
          <p className="max-w-md text-sm leading-7 text-muted-foreground">
            {zh
              ? '选择账户风格与起点，核对持仓和现金，再配置策略组合。'
              : 'Choose an account style and starting point, review holdings and cash, then configure your strategies.'}
          </p>
          {!items.length && (
            <Button onClick={() => setCreating(true)}>
              {zh ? '创建第一个模拟账户' : 'Create your first account'}
            </Button>
          )}
        </section>
      )}
      <div className="companion-account-grid">
        {filtered.map((account) => {
          const companion = companionById(account.companionId);
          return (
          <article
            key={account.id}
            className="companion-account-card"
          >
            <div className="companion-account-card-body">
              <div className="companion-card-heading">
                <AnimalAvatar avatar={companion?.id ?? 'moderator'} role="researcher" className="size-12 shrink-0" />
                <div className="min-w-0 flex-1">
                  <h2 className="break-words text-lg font-semibold leading-7">
                    <Link to={targetPath(account.id)} state={returnState}>{account.name}</Link>
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {companion?.focus[zh ? 0 : 1] ?? (zh ? '多元思考' : 'Multiple perspectives')}
                  </p>
                </div>
                <DeleteCompanionAccount account={account} iconOnly />
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-xs text-muted-foreground">{zh ? '账户净值 · USD' : 'Account equity · USD'}</p>
                <p className="break-words text-[28px] font-semibold tabular-nums leading-10">
                  {portfolioMoney(account.equityUsd, i18n.language)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {account.equityUsd == null
                    ? zh
                      ? '等待完整估值'
                      : 'Awaiting complete valuation'
                    : zh
                      ? `现金 ${portfolioMoney(account.cashBalance, i18n.language)}`
                      : `Cash ${portfolioMoney(account.cashBalance, i18n.language)}`}
                </p>
              </div>
              <div className="companion-card-state">
                <span className="rounded-md bg-primary/5 px-2 py-1 text-xs text-primary">{accountStatusLabel(account.status, zh)}</span>
                <span className="text-xs text-muted-foreground">{account.strategyCount} {zh ? '个策略' : 'strategies'}</span>
              </div>
              <div className="companion-card-actions">
              <Button asChild className="flex-1">
                <Link to={targetPath(account.id)} state={returnState}>
                  {strategyId
                    ? zh
                      ? '选择此账户'
                      : 'Choose account'
                    : zh
                      ? '查看账户'
                      : 'View account'}
                  <ArrowRight size={15} />
                </Link>
              </Button>
              <AccountStatusControl account={account} shortLabel />
              </div>
            </div>
          </article>
        );})}
      </div>
      <p className="text-xs leading-6 text-muted-foreground">
        {zh
          ? '归档后保留估值记录、持仓快照、已确认策略及成交历史，可随时回看。'
          : 'Archived accounts retain valuation records, holdings snapshots, confirmed strategies and trade history.'}
      </p>
      <Dialog open={library} onOpenChange={setLibrary}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader><DialogTitle>{zh ? '选择模拟账户风格' : 'Choose a simulation account style'}</DialogTitle>
          <DialogDescription>{zh ? '账户风格是模拟账户的展示信息。独立股友在「我的股友」中管理。' : 'Account styles describe simulation accounts. Manage independent agents in My agents.'}</DialogDescription></DialogHeader>
        <CompanionPicker value={selectedCompanion} onChange={setSelectedCompanion} zh={zh} expanded />
        <footer className="flex justify-end"><Button onClick={() => { setLibrary(false); setCreating(true); }}>{zh ? '按此风格新建模拟账户' : 'Create an account with this style'}</Button></footer>
      </DialogContent></Dialog>
      {creating && <CreateSimulationAccount onClose={closeCreate} initialCompanionId={selectedCompanion}
        initialOrigin={params.get('seedReal') === '1' ? 'holdings' : 'cash'} />}
    </div>
  );
}
