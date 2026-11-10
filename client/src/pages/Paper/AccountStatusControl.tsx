import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PortfolioAccountSummary } from '@shared/portfolio-workspace.interface';
import {
  portfolioWorkspaceApi,
  portfolioWorkspaceKeys,
} from '@/api/portfolio-workspace';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createRequestIntent } from '@/utils/simple-experience';
import { portfolioWorkspaceError } from '@/utils/portfolio-workspace';
import { pauseLegacyInvestment } from '@/api/ai-investment';

export default function AccountStatusControl({
  account,
  compact = false,
  shortLabel = false,
}: {
  account: PortfolioAccountSummary;
  compact?: boolean;
  shortLabel?: boolean;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      if (account.policyRevision === null) {
        return pauseLegacyInvestment(account.id, intent.current.keyFor({ accountId: account.id, status: account.status, legacy: true }));
      }
      const body = {
        accountId: account.id,
        expectedPolicyRevision: account.policyRevision,
        status: account.status,
      };
      const input = {
        expectedPolicyRevision: account.policyRevision,
        requestKey: intent.current.keyFor(body),
      };
      return account.status === 'paused'
        ? portfolioWorkspaceApi.resume(account.id, input)
        : portfolioWorkspaceApi.pause(account.id, input);
    },
    onSuccess: async () => {
      intent.current.complete();
      setConfirming(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.accounts }),
        client.invalidateQueries({
          queryKey: portfolioWorkspaceKeys.account(account.id),
        }),
        client.invalidateQueries({
          queryKey: portfolioWorkspaceKeys.combination(account.id),
        }),
      ]);
    },
  });
  if (account.status === 'archived'
    || (account.policyRevision === null && account.status !== 'running')
    || (account.status === 'paused' && account.strategyCount === 0))
    return null;
  const label =
    account.status === 'paused'
      ? zh
        ? '恢复并评估'
        : 'Resume and assess'
      : zh
        ? '暂停此账户'
        : 'Pause account';
  return (
    <>
      <Button
        variant={compact ? 'ghost' : 'outline'}
        size={compact ? 'sm' : 'default'}
        onClick={() => setConfirming(true)}
      >
        {shortLabel ? account.status === 'paused' ? (zh ? '恢复' : 'Resume') : (zh ? '暂停' : 'Pause') : label}
      </Button>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!mutation.isPending) setConfirming(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {label} · {account.name}
            </DialogTitle>
            <DialogDescription>
              {account.status === 'paused'
                ? zh
                  ? '恢复后将重新检查此账户的策略与条件，再决定是否执行。'
                  : 'Resume rechecks this account’s strategies and conditions before any execution.'
                : zh
                  ? '暂停此账户的全部自动订单，包括保护性卖出。估值记录会继续，其他账户不受影响。'
                  : 'Pause all automatic orders for this account, including protective sales. Valuation continues; other accounts are unaffected.'}
            </DialogDescription>
          </DialogHeader>
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {portfolioWorkspaceError(mutation.error, zh, {
                zh: '操作尚未确认，请重试。',
                en: 'The change is unconfirmed. Retry.',
              })}
            </p>
          )}
          <footer className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => setConfirming(false)}
            >
              {zh ? '取消' : 'Cancel'}
            </Button>
            <Button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? (zh ? '正在处理…' : 'Working…') : label}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
    </>
  );
}
