import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PortfolioAccountSummary } from '@shared/portfolio-workspace.interface';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createRequestIntent } from '@/utils/simple-experience';
import CompanionPicker from './CompanionPicker';

export default function AccountCompanionEditor({ account, onClose }: { account: PortfolioAccountSummary; onClose: () => void }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const [selected, setSelected] = useState(account.companionId ?? null);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const mutation = useMutation({
    retry: false,
    mutationFn: () => {
      if (!selected) throw new Error('COMPANION_REQUIRED');
      const input = { companionId: selected, expectedRevision: account.companionRevision ?? 0 };
      return portfolioWorkspaceApi.setCompanion(account.id, { ...input, requestKey: intent.current.keyFor(input) });
    },
    onSuccess: async () => {
      intent.current.complete();
      await Promise.all([
        client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.accounts }),
        client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.account(account.id) }),
      ]);
      onClose();
    },
    onError: () => void client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.account(account.id) }),
  });
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader><DialogTitle>{zh ? '选择陪你观察的股友' : 'Choose your companion'} · {account.name}</DialogTitle>
        <DialogDescription>{zh ? '选择动物形象。资金、持仓和已确认的执行策略保持原样；研究成员在设置中单独配置。' : 'Choose an animal identity. Funds, holdings and confirmed strategies stay intact; configure research members separately in Settings.'}</DialogDescription>
      </DialogHeader>
      <CompanionPicker value={selected} onChange={setSelected} zh={zh} expanded disabled={mutation.isPending} />
      {mutation.isError && <p role="alert" className="text-sm text-destructive">{zh ? '股友尚未更新。如果另一处已修改，请关闭后重新选择；否则可以重试。' : 'The companion was not updated. Reopen if it changed elsewhere, or retry.'}</p>}
      <footer className="flex justify-end gap-2"><Button variant="ghost" disabled={mutation.isPending} onClick={onClose}>{zh ? '取消' : 'Cancel'}</Button>
        <Button disabled={!selected || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? zh ? '正在保存…' : 'Saving…' : zh ? '保存股友' : 'Save companion'}</Button></footer>
    </DialogContent>
  </Dialog>;
}
