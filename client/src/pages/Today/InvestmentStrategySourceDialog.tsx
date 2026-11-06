import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { investmentStrategiesApi, type StrategySourceInput } from '@/api/investment-strategies';
import { fetchResearchDocument } from '@/api/research-documents';
import { readableResearchSection, readableResearchSections } from '@shared/research-reading';
import type { UserInvestmentStrategy } from '@shared/user-investment-strategy.interface';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ResearchMarkdown from '@/components/ResearchMarkdown';

export default function InvestmentStrategySourceDialog({ source, onClose }: { source: StrategySourceInput | null; onClose: () => void }) {
  if (!source) return null;
  return <SourceDialog key={JSON.stringify(source)} source={source} onClose={onClose} />;
}
function SourceDialog({ source, onClose }: { source: StrategySourceInput; onClose: () => void }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh'); const client = useQueryClient();
  const [draftId, setDraftId] = useState(''); const [saved, setSaved] = useState(false);
  const [olderDrafts, setOlderDrafts] = useState<UserInvestmentStrategy[]>([]);
  const [nextDraftCursor, setNextDraftCursor] = useState<string | null | undefined>();
  const [sectionId, setSectionId] = useState(source.kind === 'report' ? source.sectionId ?? '' : '');
  const report = useQuery({ queryKey: ['investment-strategy-source-report', source.kind === 'report' ? source.versionId : null],
    queryFn: () => source.kind === 'report' ? fetchResearchDocument(source.versionId) : Promise.reject(new Error('Report source required')), enabled: source.kind === 'report', retry: false });
  const bounded = (raw: string, readable: string) => raw.length <= 200000 && readable.length > 0 && readable.length <= 12000;
  const version = report.data?.version;
  const wholeAllowed = !!version && bounded(version.content, readableResearchSections(version.sections));
  const selectedSection = version?.sections.find(section => section.id === sectionId);
  const selectionAllowed = source.kind === 'message' || (sectionId ? !!selectedSection && bounded(selectedSection.content, readableResearchSection(selectedSection)) : wholeAllowed);
  const selectedSource: StrategySourceInput = source.kind === 'report' ? { kind: 'report', versionId: source.versionId, ...(sectionId ? { sectionId } : {}) } : source;
  const workspace = useQuery({ queryKey: ['investment-strategies'], queryFn: investmentStrategiesApi.workspace });
  const drafts = [...(workspace.data?.drafts ?? []), ...olderDrafts].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const draftsCursor = nextDraftCursor === undefined ? workspace.data?.draftsCursor : nextDraftCursor;
  const loadDrafts = useMutation({ mutationFn: () => investmentStrategiesApi.drafts(draftsCursor ?? undefined), retry: false,
    onSuccess: page => { setOlderDrafts(previous => [...previous, ...page.items]); setNextDraftCursor(page.nextCursor); } });
  const addition = useQuery({ queryKey: ['investment-strategy-source', selectedSource, draftId],
    queryFn: () => investmentStrategiesApi.sourcePreview(draftId || undefined, selectedSource), enabled: selectionAllowed, retry: false });
  const draft = drafts.find(item => item.id === draftId);
  const save = useMutation({ mutationFn: async () => {
    if (!selectionAllowed || !addition.data || addition.isFetching || addition.isError || addition.data.alreadyAdded) throw new Error('Review the source addition first');
    return draft ? investmentStrategiesApi.addSource(draft.id, { expectedRevision: draft.revision, source: selectedSource }) : investmentStrategiesApi.importSource(selectedSource);
  }, retry: false, onSuccess: () => { setSaved(true); void client.invalidateQueries({ queryKey: ['investment-strategies'] }); } });
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent className="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{zh ? '加入投资策略' : 'Add to investment strategy'}</DialogTitle><DialogDescription>
      {zh ? '先核对增补内容，保存后可在今日页编辑。当前执行中的策略继续运行。' : 'Review the addition, then edit it on Today. The currently applied strategy keeps running.'}
    </DialogDescription></DialogHeader>
    {saved ? <div role="status" className="space-y-4"><p>{zh ? '已保存到策略草稿。应用前仍可修改或删除。' : 'Saved to your strategy draft. You can edit or remove it before applying.'}</p>
      <div className="flex flex-wrap gap-2"><Button asChild><Link to="/" onClick={onClose}>{zh ? '去今日编辑' : 'Edit on Today'}</Link></Button><Button variant="outline" onClick={onClose}>{zh ? '继续阅读' : 'Continue reading'}</Button></div></div>
      : <div className="min-w-0 space-y-4">
        {source.kind === 'report' && version && <label className="block space-y-2 text-sm"><span>{zh ? '加入的报告内容' : 'Report content to add'}</span>
          <select aria-label={zh ? '加入的报告内容' : 'Report content to add'} className="w-full rounded-lg border bg-background p-2" disabled={save.isPending}
            value={sectionId || (wholeAllowed ? '' : '__choose__')} onChange={event => setSectionId(event.target.value)}>
            {!wholeAllowed && <option value="__choose__" disabled>{zh ? '请选择可整理的报告章节' : 'Choose a report section'}</option>}
            <option value="" disabled={!wholeAllowed}>{zh ? '完整报告' : 'Full report'}</option>
            {version.sections.map(section => <option key={section.id} value={section.id} disabled={!bounded(section.content, readableResearchSection(section))}>{section.title}</option>)}
          </select>
          {!wholeAllowed && <p className="text-xs text-muted-foreground">{zh ? '报告较长或尚待整理，请选择不超过 12,000 字符的可读章节。' : 'Choose a readable section of at most 12,000 characters from this long or unformatted report.'}</p>}
        </label>}
        <label className="block space-y-2 text-sm"><span>{zh ? '保存位置' : 'Save to'}</span><select aria-label={zh ? '保存位置' : 'Save to'} className="w-full rounded-lg border bg-background p-2" value={draftId} disabled={save.isPending} onChange={event => setDraftId(event.target.value)}>
          <option value="">{zh ? '新建一份草稿' : 'Create a new draft'}</option>{drafts.map(item => <option key={item.id} value={item.id}>{item.content.title}</option>)}
        </select></label>
        {draftsCursor && <Button size="sm" variant="outline" disabled={save.isPending || loadDrafts.isPending} onClick={() => loadDrafts.mutate()}>{zh ? '读取更早草稿' : 'Load older drafts'}</Button>}
        {draft && <div className="rounded-xl border bg-muted/30 p-3 text-sm"><p className="font-medium">{zh ? '保留已有手写内容' : 'Existing manual text stays'}</p><p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{draft.content.body || (zh ? '已有条目保留在草稿中。' : 'Existing entries remain in the draft.')}</p></div>}
        {(workspace.isError || loadDrafts.isError || source.kind === 'report' && report.isError || selectionAllowed && addition.isError || save.isError) && <p role="alert" className="text-sm text-destructive">{zh ? '来源或草稿暂时不可用，请关闭后重新核对。内容尚未覆盖。' : 'The source or draft is unavailable. Close and review again. Your text has not been overwritten.'}</p>}
        {(source.kind === 'report' && report.isPending || selectionAllowed && (addition.isPending || addition.isFetching)) && <p role="status" className="text-sm text-muted-foreground">{zh ? '正在核对固定来源…' : 'Checking the pinned source…'}</p>}
        {selectionAllowed && addition.data && !addition.isFetching && <div className="min-w-0 space-y-2 rounded-xl border p-3"><h3 className="text-sm font-medium">{addition.data.alreadyAdded ? (zh ? '此来源已在草稿中' : 'This source is already in the draft') : (zh ? '将新增的观察条目' : 'Observation entries to add')}</h3>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{addition.data.source.title} · {new Date(addition.data.source.createdAt).toLocaleString(i18n.language)}</p>
          {addition.data.entries.map(entry => <ResearchMarkdown key={entry.id}>{entry.text}</ResearchMarkdown>)}
          <p className="text-xs text-muted-foreground">{zh ? '保留原报告或观点引用；保存草稿不会自动交易。' : 'The exact report or opinion remains pinned. Saving a draft does not start trading.'}</p>
        </div>}
        <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={onClose} disabled={save.isPending}>{zh ? '取消' : 'Cancel'}</Button>
          <Button onClick={() => save.mutate()} disabled={!selectionAllowed || !addition.data || addition.isPending || addition.isFetching || addition.isError || save.isPending || addition.data.alreadyAdded || !!draftId && !draft}>
            {save.isPending ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存到草稿' : 'Save to draft')}</Button></div>
      </div>}
  </DialogContent></Dialog>;
}
