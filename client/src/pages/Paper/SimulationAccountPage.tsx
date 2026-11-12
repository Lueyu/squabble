import { useEffect, useRef, useState } from 'react';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PortfolioAccountDetail } from '@shared/portfolio-workspace.interface';
import {
  portfolioWorkspaceApi,
  portfolioWorkspaceKeys,
} from '@/api/portfolio-workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  accountStatusLabel,
  portfolioMoney,
  simulationAccountPath,
  simulationStrategyPath,
} from '@/utils/portfolio-workspace';
import { createRequestIntent } from '@/utils/simple-experience';
import { portfolioWorkspaceError } from '@/utils/portfolio-workspace';
import { simulationReviewGapText } from '@shared/simulation-review-reading';
import AccountStatusControl from './AccountStatusControl';
import DecisionCard from './DecisionCard';
import { limitLabels } from './StartInvestmentCard';
import PortfolioComparisonPanel from '@/features/portfolio-comparison/PortfolioComparisonPanel';
import { accountColor } from '@/features/portfolio-comparison/comparison-chart-options';
import { holdingsHref } from '@/features/assets/account-context';
import CompanionIdentity from '@/features/companions/CompanionIdentity';
import AccountCompanionEditor from '@/features/companions/AccountCompanionEditor';

function AccountRename({
  account,
  onClose,
}: {
  account: PortfolioAccountDetail;
  onClose: () => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [name, setName] = useState(account.name);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const client = useQueryClient();
  const rename = useMutation({
    retry: false,
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        expectedPolicyRevision: account.policyRevision!,
      };
      return portfolioWorkspaceApi.rename(account.id, {
        ...payload,
        requestKey: intent.current.keyFor({
          accountId: account.id,
          ...payload,
        }),
      });
    },
    onSuccess: async () => {
      intent.current.complete();
      await Promise.all([
        client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.accounts }),
        client.invalidateQueries({
          queryKey: portfolioWorkspaceKeys.account(account.id),
        }),
      ]);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !rename.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{zh ? '账户名称' : 'Account name'}</DialogTitle>
          <DialogDescription>
            {zh
              ? '使用容易辨认的名称区分投资想法。'
              : 'Choose a recognizable name for this investment idea.'}
          </DialogDescription>
        </DialogHeader>
        <label className="space-y-2 text-sm">
          <span>{zh ? '名称' : 'Name'}</span>
          <Input
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {rename.isError && (
          <p role="alert" className="text-sm text-destructive">
            {portfolioWorkspaceError(rename.error, zh, {
              zh: '名称尚未更新，请重试。',
              en: 'The name was not updated. Retry.',
            })}
          </p>
        )}
        <footer className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            disabled={!name.trim() || rename.isPending}
            onClick={() => rename.mutate()}
          >
            {zh ? '保存名称' : 'Save name'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

export default function SimulationAccountPage() {
  const { accountId = '' } = useParams<{ accountId: string }>();
  return <SimulationAccountDetail key={accountId} accountId={accountId} />;
}

function SimulationAccountDetail({ accountId }: { accountId: string }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [choosingCompanion, setChoosingCompanion] = useState(false);
  const requestedTab = params.get('tab');
  const tab = ['strategies', 'holdings', 'trades', 'risk'].includes(requestedTab ?? '')
    ? requestedTab! : params.has('orderId') ? 'trades' : 'strategies';
  const setTab = (value: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', value);
    setParams(next, { replace: true });
  };
  const query = useQuery({
    queryKey: portfolioWorkspaceKeys.account(accountId),
    queryFn: () => portfolioWorkspaceApi.account(accountId),
    enabled: !!accountId,
    retry: false,
    refetchInterval: 30_000,
  });
  const accounts = useQuery({
    queryKey: portfolioWorkspaceKeys.accounts,
    queryFn: portfolioWorkspaceApi.accounts,
    retry: false,
  });
  const data = query.data;
  const orderId = params.get('orderId');
  useEffect(() => {
    if (orderId && tab === 'trades' && data)
      document
        .getElementById(`paper-order-${orderId}`)
        ?.scrollIntoView({ block: 'center' });
  }, [orderId, tab, data]);
  if (query.isPending)
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        {zh ? '正在读取账户…' : 'Loading account…'}
      </p>
    );
  if (!data)
    return (
      <div role="alert" className="space-y-4 p-8">
        <h1 className="text-xl font-semibold">
          {zh ? '账户暂不可用' : 'Account unavailable'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {zh
            ? '未切换到其他账户。请重试或返回账户列表。'
            : 'No other account was selected. Retry or return to the account list.'}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void query.refetch()}>
            {zh ? '重试' : 'Retry'}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/paper">{zh ? '返回账户列表' : 'Back to accounts'}</Link>
          </Button>
        </div>
      </div>
    );
  const investment = data.investment;
  const combination = data.combination;
  const rules = limitLabels(zh);
  return (
    <div className="portfolio-page companion-detail-page">
      <header className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            to="/paper"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={14} />
            {zh ? '模拟账户' : 'Simulation accounts'}
          </Link>
          <Select
            value={accountId}
            onValueChange={(id) => navigate(simulationAccountPath(id))}
          >
            <SelectTrigger
              className="w-full sm:w-56"
              aria-label={zh ? '切换模拟账户' : 'Switch simulation account'}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(accounts.data ?? [data]).map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CompanionIdentity id={data.companionId} zh={zh} />
            <div className="flex flex-wrap items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: accountColor(accountId, data.colorIndex) }}
              />
              <h1 className="break-words text-2xl font-semibold tracking-tight sm:text-[26px]">
                {data.name}
              </h1>
              {data.status !== 'archived' && data.policyRevision !== null && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={zh ? '修改账户名称' : 'Rename account'}
                  onClick={() => setRenaming(true)}
                >
                  <Pencil size={14} />
                </Button>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {zh
                ? '独立模拟账本 · 创建于'
                : 'Independent simulation · created'}{' '}
              {new Date(data.createdAt).toLocaleDateString(i18n.language)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline"><Link to={holdingsHref(accountId)}>{zh ? '查看资产' : 'View assets'}</Link></Button>
            {data.status !== 'archived' && <Button variant="outline" onClick={() => setChoosingCompanion(true)}>{data.companionId ? zh ? '更换账户风格' : 'Change account style' : zh ? '选择账户风格' : 'Choose account style'}</Button>}
            <AccountStatusControl account={data} />
            {data.status !== 'archived' && (
              <Button asChild>
                <Link to={simulationStrategyPath(accountId)}>
                  {zh ? '编辑策略组合' : 'Edit strategy combination'}
                </Link>
              </Button>
            )}
          </div>
        </div>
      </header>
      <section
        className="grid gap-6 sm:grid-cols-3"
        aria-label={zh ? '账户概况' : 'Account summary'}
      >
        <div>
          <p className="text-xs text-muted-foreground">
            {zh ? '模拟净资产 · 美元' : 'Simulation equity · USD'}
          </p>
          <p className="mt-2 text-3xl font-medium tabular-nums">
            {portfolioMoney(data.equityUsd, i18n.language)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {data.equityUsd == null
              ? zh
                ? '等待可信完整估值'
                : 'Awaiting reliable complete valuation'
              : zh
                ? '最近保存的估值'
                : 'Latest saved valuation'}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">
            {zh ? '今日净资产变化 · 美元' : 'Today’s equity change · USD'}
          </p>
          <p className="mt-2 text-3xl font-medium tabular-nums">
            {portfolioMoney(investment.todayChangeUsd, i18n.language)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {zh
              ? '资产变化，不等同于投资收益'
              : 'Equity change is not investment return'}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">
            {zh ? '账户状态' : 'Account status'}
          </p>
          <p className="mt-3 text-xl font-medium">
            {accountStatusLabel(data.status, zh)}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            {combination.allocations.filter((item) => item.enabled).length}{' '}
            {zh ? '项已启用策略' : 'enabled strategies'} ·{' '}
            {zh ? '政策修订' : 'Policy revision'} {data.policyRevision ?? '—'}
          </p>
        </div>
      </section>
      <section className="companion-latest-event">
        <div><h2>{investment.actions.length ? zh ? '每个动作，都能回到依据' : 'Every action has a record' : zh ? '把想法说清楚，再开始观察' : 'Clarify your idea, then observe'}</h2>
          <p>{investment.actions.length ? zh ? `此账户保留了 ${investment.actions.length} 条当前可读取的模拟执行记录。查看状态、原因和对应策略。` : `${investment.actions.length} available simulation execution records. Review their status, reasons and strategies.` : zh ? '从一个问题开始，逐步核对规则。未确认并应用策略前，模拟仓不会自动买卖。' : 'Start with a question and review the rules step by step. This account does not trade automatically until a strategy is confirmed and applied.'}</p></div>
        <div className="flex flex-wrap gap-2">{investment.actions.length > 0 && <Button variant="outline" onClick={() => setTab('trades')}>{zh ? '查看模拟动态' : 'View activity'}</Button>}
          <Button asChild variant="outline"><Link to={`/strategies/new?accountId=${encodeURIComponent(accountId)}`}>{zh ? '一起聊出策略' : 'Clarify a strategy'}</Link></Button>
          <Button asChild variant="ghost"><Link to={`/daily?accountId=${encodeURIComponent(accountId)}`}>{zh ? '阅读账户日报' : 'Read account daily'}</Link></Button></div>
      </section>
      <PortfolioComparisonPanel accountIds={['real', accountId]} compact />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-6 flex h-auto flex-wrap justify-start gap-2 bg-transparent p-0">
          {[
            ['strategies', zh ? '策略组合' : 'Strategies'],
            ['holdings', zh ? '持仓明细' : 'Holdings'],
            ['trades', zh ? '交易记录' : 'Trades'],
            ['risk', zh ? '风险与设置' : 'Risk & settings'],
          ].map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="rounded-lg px-4 py-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="strategies" className="space-y-5">
          <div>
            <h2 className="text-xl font-semibold">
              {combination.allocations.length}{' '}
              {zh
                ? '个策略，共享一套账户边界'
                : 'strategies, one set of account limits'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {zh
                ? `先保留 ${combination.cashFloorPct}% 现金，策略预算划分剩余可投资资金。比例是上限，不自动再平衡。`
                : `Reserve ${combination.cashFloorPct}% cash first. Strategy budgets cap the remaining investable funds; they do not rebalance the account.`}
            </p>
          </div>
          {combination.draft && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-primary/5 px-4 py-3 text-sm">
              <p>
                {zh
                  ? '有一份已保存、尚未应用的组合草稿。'
                  : 'A saved combination draft has not been applied.'}
              </p>
              <Button asChild variant="ghost" size="sm">
                <Link to={simulationStrategyPath(accountId)}>
                  {zh ? '继续编辑草稿' : 'Continue draft'}
                </Link>
              </Button>
            </div>
          )}
          {!combination.allocations.length && (
            <div className="rounded-xl border border-dashed p-8 text-sm leading-7 text-muted-foreground">
              {zh
                ? '账户先观察。加入策略、核对执行说明并明确应用后，才会按组合运行。'
                : 'This account is observing. Add strategies, review the execution details, then explicitly apply the combination to run it.'}
            </div>
          )}
          <div className="divide-y rounded-xl border">
            {combination.allocations.map((item) => (
              <article
                key={item.strategyId}
                className="grid gap-4 p-5 sm:grid-cols-[minmax(0,2fr)_1fr_1fr_auto] sm:items-center"
              >
                <div>
                  <h3 className="font-medium">{item.snapshot.content.title}</h3>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {item.snapshot.sources.length
                      ? `${item.snapshot.sources.length} ${zh ? '处固定来源' : 'pinned sources'}`
                      : zh
                        ? '手动建立'
                        : 'Manually created'}{' '}
                    · {zh ? '修订' : 'Revision'} {item.strategyRevision}
                  </p>
                </div>
                <p className="text-sm">
                  {item.allocationPct}%{' '}
                  <span className="text-xs text-muted-foreground">
                    {zh ? '可投资预算' : 'investable budget'}
                  </span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {item.enabled
                    ? zh
                      ? '已启用'
                      : 'Enabled'
                    : zh
                      ? '停用'
                      : 'Disabled'}
                </p>
                <Button asChild variant="ghost" size="sm">
                  <Link to={simulationStrategyPath(accountId, item.strategyId)}>
                    {zh ? '规则与来源 →' : 'Rules & sources →'}
                  </Link>
                </Button>
              </article>
            ))}
          </div>
          <div className="rounded-xl bg-muted/40 p-4 text-sm leading-7">
            <strong className="mr-4 font-medium">
              {zh ? '账户级风控优先' : 'Account limits take priority'}
            </strong>
            <span className="text-muted-foreground">
              {zh
                ? `单股上限 ${investment.limits.maxPositionPct}% · 最低现金 ${investment.limits.minCashPct}% · 冲突策略需先核对`
                : `Position cap ${investment.limits.maxPositionPct}% · Minimum cash ${investment.limits.minCashPct}% · Resolve strategy conflicts before applying`}
            </span>
          </div>
        </TabsContent>
        <TabsContent value="holdings">
          <Button asChild variant="outline" className="mb-4"><Link to={holdingsHref(accountId)}>{zh ? '在资产页查看持仓与现金' : 'View holdings and cash in Assets'}</Link></Button>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  {[
                    zh ? '证券' : 'Security',
                    zh ? '持仓数量' : 'Shares',
                    zh ? '平均成本' : 'Average cost',
                    zh ? '币种' : 'Currency',
                  ].map((label) => (
                    <th key={label} className="px-5 py-3 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {investment.holdings.map((item) => (
                  <tr key={item.id}>
                    <td className="px-5 py-4 font-medium">
                      {item.ticker}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {item.market}
                      </span>
                    </td>
                    <td className="px-5 py-4 tabular-nums">{item.shares}</td>
                    <td className="px-5 py-4 tabular-nums">{item.avgCost}</td>
                    <td className="px-5 py-4">{item.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!investment.holdings.length && (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {zh ? '此账户暂无持仓。' : 'This account has no holdings.'}
              </p>
            )}
          </div>
        </TabsContent>
        <TabsContent value="trades" className="space-y-3">
          {orderId &&
            !investment.actions.some((action) => action.id === orderId) && (
              <p role="status" className="rounded-xl bg-muted p-4 text-sm">
                {zh
                  ? '这条记录不在此账户当前可读取的成交记录中。请核对账户或稍后再试。'
                  : 'This trade is not in this account’s currently available records. Check the account or retry later.'}
              </p>
            )}
          {investment.actions.map((action) => (
            <div key={action.id} id={`paper-order-${action.id}`}>
              <DecisionCard action={action} accountId={accountId} />
            </div>
          ))}
          {!investment.actions.length && (
            <p className="rounded-xl border border-dashed p-8 text-sm text-muted-foreground">
              {zh
                ? '尚无交易记录。符合条件并通过账户风控后，模拟成交会显示在这里。'
                : 'No trades yet. Simulated fills appear here after conditions and account risk checks pass.'}
            </p>
          )}
        </TabsContent>
        <TabsContent value="risk" className="space-y-6">
          <h2 className="text-xl font-semibold">
            {zh ? '账户风险边界' : 'Account risk limits'}
          </h2>
          <dl className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
            {Object.entries(investment.limits).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-4 bg-card p-5">
                <dt className="text-sm text-muted-foreground">
                  {rules[key as keyof typeof rules]}
                </dt>
                <dd className="text-sm font-medium tabular-nums">{value}%</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm leading-7 text-muted-foreground">
            {zh
              ? '这些账户限制约束全部策略。暂停会停止所有自动买卖，包括保护性卖出；估值记录继续。'
              : 'These limits apply across all strategies. Pausing stops all automatic trades, including protective sales; valuations continue.'}
          </p>
          {!!investment.waitingReasons?.length && (
            <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
              {investment.waitingReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {!!investment.performance?.gaps.length && (
            <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
              {investment.performance.gaps.map((gap) => (
                <li key={gap}>{simulationReviewGapText(gap, zh)}</li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
      <p className="text-xs leading-6 text-muted-foreground">
        {zh
          ? `只作用于「${data.name}」。实仓与其他模拟账户各自独立，这里的成交为模拟成交。`
          : `Applies only to “${data.name}”. Real and other simulation accounts are independent. All trades here are simulated.`}
      </p>
      {renaming && (
        <AccountRename account={data} onClose={() => setRenaming(false)} />
      )}
      {choosingCompanion && <AccountCompanionEditor account={data} onClose={() => setChoosingCompanion(false)} />}
    </div>
  );
}
