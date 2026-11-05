import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchResearchDocument } from '@/api/research-documents';
import { Button } from '@/components/ui/button';
import { questionPath } from '@/utils/simple-experience';

/** Always reads the requested immutable document. No lookup or redirect to current research. */
export default function SimpleReportReader({ versionId }: { versionId: string }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const query = useQuery({ queryKey: ['research-document', versionId], queryFn: () => fetchResearchDocument(versionId), enabled: Boolean(versionId) });
  if (query.isPending) return <p role="status" className="p-6">{zh ? '正在读取原始材料…' : 'Loading original material…'}</p>;
  if (!query.data) return <div role="alert" className="space-y-3 p-6"><p>{zh ? '原始材料不可用，不能用当前分析替代。' : 'Original material is unavailable. Current analysis cannot replace it.'}</p><Button onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>;
  const { version } = query.data;
  return <article className="mx-auto w-full max-w-4xl space-y-5 p-3 pb-12 sm:p-6"><p className="text-sm text-muted-foreground">{zh ? '当时的研究依据 · 只读' : 'Research at the time · Read only'}</p>
    <h1 className="break-words text-2xl font-semibold">{version.title}</h1><p className="text-sm text-muted-foreground">{new Date(version.createdAt).toLocaleString(i18n.language)}{version.dataAsOf && <> · {zh ? '数据截至：' : 'Data as of: '}{version.dataAsOf}</>}</p>
    {(version.status === 'revoked' || version.sourceStatus === 'missing') && <p role="alert" className="rounded-lg border p-3 text-sm">{zh ? '原始材料保留，但部分依据已撤回或不可用。' : 'The original material is preserved; some evidence has been withdrawn or is unavailable.'}</p>}
    <Button asChild variant="outline"><Link to={questionPath({ versionId })}>{zh ? '问问当时的依据' : 'Ask about this evidence'}</Link></Button>
    {version.sections.map(section => <section id={section.id} key={section.id} className="space-y-3 rounded-xl border bg-card p-4 sm:p-6"><h2 className="text-lg font-semibold">{section.title}</h2><div className="prose prose-sm max-w-none break-words dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown></div></section>)}
    <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">{zh ? '当时的固定资料' : 'Frozen inputs at the time'}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{version.snapshot ? JSON.stringify(version.snapshot, null, 2) : (zh ? '历史快照未知' : 'Historical snapshot unknown')}</pre></details>
  </article>;
}
