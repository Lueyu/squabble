import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PortfolioAccountDetail } from '@shared/portfolio-workspace.interface';
import {
  portfolioWorkspaceApi,
  portfolioWorkspaceKeys,
} from '@/api/portfolio-workspace';
import { Button } from '@/components/ui/button';
import {
  portfolioWorkspaceError,
  combinationIdentity,
  simulationAccountPath,
} from '@/utils/portfolio-workspace';
import InvestmentStrategyEditor from './InvestmentStrategyEditor';
import CombinationStrategyLibrary from './CombinationStrategyLibrary';
import CombinationAllocationCard from './CombinationAllocationCard';
import { useAccountStrategyCombination } from './use-account-strategy-combination';

export default function AccountStrategyCombinationPage() {
  const { accountId = '' } = useParams<{ accountId: string }>();
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const query = useQuery({
    queryKey: portfolioWorkspaceKeys.account(accountId),
    queryFn: () => portfolioWorkspaceApi.account(accountId),
    enabled: !!accountId,
    retry: false,
  });
  if (query.isPending)
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        {zh ? '正在读取策略组合…' : 'Loading strategy combination…'}
      </p>
    );
  if (!query.data)
    return (
      <div role="alert" className="space-y-3 p-8">
        <p>
          {zh
            ? '账户暂不可用，请重新读取。'
            : 'The account is unavailable. Please reload.'}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          {zh ? '重试' : 'Retry'}
        </Button>
        <Button asChild variant="ghost">
          <Link to="/paper">{zh ? '返回账户列表' : 'Back to accounts'}</Link>
        </Button>
      </div>
    );
  return (
    <CombinationEditor
      key={accountId}
      account={query.data}
      onReload={() => void query.refetch()}
    />
  );
}

function CombinationEditor({
  account,
  onReload,
}: {
  account: PortfolioAccountDetail;
  onReload: () => void;
}) {
  const editor = useAccountStrategyCombination(account);
  const {
    zh,
    language,
    allocations,
    expectedRevision,
    preview,
    savedIdentity,
    setAdding,
    editing,
    message,
    localError,
    identity,
    library,
    selected,
    linked,
    strategies,
    changed,
    mutation,
    closeEditor,
    reviewSaved,
    stale,
    invalidAllocation,
    allocated,
    locked,
    canApply,
    setExpectedRevision,
    setPreview,
    setReviewedIdentity,
    setSavedIdentity,
  } = editor;
  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-7">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[26px]">
            {zh ? '编辑策略组合' : 'Edit strategy combination'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {zh
              ? '草稿、预览、应用，每一步都绑定此账户。'
              : 'Draft, preview and apply are bound to this account.'}
          </p>
        </div>
        <Button asChild variant="ghost">
          <Link to={simulationAccountPath(account.id)}>
            <ArrowLeft size={15} />
            {zh ? '返回账户' : 'Back to account'}
          </Link>
        </Button>
      </header>
      <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-xl bg-primary/5 px-5 py-4 text-sm">
        <strong className="font-semibold text-primary">{account.name}</strong>
        <span className="text-muted-foreground">
          {zh
            ? '当前组合继续运行；核对并应用后才切换到新版本。'
            : 'The current combination stays in place until you review and apply the new revision.'}
        </span>
      </div>
      {stale && (
        <div
          role="alert"
          className="space-y-3 rounded-xl border border-amber-300 p-4 text-sm"
        >
          <p>
            {zh
              ? '此账户政策已变化，旧预览不能应用。重新载入将替换本页未保存的修改。'
              : 'This account policy changed. The old preview cannot apply. Reloading replaces unsaved changes on this page.'}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              const next =
                account.combination.draft?.allocations ??
                account.combination.allocations;
              setExpectedRevision(account.combination.policyRevision);
              changed(next);
              setSavedIdentity(
                combinationIdentity(
                  account.id,
                  account.combination.policyRevision,
                  next,
                ),
              );
            }}
          >
            {zh ? '载入当前账户版本' : 'Load current account revision'}
          </Button>
        </div>
      )}
      {account.status === 'archived' && (
        <p role="status" className="text-sm text-muted-foreground">
          {zh
            ? '此账户已归档，策略仅供回看。'
            : 'This account is archived. Strategies are available for review only.'}
        </p>
      )}
      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_330px]">
        <section className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">
              {zh ? '策略与资金分配' : 'Strategies and budget'}
            </h2>
            <Button
              variant="outline"
              disabled={locked}
              onClick={() => setAdding(true)}
            >
              <Plus size={15} />
              {zh ? '添加策略' : 'Add strategy'}
            </Button>
          </div>
          {!allocations.length && (
            <div className="rounded-xl border border-dashed px-6 py-12 text-center text-sm leading-7 text-muted-foreground">
              {zh
                ? '从策略资料库选择已核对的策略，或写一份新草稿。'
                : 'Choose a reviewed strategy from your library, or write a new draft.'}
            </div>
          )}
          {allocations.map((item) => (
            <CombinationAllocationCard
              key={item.strategyId}
              item={item}
              editor={editor}
            />
          ))}
          <p
            className={`text-sm ${allocated > 100 || invalidAllocation ? 'text-destructive' : 'text-primary'}`}
          >
            {zh
              ? `可投资预算已分配 ${allocated}% · 另保留 ${account.combination.cashFloorPct}% 现金底线`
              : `${allocated}% of investable budget allocated · ${account.combination.cashFloorPct}% cash floor retained`}
          </p>
          {(allocated > 100 || invalidAllocation) && (
            <p role="alert" className="text-sm text-destructive">
              {zh
                ? '启用策略的预算需大于 0%，每项不超过 100%，合计不超过 100%。'
                : 'Enabled budgets must be greater than 0%, with each and the total at most 100%.'}
            </p>
          )}
          {selected.isError && (
            <p role="alert" className="text-sm text-destructive">
              {zh
                ? '部分策略暂不可读，不能自动替换为其他版本。请重试。'
                : 'Some strategies are unavailable. No other revision was substituted. Retry.'}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void selected.refetch()}
              >
                {zh ? '重试' : 'Retry'}
              </Button>
            </p>
          )}
        </section>
        <aside className="space-y-5 rounded-2xl border bg-card p-6">
          <h2 className="text-xl font-semibold">
            {zh ? '先守住账户边界' : 'Keep account limits first'}
          </h2>
          <dl className="space-y-4 text-sm">
            <div className="space-y-2">
              <dt className="text-xs text-muted-foreground">
                {zh ? '单股仓位上限' : 'Single position cap'}
              </dt>
              <dd className="rounded-lg border px-4 py-3">
                {account.investment.limits.maxPositionPct}%
              </dd>
            </div>
            <div className="space-y-2">
              <dt className="text-xs text-muted-foreground">
                {zh ? '最低现金比例' : 'Minimum cash'}
              </dt>
              <dd className="rounded-lg border px-4 py-3">
                {account.combination.cashFloorPct}%
              </dd>
            </div>
            <div className="space-y-2">
              <dt className="text-xs text-muted-foreground">
                {zh ? '策略信号冲突' : 'Strategy conflict'}
              </dt>
              <dd className="rounded-lg border px-4 py-3 leading-6">
                {zh
                  ? '阻止应用冲突组合，等待核对'
                  : 'Block conflicting combinations until reviewed'}
              </dd>
            </div>
          </dl>
          <p className="text-xs leading-6 text-muted-foreground">
            {zh
              ? '策略比例分配现金底线以上的可投资预算，作为买入上限。它不会自动再平衡，账户风险限制始终优先。'
              : 'Strategy percentages cap the investable budget above the cash floor. They do not rebalance holdings. Account limits always take priority.'}
          </p>
          <div className="border-t pt-4 text-sm">
            <p className="font-medium text-primary">
              {zh ? '生效账户：' : 'Target account: '}
              {account.name}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {zh ? '政策修订' : 'Policy revision'} {expectedRevision} →{' '}
              {expectedRevision + 1}
            </p>
          </div>
        </aside>
      </div>
      {preview && (
        <section
          aria-label={zh ? '组合预览' : 'Combination preview'}
          className="space-y-4 rounded-2xl border bg-card p-6"
        >
          <h2 className="text-lg font-semibold">
            {zh ? '变更与执行说明' : 'Changes and execution review'}
          </h2>
          <p className="text-sm leading-7 text-muted-foreground">
            {zh
              ? `将为「${account.name}」保存 ${preview.allocations.length} 个策略快照，启用预算合计 ${preview.allocatedPct}%。`
              : `Save ${preview.allocations.length} strategy snapshots for “${account.name}”, with ${preview.allocatedPct}% total enabled budget.`}
          </p>
          {preview.issues.length > 0 && (
            <ul className="space-y-3">
              {preview.issues.map((issue, index) => (
                <li
                  key={`${issue.code}:${index}`}
                  className="rounded-xl bg-muted/50 p-3 text-sm leading-6"
                >
                  <p>{issue.message[language]}</p>
                  {!!issue.strategyIds.length && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {issue.strategyIds
                        .map((id) => strategies.get(id)?.content.title ?? id)
                        .join(' · ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {preview.canApply ? (
            <p className="text-sm text-primary">
              {zh
                ? '预览通过。确认下方操作后，只切换此账户的策略组合。'
                : 'Preview passed. Confirm below to switch this account’s combination.'}
            </p>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {zh
                ? '请先处理上述问题，再重新预览。'
                : 'Resolve the issues above, then preview again.'}
            </p>
          )}
        </section>
      )}
      <footer className="space-y-3 border-t pt-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            {savedIdentity === identity
              ? zh
                ? '组合已保存'
                : 'Combination saved'
              : zh
                ? '有未保存的修改'
                : 'Unsaved changes'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={locked || invalidAllocation || allocated > 100}
              onClick={() => mutation.mutate('save')}
            >
              {zh ? '保存为草稿' : 'Save draft'}
            </Button>
            <Button
              variant={canApply ? 'outline' : 'default'}
              disabled={locked || invalidAllocation || allocated > 100}
              onClick={() => {
                setPreview(null);
                setReviewedIdentity(null);
                mutation.mutate('preview');
              }}
            >
              {mutation.isPending
                ? zh
                  ? '正在核对…'
                  : 'Checking…'
                : zh
                  ? '预览变更与执行说明'
                  : 'Preview changes and execution'}
            </Button>
            {canApply && (
              <Button
                disabled={locked}
                onClick={() => mutation.mutate('apply')}
              >
                {zh
                  ? `确认应用到「${account.name}」`
                  : `Apply to “${account.name}”`}
              </Button>
            )}
          </div>
        </div>
        {message && (
          <p role="status" className="text-sm text-primary">
            {message}
          </p>
        )}
        {(localError || mutation.isError) && (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>
              {localError ||
                portfolioWorkspaceError(mutation.error, zh, {
                  zh: '操作尚未确认，请核对账户版本后重试。',
                  en: 'The operation is unconfirmed. Check the account revision and retry.',
                })}
            </p>
            <Button variant="ghost" size="sm" onClick={onReload}>
              {zh ? '重新读取账户版本' : 'Reload account revision'}
            </Button>
          </div>
        )}
        {linked.isError && (
          <p role="alert" className="text-sm text-destructive">
            {zh
              ? '链接中的策略不可读，可从资料库重新选择。'
              : 'The linked strategy is unavailable. Choose another from the library.'}
          </p>
        )}
      </footer>
      <CombinationStrategyLibrary editor={editor} />
      {editing && (
        <InvestmentStrategyEditor
          item={editing.item}
          currentId={null}
          timezone={
            account.investment.policy?.baseConfig.timezone ?? 'Asia/Shanghai'
          }
          investment={account.investment}
          onClose={closeEditor}
          onChanged={() => {
            setPreview(null);
            setReviewedIdentity(null);
            void library.refetch();
            void selected.refetch();
          }}
          onReviewed={reviewSaved}
        />
      )}
    </div>
  );
}
