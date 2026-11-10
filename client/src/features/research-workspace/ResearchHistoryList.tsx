import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { ResearchConversationView } from '@shared/simple-conversation.interface';
import { deleteResearchConversation } from '@/api/research-conversations';
import { createRequestIntent } from '@/utils/simple-experience';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  sessions: ResearchConversationView[];
  selectedId: string | null;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}

export default function ResearchHistoryList({
  sessions,
  selectedId,
  pending,
  error,
  onRetry,
  onSelect,
  onDeleted,
}: Props) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const [target, setTarget] = useState<ResearchConversationView | null>(null);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const deletion = useMutation({
    retry: false,
    mutationFn: (item: ResearchConversationView) => {
      const input = { expectedRevision: item.revision };
      return deleteResearchConversation(item.id, {
        ...input,
        requestKey: intent.current.keyFor({ id: item.id, ...input }),
      });
    },
    onSuccess: (result) => {
      intent.current.complete();
      setTarget(null);
      client.setQueryData<ResearchConversationView[]>(
        ['research-conversations'],
        (rows) => rows?.filter((item) => item.id !== result.id),
      );
      // Clear a selected transcript without detaching its still-mounted observer.
      client.setQueryData(['research-conversation', result.id], null);
      onDeleted(result.id);
      void client.invalidateQueries({ queryKey: ['research-conversations'] });
    },
  });
  const errorBody = (
    deletion.error as {
      response?: { data?: { code?: string; message?: string } };
    }
  )?.response?.data;
  const errorCode = `${errorBody?.code ?? ''} ${errorBody?.message ?? ''}`;
  const deletionError = errorCode.includes('REQUIRES_SETTLEMENT')
    ? zh
      ? '请先打开研究，停止正在运行的任务并等待状态结算，再删除。'
      : 'Open this research, stop the active work and wait for it to settle before deleting.'
    : errorCode.includes('REVISION')
      ? zh
        ? '任务状态已变化。请取消并刷新历史，再确认删除。'
        : 'The task changed. Cancel and refresh history before confirming again.'
      : zh
        ? '删除尚未确认。请重试，原研究仍保留。'
        : 'Deletion is unconfirmed. Retry; the original research is still retained.';
  const status = (value: string) =>
    ({
      running: zh ? '研究中' : 'Researching',
      completed: zh ? '已完成' : 'Completed',
      paused: zh ? '已暂停' : 'Paused',
      failed: zh ? '需处理' : 'Needs attention',
      idle: zh ? '等待中' : 'Waiting',
    })[value] ?? (zh ? '已保存' : 'Saved');

  return (
    <>
      {pending && (
        <p role="status" className="research-history-notice">
          {zh ? '正在读取研究历史…' : 'Loading research history…'}
        </p>
      )}
      {error && (
        <div role="alert" className="research-history-notice">
          <p>
            {zh ? '研究历史暂时无法读取。' : 'Research history is unavailable.'}
          </p>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {zh ? '重试读取' : 'Retry history'}
          </Button>
        </div>
      )}
      {!pending && !error && !sessions.length && (
        <p className="research-history-notice">
          {zh
            ? '从一个问题开始，研究会保存在这里。'
            : 'Start with a question. Your research will be saved here.'}
        </p>
      )}
      <ul className="research-history-list">
        {sessions.map((item) => {
          const name =
            item.title ||
            item.subject ||
            item.ticker ||
            (zh ? '未命名研究' : 'Untitled research');
          return (
            <li
              key={item.id}
              className={selectedId === item.id ? 'is-selected' : ''}
            >
              <button
                className="research-history-select"
                type="button"
                aria-label={zh ? `打开 ${name}` : `Open ${name}`}
                aria-current={selectedId === item.id ? 'page' : undefined}
                onClick={() => onSelect(item.id)}
              >
                <strong>{name}</strong>
                <span>
                  {status(item.status)} ·{' '}
                  {new Date(
                    item.updatedAt || item.createdAt,
                  ).toLocaleDateString(i18n.language)}
                </span>
              </button>
              <Button
                className="research-history-delete"
                variant="ghost"
                size="icon"
                aria-label={zh ? `删除 ${name}` : `Delete ${name}`}
                onClick={() => {
                  deletion.reset();
                  setTarget(item);
                }}
              >
                <Trash2 size={15} />
              </Button>
            </li>
          );
        })}
      </ul>
      <Dialog
        open={Boolean(target)}
        onOpenChange={(open) => {
          if (!open && !deletion.isPending) setTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {zh ? '删除这条研究任务？' : 'Delete this research task?'}
            </DialogTitle>
            <DialogDescription>
              {zh
                ? `“${target?.title ?? ''}”将从研究历史移除。已保存的原报告与交易记录仍会保留；运行中的任务需要先停止并完成状态结算。`
                : `“${target?.title ?? ''}” will leave research history. Saved original reports and trading records remain. Active work must be stopped and settled first.`}
            </DialogDescription>
          </DialogHeader>
          {deletion.isError && (
            <p role="alert" className="text-sm text-destructive">
              {deletionError}
            </p>
          )}
          <footer className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={deletion.isPending}
              onClick={() => {
                setTarget(null);
                if (errorCode.includes('REVISION')) onRetry();
              }}
            >
              {zh ? '取消' : 'Cancel'}
            </Button>
            <Button
              variant="destructive"
              disabled={deletion.isPending || !target}
              onClick={() => target && deletion.mutate(target)}
            >
              {deletion.isPending
                ? zh
                  ? '正在处理…'
                  : 'Working…'
                : zh
                  ? '确认删除'
                  : 'Confirm deletion'}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
    </>
  );
}
