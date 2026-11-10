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
import { accountColor } from '@/features/portfolio-comparison/comparison-chart-options';
import type { PortfolioCompanionId } from '@shared/portfolio-workspace.interface';
import CompanionIdentity from '@/features/companions/CompanionIdentity';
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
            {zh ? '我的股友' : 'My companions'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {zh
              ? '把不同的投资想法，放进各自独立的模拟仓。'
              : 'Give each investment idea its own independent simulation.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setLibrary(true)}>{zh ? '认识股友' : 'Meet the companions'}</Button>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} />
          {zh ? '新建模拟仓' : 'New simulation'}
        </Button></div>
      </header>
      <p className="max-w-3xl text-sm leading-7 text-muted-foreground">
        {zh
          ? '每个账户独立资金、持仓、策略组合与运行状态。对照表现时再放到同一张图里。'
          : 'Each account has its own funds, holdings, strategy combination and status. Compare them together on the overview.'}
      </p>
      <nav className="companion-secondary-nav" aria-label={zh ? '股友工具' : 'Companion tools'}>
        <Link to="/strategies">{zh ? '我的策略库' : 'My strategies'}<ArrowRight size={14} /></Link>
        <Link to="/strategies/new">{zh ? '一起聊出策略' : 'Clarify a strategy'}<ArrowRight size={14} /></Link>
        <Link to="/">{zh ? '在总览看多仓曲线' : 'Compare account histories'}<ArrowRight size={14} /></Link>
      </nav>
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
        className="flex flex-wrap gap-2"
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
              ? '选择股友与起点，核对持仓和现金，再配置策略组合。'
              : 'Choose a companion and starting point, review holdings and cash, then configure your strategies.'}
          </p>
          {!items.length && (
            <Button onClick={() => setCreating(true)}>
              {zh ? '创建第一个模拟账户' : 'Create your first account'}
            </Button>
          )}
        </section>
      )}
      <div className="companion-account-grid">
        {filtered.map((account) => (
          <article
            key={account.id}
            className="companion-account-card"
          >
            <div className="companion-account-card-body">
              <CompanionIdentity id={account.companionId} zh={zh} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: accountColor(account.id, account.colorIndex) }}
                  />
                  <h2 className="break-words text-lg font-semibold">
                    <Link to={targetPath(account.id)} state={returnState}>{account.name}</Link>
                  </h2>
                  <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {accountStatusLabel(account.status, zh)}
                  </span>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  {account.strategyCount
                    ? `${account.strategyCount} ${zh ? '项已应用策略 · 独立预算' : 'applied strategies · independent budget'}`
                    : zh
                      ? '观察中 · 尚未应用策略'
                      : 'Observing · no strategies applied'}
                </p>
              </div>
              <div className="min-w-[180px]">
                <p className="text-2xl font-medium tabular-nums sm:text-3xl">
                  {portfolioMoney(account.equityUsd, i18n.language)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {account.equityUsd == null
                    ? zh
                      ? '等待完整估值'
                      : 'Awaiting complete valuation'
                    : zh
                      ? '已保存净资产 · 美元'
                      : 'Saved equity · USD'}
                </p>
              </div>
              <Button asChild>
                <Link to={targetPath(account.id)} state={returnState}>
                  {strategyId
                    ? zh
                      ? '选择此账户'
                      : 'Choose account'
                    : zh
                      ? '看看这个模拟仓'
                      : 'Open simulation'}
                  <ArrowRight size={15} />
                </Link>
              </Button>
            </div>
            <footer className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                {zh ? '起点' : 'Created'}{' '}
                {new Date(account.createdAt).toLocaleDateString(i18n.language)}{' '}
                · {zh ? '独立账本' : 'Independent ledger'}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="ghost" size="sm">
                  <Link to={`/?accountIds=${encodeURIComponent(account.id)}`}>
                    {zh ? '加入对比' : 'Compare'}
                  </Link>
                </Button>
                <AccountStatusControl account={account} compact />
                <DeleteCompanionAccount account={account} />
              </div>
            </footer>
          </article>
        ))}
      </div>
      <p className="text-xs leading-6 text-muted-foreground">
        {zh
          ? '归档后保留估值记录、持仓快照、已确认策略及成交历史，可随时回看。'
          : 'Archived accounts retain valuation records, holdings snapshots, confirmed strategies and trade history.'}
      </p>
      <Dialog open={library} onOpenChange={setLibrary}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader><DialogTitle>{zh ? '找到合拍的动物股友' : 'Find your animal companion'}</DialogTitle>
          <DialogDescription>{zh ? '每种视角都有长处，也有盲点。动物形象不自动修改研究成员或交易规则。' : 'Every perspective has strengths and blind spots. Animal identity does not change research members or trading rules.'}</DialogDescription></DialogHeader>
        <CompanionPicker value={selectedCompanion} onChange={setSelectedCompanion} zh={zh} expanded />
        <footer className="flex justify-end"><Button onClick={() => { setLibrary(false); setCreating(true); }}>{zh ? '和这位股友新建模拟仓' : 'Create a simulation with this companion'}</Button></footer>
      </DialogContent></Dialog>
      {creating && <CreateSimulationAccount onClose={closeCreate} initialCompanionId={selectedCompanion}
        initialOrigin={params.get('seedReal') === '1' ? 'holdings' : 'cash'} />}
    </div>
  );
}
