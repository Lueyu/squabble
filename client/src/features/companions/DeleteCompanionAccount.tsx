import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { PortfolioAccountSummary } from '@shared/portfolio-workspace.interface';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createRequestIntent } from '@/utils/simple-experience';
import { portfolioWorkspaceError } from '@/utils/portfolio-workspace';

export default function DeleteCompanionAccount({ account }: { account: PortfolioAccountSummary }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [open, setOpen] = useState(false);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const client = useQueryClient();
  const deletion = useMutation({
    retry: false,
    mutationFn: () => {
      const body = { expectedPolicyRevision: account.policyRevision };
      return portfolioWorkspaceApi.archive(account.id, { ...body, requestKey: intent.current.keyFor({ accountId: account.id, ...body }) });
    },
    onSuccess: async result => {
      intent.current.complete(); setOpen(false);
      client.setQueryData<PortfolioAccountSummary[]>(portfolioWorkspaceKeys.accounts, rows => rows?.map(row =>
        row.id === account.id ? { ...row, status: result.status, policyRevision: result.policyRevision } : row));
      await Promise.all([
        client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.accounts }),
        client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.account(account.id) }),
        client.invalidateQueries({ queryKey: ['portfolio-comparison'] }),
        client.invalidateQueries({ queryKey: ['daily-workspace'] }),
      ]);
    },
    onError: () => void client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.accounts }),
  });
  if (account.status === 'archived') return null;
  return <>
    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setOpen(true)} aria-label={zh ? `删除 ${account.name}` : `Delete ${account.name}`}><Trash2 size={14} />{zh ? '删除' : 'Delete'}</Button>
    <Dialog open={open} onOpenChange={value => { if (!deletion.isPending) setOpen(value); }}><DialogContent>
      <DialogHeader><DialogTitle>{zh ? '删除这个股友账户？' : 'Delete this companion account?'}</DialogTitle>
        <DialogDescription>{zh ? `“${account.name}”将停止运行并移出当前列表。历史账本、持仓和报告会保留，可在“已归档”中回看，其他账户不受影响。` : `“${account.name}” will stop running and leave the current list. Its ledger and report history, including holdings, remain available under Archived. Other accounts are unaffected.`}</DialogDescription>
      </DialogHeader>
      {deletion.isError && <p role="alert" className="text-sm text-destructive">{portfolioWorkspaceError(deletion.error, zh, { zh: '删除尚未确认，请重试。', en: 'Deletion is unconfirmed. Please retry.' })}</p>}
      <footer className="flex justify-end gap-2"><Button variant="ghost" disabled={deletion.isPending} onClick={() => setOpen(false)}>{zh ? '取消' : 'Cancel'}</Button>
        <Button variant="destructive" disabled={deletion.isPending} onClick={() => deletion.mutate()}>{deletion.isPending ? zh ? '正在处理…' : 'Working…' : zh ? '确认删除' : 'Confirm deletion'}</Button></footer>
    </DialogContent></Dialog>
  </>;
}
