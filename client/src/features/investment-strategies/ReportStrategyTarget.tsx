import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { StrategySourceInput } from '@shared/user-investment-strategy.interface';
import {
  portfolioWorkspaceApi,
  portfolioWorkspaceKeys,
} from '@/api/portfolio-workspace';
import { investmentStrategiesApi } from '@/api/investment-strategies';
import { Button } from '@/components/ui/button';
import { createRequestIntent } from '@/utils/simple-experience';
import {
  stageStrategyAllocation,
  simulationStrategyPath,
} from '@/utils/portfolio-workspace';
import { portfolioWorkspaceError } from '@/utils/portfolio-workspace';

/** Exact report material becomes a disabled account draft; this flow never applies it. */
export default function ReportStrategyTarget({
  source,
  onClose,
}: {
  source: StrategySourceInput;
  onClose: () => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [accountId, setAccountId] = useState('');
  const navigate = useNavigate();
  const client = useQueryClient();
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const accounts = useQuery({
    queryKey: portfolioWorkspaceKeys.accounts,
    queryFn: portfolioWorkspaceApi.accounts,
    retry: false,
  });
  const targets = (accounts.data ?? []).filter(
    (account) =>
      account.status !== 'archived' && account.policyRevision !== null,
  );
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!targets.some((account) => account.id === accountId))
        throw Error(
          zh ? '请先选择模拟账户。' : 'Choose a simulation account first.',
        );
      const combination = await portfolioWorkspaceApi.combination(accountId);
      const draft = await investmentStrategiesApi.importSource(source);
      const allocations = stageStrategyAllocation(
        combination.draft?.allocations ?? combination.allocations,
        draft.id,
        draft.revision,
      );
      const payload = {
        allocations,
        expectedPolicyRevision: combination.policyRevision,
      };
      await portfolioWorkspaceApi.saveDraft(accountId, {
        ...payload,
        requestKey: intent.current.keyFor({ accountId, ...payload }),
      });
      return { accountId, draftId: draft.id };
    },
    onSuccess: async (result) => {
      intent.current.complete();
      await Promise.all([
        client.invalidateQueries({ queryKey: ['investment-strategies'] }),
        client.invalidateQueries({
          queryKey: portfolioWorkspaceKeys.account(result.accountId),
        }),
        client.invalidateQueries({
          queryKey: portfolioWorkspaceKeys.combination(result.accountId),
        }),
      ]);
      navigate(simulationStrategyPath(result.accountId, result.draftId));
    },
  });
  return (
    <section
      aria-label={zh ? '选择目标模拟账户' : 'Choose target simulation account'}
      className="space-y-4 rounded-xl border bg-background p-4"
    >
      <div>
        <h4 className="text-sm font-semibold">
          {zh ? '保存到哪个账户？' : 'Which account should receive this draft?'}
        </h4>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">
          {zh
            ? '复制原报告的固定来源，先加入组合草稿。核对策略、预算和预览后，再明确应用。'
            : 'Copy the report’s pinned source into a combination draft. Review the strategy, budget and preview before explicitly applying it.'}
        </p>
      </div>
      {accounts.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          {zh ? '正在读取账户…' : 'Loading accounts…'}
        </p>
      )}
      {accounts.isError && (
        <div role="alert" className="space-y-2 text-sm">
          <p>{zh ? '账户暂不可读。' : 'Accounts are unavailable.'}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void accounts.refetch()}
          >
            {zh ? '重试' : 'Retry'}
          </Button>
        </div>
      )}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={zh ? '目标账户' : 'Target account'}
      >
        {targets.map((account) => (
          <Button
            key={account.id}
            size="sm"
            variant={accountId === account.id ? 'default' : 'outline'}
            aria-pressed={accountId === account.id}
            disabled={mutation.isPending}
            onClick={() => setAccountId(account.id)}
          >
            {account.name}
          </Button>
        ))}
      </div>
      {!accounts.isPending && !accounts.isError && !targets.length && (
        <p className="text-sm leading-7 text-muted-foreground">
          {zh
            ? '先创建模拟账户，再回来保存这份报告草稿。'
            : 'Create a simulation account, then return to save this report draft.'}{' '}
          <Link className="text-primary underline" to="/paper">
            {zh ? '创建账户' : 'Create account'}
          </Link>
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={onClose}
        >
          {zh ? '取消' : 'Cancel'}
        </Button>
        <Button
          size="sm"
          disabled={!accountId || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending
            ? zh
              ? '正在保存草稿…'
              : 'Saving draft…'
            : zh
              ? '保存草稿并核对'
              : 'Save draft and review'}
        </Button>
      </div>
      {mutation.isError && (
        <p role="alert" className="text-sm text-destructive">
          {portfolioWorkspaceError(mutation.error, zh, {
            zh: '草稿暂未保存到此账户，请重试。已导入的来源仍保留在策略资料库。',
            en: 'The account draft was not saved. Retry; imported source material remains in the strategy library.',
          })}
        </p>
      )}
    </section>
  );
}
