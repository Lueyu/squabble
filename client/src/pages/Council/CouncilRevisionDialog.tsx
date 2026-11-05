import { useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { fetchResearchDocument } from '@/api/research-documents';
import { reviseCouncilReport } from '@/api/council';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';

export default function CouncilRevisionDialog({ sessionId, reportId, parentVersionId, onClose }: {
  sessionId: string; reportId: string; parentVersionId: string; onClose: () => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const navigate = useNavigate();
  const [sectionId, setSectionId] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const parent = useQuery({ queryKey: ['research-documents', 'version', parentVersionId], queryFn: () => fetchResearchDocument(parentVersionId), retry: false });
  const revision = useMutation({ mutationFn: (generate: boolean) => reviseCouncilReport(sessionId, reportId, parentVersionId,
    { sectionId: sectionId || undefined, generate, ...(generate ? { requestId: requestId.current } : {}) }), retry: false,
    onSuccess: draft => navigate(`/analysis/reports/${encodeURIComponent(draft.parentVersionId)}?draftId=${encodeURIComponent(draft.id)}`) });
  return <Dialog open onOpenChange={open => { if (!open && !revision.isPending) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{zh ? '修订固定报告版本' : 'Revise a fixed report version'}</DialogTitle>
      <DialogDescription>{zh ? '选择替换原章节或新增讨论建议。生成后可编辑并核对差异；原版保留，发布与采纳需另行确认。' : 'Replace an existing section or add a discussion proposal. Edit the draft and review differences. The original remains; publication and adoption are separate actions.'}</DialogDescription></DialogHeader>
    {parent.data && <p className="text-sm">{parent.data.version.title} · v{parent.data.version.version}</p>}
    <select aria-label={zh ? '修订章节' : 'Section to revise'} value={sectionId} disabled={revision.isPending} onChange={event => { setSectionId(event.target.value); requestId.current = crypto.randomUUID(); revision.reset(); }} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
      <option value="">{zh ? '新增讨论建议章节' : 'Add discussion proposal section'}</option>
      {parent.data?.version.sections.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}
    </select>
    {sectionId && <details className="max-h-52 overflow-y-auto text-xs"><summary className="cursor-pointer">{zh ? '查看原章节' : 'View original section'}</summary>
      <p className="mt-2 whitespace-pre-wrap">{parent.data?.version.sections.find(section => section.id === sectionId)?.content}</p></details>}
    {(parent.error || revision.error) && <p role="alert" className="text-xs text-destructive">{errorMessage(parent.error ?? revision.error, zh ? '修订失败' : 'Revision failed')}</p>}
    <p className="text-xs text-muted-foreground">{zh ? 'AI生成将调用本讨论主持人的模型并使用研究预算。同一请求不会重复调用。' : 'AI generation calls the discussion manager’s model and uses the research budget. The same request is never replayed.'}</p>
    <Button disabled={!parent.data || revision.isPending} onClick={() => revision.mutate(true)}>{zh ? 'AI生成可编辑修订草稿' : 'Generate editable revision with AI'}</Button>
    <Button variant="outline" disabled={!parent.data || revision.isPending} onClick={() => revision.mutate(false)}>{zh ? '直接以阶段总结创建草稿' : 'Create draft from stage summary'}</Button>
  </DialogContent></Dialog>;
}
