import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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

export default function SimulationAccountsPage() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(
    () => params.get('seedReal') === '1' || params.get('create') === '1',
  );
  const [filter, setFilter] = useState('all');
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
    <div className="mx-auto w-full max-w-[1440px] space-y-7">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[26px]">
            {zh ? '模拟账户' : 'Simulation accounts'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {zh
              ? '把不同的投资想法，放进各自独立的账户。'
              : 'Give each investment idea its own independent account.'}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} />
          {zh ? '新建模拟账户' : 'New account'}
        </Button>
      </header>
      <p className="max-w-3xl text-sm leading-7 text-muted-foreground">
        {zh
          ? '每个账户独立资金、持仓、策略组合与运行状态。对照表现时再放到同一张图里。'
          : 'Each account has its own funds, holdings, strategy combination and status. Compare them together on the overview.'}
      </p>
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
              ? '复制真实持仓或使用模拟现金建立起点，再核对策略组合。'
              : 'Copy real holdings or use virtual cash as the starting point, then review your strategies.'}
          </p>
          {!items.length && (
            <Button onClick={() => setCreating(true)}>
              {zh ? '创建第一个模拟账户' : 'Create your first account'}
            </Button>
          )}
        </section>
      )}
      <div className="space-y-5">
        {filtered.map((account) => (
          <article
            key={account.id}
            className="rounded-2xl border bg-card p-5 sm:p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-6">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: accountColor(account.id, account.colorIndex) }}
                  />
                  <h2 className="break-words text-lg font-semibold">
                    <Link to={targetPath(account.id)}>{account.name}</Link>
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
                <Link to={targetPath(account.id)}>
                  {strategyId
                    ? zh
                      ? '选择此账户'
                      : 'Choose account'
                    : zh
                      ? '管理账户'
                      : 'Manage account'}
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
      {creating && <CreateSimulationAccount onClose={closeCreate} />}
    </div>
  );
}
