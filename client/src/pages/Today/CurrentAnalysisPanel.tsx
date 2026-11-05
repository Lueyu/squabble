import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CurrentResearchView } from '@shared/simple-experience.interface';
import { refreshCurrentResearch } from '@/api/simple-experience';
import { Button } from '@/components/ui/button';
import { createRequestIntent, questionPath } from '@/utils/simple-experience';

export default function CurrentAnalysisPanel({ view, topicKey, date }: { view: CurrentResearchView; topicKey: string; date?: string }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const refresh = useMutation({ mutationFn: () => {
    const payload = { topicKey, ...(date ? { date } : {}) };
    return refreshCurrentResearch({ ...payload, requestKey: intent.current.keyFor(payload) });
  }, retry: false, onSuccess: data => { intent.current.complete(); client.setQueryData(['current-research', topicKey, date], data); void client.invalidateQueries({ queryKey: ['today'] }); } });
  const updating = view.state === 'generating' || refresh.isPending;
  return <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0">
      <h2 className="break-words text-lg font-semibold">{view.title || (zh ? '当前分析' : 'Current analysis')}</h2>
      {view.updatedAt && <p className="mt-1 text-xs text-muted-foreground">{zh ? '更新于 ' : 'Updated '}{new Date(view.updatedAt).toLocaleString(i18n.language)}</p>}
    </div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" asChild><Link to={questionPath(topicKey.startsWith('ticker:') ? { ticker: topicKey.slice(7) } : { date })}>{zh ? '问问大家' : 'Ask the team'}</Link></Button>
      <Button size="sm" disabled={updating} onClick={() => refresh.mutate()}>{updating ? (zh ? '更新中…' : 'Updating…') : (zh ? '更新分析' : 'Update analysis')}</Button></div></header>
    {view.changeSummary && <p className="rounded-lg bg-primary/5 p-3 text-sm">{view.changeSummary}</p>}
    {view.content ? <div className="prose prose-sm max-w-none break-words dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{view.content}</ReactMarkdown></div>
      : <p className="text-sm text-muted-foreground">{zh ? '还没有完整分析。可先提问，或连接 AI 后更新。' : 'No complete analysis yet. Ask a question, or connect AI and update.'}</p>}
    {(view.state === 'failed' || refresh.isError) && <p role="alert" className="text-sm text-destructive">{zh ? '本次更新未完成，上次完整分析继续保留。请重试。' : 'The update did not complete. The last complete analysis remains available. Please retry.'}</p>}
    {view.dataAsOf && <p className="text-xs text-muted-foreground">{zh ? '数据截至：' : 'Data as of: '}{view.dataAsOf}</p>}
  </section>;
}
