import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchResearchConversation, resumeDailyReport } from '@/api/research-conversations';
import { Button } from '@/components/ui/button';
import type { ResumeDailyReportInput } from '@shared/simple-conversation.interface';

export default function ResumeDailyReportButton({ sessionId }: { sessionId: string }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const queries = useQueryClient();
  const intent = useRef<{ sessionId: string; input: ResumeDailyReportInput } | null>(null);
  const resume = useMutation({
    mutationFn: async () => {
      if (!intent.current || intent.current.sessionId !== sessionId) {
        const saved = await fetchResearchConversation(sessionId);
        intent.current = { sessionId, input: { requestKey: crypto.randomUUID(), expectedRevision: saved.revision } };
      }
      return resumeDailyReport(sessionId, intent.current.input);
    },
    retry: false,
    onSuccess: () => {
      intent.current = null;
      for (const key of ['today', 'current-research', 'research-conversation', 'research-conversations']) {
        void queries.invalidateQueries({ queryKey: [key] });
      }
    },
  });
  return <div className="space-y-2">
    <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate()}>
      {resume.isPending ? (zh ? '正在续接…' : 'Resuming…') : (zh ? '继续完成已有日报' : 'Complete saved daily report')}
    </Button>
    <p className="text-xs text-muted-foreground">{zh ? '优先在本地整理已返回结果；需要补核验或汇总时会调用 AI。已有研究继续保留。' : 'Locally reformats returned results first; uses AI when a new check or summary is needed. Saved research is retained.'}</p>
    {resume.isError && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{zh ? '尚未续接成功。请确认原任务已结束、资料仍可用后重试；已有研究继续保留。' : 'Could not resume. Confirm the original task has ended and saved context is available, then retry. Saved research is retained.'}</p>}
  </div>;
}
