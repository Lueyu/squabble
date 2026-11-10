import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { deleteResearchDocumentVersion } from '@/api/research-documents';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createRequestIntent } from '@/utils/simple-experience';

export default function DeleteReportRecord({ id, title, version, onDeleted }: {
  id: string; title: string; version: number; onDeleted: () => void;
}) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [open, setOpen] = useState(false);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const client = useQueryClient();
  const deletion = useMutation({
    retry: false,
    mutationFn: () => {
      const body = { expectedVersion: version };
      return deleteResearchDocumentVersion(id, { ...body, requestKey: intent.current.keyFor({ id, ...body }) });
    },
    onSuccess: async () => {
      intent.current.complete(); setOpen(false); onDeleted();
      await Promise.all(['report-history', 'research-documents', 'research-document', 'current-research', 'daily-workspace', 'overall-daily-research']
        .map(key => client.invalidateQueries({ queryKey: [key] })));
    },
  });
  return <>
    <Button size="icon" variant="ghost" className="mt-3 shrink-0 text-muted-foreground hover:text-destructive" aria-label={zh ? `删除报告 ${title}` : `Delete report ${title}`} onClick={() => setOpen(true)}><Trash2 size={15} /></Button>
    <Dialog open={open} onOpenChange={value => { if (!deletion.isPending) setOpen(value); }}><DialogContent>
      <DialogHeader><DialogTitle>{zh ? '删除这条报告？' : 'Delete this report?'}</DialogTitle>
        <DialogDescription>{zh ? `删除“${title}”的第 ${version} 版，并停用它作为研究和策略依据。其它版本、已产生的成交和固定引用快照保留。` : `Delete version ${version} of “${title}” and stop using it as research or strategy evidence. Other versions, existing trades and frozen reference snapshots remain.`}</DialogDescription>
      </DialogHeader>
      {deletion.isError && <p role="alert" className="text-sm text-destructive">{zh ? '删除尚未确认。记录仍保留，请重试。' : 'Deletion is unconfirmed. The record is retained; please retry.'}</p>}
      <footer className="flex justify-end gap-2"><Button variant="ghost" disabled={deletion.isPending} onClick={() => setOpen(false)}>{zh ? '取消' : 'Cancel'}</Button>
        <Button variant="destructive" disabled={deletion.isPending} onClick={() => deletion.mutate()}>{deletion.isPending ? (zh ? '正在删除…' : 'Deleting…') : (zh ? '确认删除' : 'Confirm deletion')}</Button></footer>
    </DialogContent></Dialog>
  </>;
}
