import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import type { CouncilSession, ForkCouncilSession } from '@shared/council.interface';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';

export default function CouncilContinuationDialog({ session, messageId, reportId, onClose, onFork }: {
  session: CouncilSession; messageId: string; reportId?: string; onClose: () => void;
  onFork: (input: ForkCouncilSession) => Promise<CouncilSession>;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const navigate = useNavigate();
  const messageIndex = session.messages.findIndex(item => item.id === messageId);
  const messages = session.messages.slice(0, messageIndex + 1).filter(item => item.role !== 'system');
  const report = reportId ? session.reports.find(item => item.id === reportId) : session.reports.find(item => item.publicationOutcome !== 'failed' && item.revision <= (messages.at(-1)?.revision ?? 0));
  const initial = report ? [report.summary, ...report.dissent, report.nextReviewCondition].filter(Boolean).join('\n\n')
    : session.continuationSummary?.content ?? '';
  const [summary, setSummary] = useState(initial.length <= 6000 ? initial : '');
  const [title, setTitle] = useState(`${session.title || session.ticker} · ${zh ? '续聊' : 'continuation'}`.slice(0, 160));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>{zh ? '审阅摘要后继续讨论' : 'Review the summary and continue'}</DialogTitle>
      <DialogDescription>{zh ? '新分支只携带你确认的摘要及固定版本资料。摘要是待核实观点，原文保留供检索。' : 'The new branch carries your reviewed summary and fixed reports. The summary is unverified context; original messages remain searchable.'}</DialogDescription></DialogHeader>
    <Input aria-label={zh ? '分支标题' : 'Branch title'} value={title} maxLength={160} onChange={event => setTitle(event.target.value)} />
    {initial.length > 6000 && <p className="text-xs text-muted-foreground">{zh ? '原总结超过摘要上限。请参考原文撰写更短摘要；没有自动截断。' : 'The original summary exceeds the limit. Review the source and write a shorter summary; it has not been truncated.'}</p>}
    <Textarea aria-label={zh ? '可编辑阶段摘要' : 'Editable stage summary'} rows={10} maxLength={6000} value={summary} onChange={event => setSummary(event.target.value)} />
    <p className="text-xs text-muted-foreground">{summary.length}/6000 · {zh ? '保留分歧、待验证事项和下一步问题。' : 'Keep dissent, verification gaps, and the next question.'}</p>
    <details className="text-xs"><summary className="cursor-pointer">{zh ? '核对本轮原文' : 'Review source messages'} · {messages.length}</summary>
      {messages.map(message => <p key={message.id} className="mt-2 whitespace-pre-wrap"><strong>{message.memberName}: </strong>{message.content}</p>)}</details>
    <Link className="text-xs text-primary underline" to={`/council?session=${encodeURIComponent(session.id)}#council-message-${messageId}`}>{zh ? '打开父讨论' : 'Open parent discussion'}</Link>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <Button disabled={pending || !summary.trim() || !title.trim()} onClick={async () => {
      setPending(true); setError(null);
      try { const child = await onFork({ messageId, title, summary, ...(report ? { reportId: report.id } : {}) }); onClose(); navigate(`/council?session=${encodeURIComponent(child.id)}`); }
      catch (cause) { setError(errorMessage(cause, zh ? '创建分支失败' : 'Could not create branch')); }
      finally { setPending(false); }
    }}>{zh ? '确认摘要并创建分支' : 'Confirm summary and create branch'}</Button>
  </DialogContent></Dialog>;
}
