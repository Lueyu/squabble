import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { investmentStrategiesApi, type StrategySourceInput } from '@/api/investment-strategies';
import { fetchResearchDocument } from '@/api/research-documents';
import { readableResearchSection } from '@shared/research-reading';
import { STRATEGY_SOURCE_MAX_CHARACTERS, STRATEGY_ENTRY_MAX_CHARACTERS,
  strategyImportSections, strategyImportReadableContent, splitStrategySourceText } from '@shared/strategy-source-reading';
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
  const [draftId, setDraftId] = useState(''); const [savedId, setSavedId] = useState<string | null>(null);
  const [olderDrafts, setOlderDrafts] = useState<UserInvestmentStrategy[]>([]);
  const [nextDraftCursor, setNextDraftCursor] = useState<string | null | undefined>();
  const [sectionId, setSectionId] = useState(source.kind === 'report' ? source.sectionId ?? '' : '');
  const [sectionChosen, setSectionChosen] = useState(false);
  const report = useQuery({ queryKey: ['investment-strategy-source-report', source.kind === 'report' ? source.versionId : null],
    queryFn: () => source.kind === 'report' ? fetchResearchDocument(source.versionId) : Promise.reject(new Error('Report source required')), enabled: source.kind === 'report', retry: false });
  const bounded = (raw: string, readable: string) => raw.length <= STRATEGY_SOURCE_MAX_CHARACTERS && readable.length > 0 && readable.length <= STRATEGY_SOURCE_MAX_CHARACTERS;
  const version = report.data?.version;
  const sections = version ? strategyImportSections(version) : [];
  const effectiveSectionId = !sectionChosen && !sectionId && version?.snapshot?.executionPlan && sections.some(section => section.id === 'execution-strategy') ? 'execution-strategy' : sectionId;
  const wholeAllowed = !!version && bounded(version.content, strategyImportReadableContent(version));
  const selectedSection = sections.find(section => section.id === effectiveSectionId);
  const invalidSelection = !!version && !!effectiveSectionId && !selectedSection;
  const selectedReadable = version ? strategyImportReadableContent(version, effectiveSectionId || undefined) : '';
  const selectionAllowed = source.kind === 'message' || (effectiveSectionId ? !!selectedSection && bounded(selectedSection.content, selectedReadable) : wholeAllowed);
  const observationCount = selectionAllowed && source.kind === 'report' && effectiveSectionId !== 'execution-strategy' ? splitStrategySourceText(selectedReadable).length : 0;
  const selectedSource: StrategySourceInput = source.kind === 'report' ? { kind: 'report', versionId: source.versionId, ...(effectiveSectionId ? { sectionId: effectiveSectionId } : {}) } : source;
  const workspace = useQuery({ queryKey: ['investment-strategies'], queryFn: investmentStrategiesApi.workspace });
  const drafts = [...(workspace.data?.drafts ?? []), ...olderDrafts].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const draftsCursor = nextDraftCursor === undefined ? workspace.data?.draftsCursor : nextDraftCursor;
  const loadDrafts = useMutation({ mutationFn: () => investmentStrategiesApi.drafts(draftsCursor ?? undefined), retry: false,
    onSuccess: page => { setOlderDrafts(previous => [...previous, ...page.items]); setNextDraftCursor(page.nextCursor); } });
  const addition = useQuery({ queryKey: ['investment-strategy-source', selectedSource, draftId],
    queryFn: () => investmentStrategiesApi.sourcePreview(draftId || undefined, selectedSource), enabled: selectionAllowed, retry: false });
  const draft = drafts.find(item => item.id === draftId);
  const executionPlan = addition.data?.source.executionPlan;
  const limitLabels: Record<string, string> = { maxPositionPct: zh ? '单股仓位上限' : 'Single-position cap', maxOrderPct: zh ? '单笔资金上限' : 'Single-order cap',
    maxDailyIncreasePct: zh ? '每日新增仓位上限' : 'Daily increase cap', maxDailyTurnoverPct: zh ? '每日交易金额上限' : 'Daily turnover cap',
    minCashPct: zh ? '最低现金比例' : 'Minimum cash', maxGrossExposurePct: zh ? '总仓位上限' : 'Gross exposure cap' };
  const save = useMutation({ mutationFn: async () => {
    if (!selectionAllowed || !addition.data || addition.isFetching || addition.isError || addition.data.alreadyAdded) throw new Error('Review the source addition first');
    return draft ? investmentStrategiesApi.addSource(draft.id, { expectedRevision: draft.revision, source: selectedSource }) : investmentStrategiesApi.importSource(selectedSource);
  }, retry: false, onSuccess: saved => { setSavedId(saved.id); void client.invalidateQueries({ queryKey: ['investment-strategies'] }); } });
  const sourceError = ((save.isError ? save.error : addition.isError ? addition.error : null) as {
    response?: { data?: { message?: string; error?: { message?: string } } };
  } | null)?.response?.data;
  const sourceErrorMessage = String(sourceError?.error?.message ?? sourceError?.message ?? '');
  const periodConflict = /create a new draft.*period/iu.test(sourceErrorMessage);
  const capacityConflict = /At most 20 strategy sources and entries/iu.test(sourceErrorMessage);
  const planUnavailable = /No validated report execution strategy/iu.test(sourceErrorMessage);
  const sourceTooLong = /exceeds 200000 characters/iu.test(sourceErrorMessage);
  const draftChanged = /Strategy changed or is immutable|Create an editable draft first/iu.test(sourceErrorMessage);
  const sourceUnavailable = /Report revoked|Report is not available|Report publication is not ready|Report section not found|not[_ ]found/iu.test(sourceErrorMessage);
  const failureText = periodConflict ? (zh ? '策略有效期超出这份草稿。请选择“新建一份草稿”以保留建议期限。已有草稿保持原样。' : 'The strategy period exceeds this draft. Choose “Create a new draft” to keep the proposed period. Your existing draft stays unchanged.')
    : capacityConflict ? (zh ? '增补后会超过 20 个来源或条目的上限。请选择其他草稿、新建草稿或较短章节。' : 'This addition would exceed 20 sources or entries. Choose another draft, a new draft or a smaller section.')
    : planUnavailable ? (zh ? '本报告没有通过校验的执行策略。请选择完整报告或可读研究章节，保存为观察事项。' : 'This report has no validated execution proposal. Select the full report or a readable research section to save observation items.')
    : sourceTooLong ? (zh ? '来源超过 200,000 字符。请选择较短的可读章节，内容不会被截断。' : 'The source exceeds 200,000 characters. Select a smaller readable section; text will not be truncated.')
    : draftChanged ? (zh ? '这份草稿已变更或已确认。请重新读取草稿，或选择另一份可编辑草稿。' : 'This draft changed or was confirmed. Reload it or choose another editable draft.')
    : sourceUnavailable ? (zh ? '固定报告已撤回或暂不可用。请选择仍可用的报告或章节。' : 'The pinned report is withdrawn or unavailable. Choose an available report or section.')
    : (zh ? '来源或草稿暂时不可用，请关闭后重新核对。内容尚未覆盖。' : 'The source or draft is unavailable. Close and review again. Your text has not been overwritten.');
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose(); }}><DialogContent className="max-h-[85dvh] min-w-0 overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{zh ? '加入投资策略' : 'Add to investment strategy'}</DialogTitle><DialogDescription>
      {zh ? '核对后保存到模拟盘草稿，可继续编辑，再确认执行。当前执行中的策略继续运行。' : 'Save the reviewed addition to a simulation draft, then edit and confirm execution. The currently applied strategy keeps running.'}
    </DialogDescription></DialogHeader>
    {savedId ? <div role="status" className="space-y-4"><p>{zh ? '已保存到策略草稿。应用前仍可修改或删除。' : 'Saved to your strategy draft. You can edit or remove it before applying.'}</p>
      <div className="flex flex-wrap gap-2"><Button asChild><Link to={`/paper?investmentStrategyId=${encodeURIComponent(savedId)}#investment-strategy`} onClick={onClose}>{zh ? '去 AI 模拟盘核对' : 'Review in AI simulation'}</Link></Button><Button variant="outline" onClick={onClose}>{zh ? '继续阅读' : 'Continue reading'}</Button></div></div>
      : <div className="min-w-0 space-y-4">
        {source.kind === 'report' && version && <label className="block space-y-2 text-sm"><span>{zh ? '加入的报告内容' : 'Report content to add'}</span>
          <select aria-label={zh ? '加入的报告内容' : 'Report content to add'} className="w-full rounded-lg border bg-background p-2" disabled={save.isPending}
            value={invalidSelection ? '__choose__' : effectiveSectionId || (wholeAllowed ? '' : '__choose__')} onChange={event => { if (save.isError) save.reset(); setSectionChosen(true); setSectionId(event.target.value); }}>
            {(!wholeAllowed || invalidSelection) && <option value="__choose__" disabled>{zh ? '请选择可整理的报告章节' : 'Choose a report section'}</option>}
            <option value="" disabled={!wholeAllowed}>{zh ? '完整报告' : 'Full report'}</option>
            {sections.map(section => <option key={section.id} value={section.id} disabled={!bounded(section.content, readableResearchSection(section))}>{section.title}</option>)}
          </select>
          {invalidSelection && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{zh ? '所选策略章节不可用。请选择完整报告或其他可读章节，保存为观察事项。' : 'The selected strategy section is unavailable. Choose the full report or another readable section to save observation items.'}</p>}
          {!wholeAllowed && <p className="text-xs text-muted-foreground">{zh ? '完整报告过长或尚无可读内容，请选择不超过 200,000 字符的可读章节。' : 'The full report is too long or unreadable. Choose a readable section of at most 200,000 characters.'}</p>}
          {!sections.some(section => section.id === 'execution-strategy') && !invalidSelection && <p className="text-xs text-muted-foreground">{zh ? '本报告没有通过校验的结构化执行策略，可将研究内容保存为观察事项。' : 'This report has no validated structured execution proposal. Save its research as observation items.'}</p>}
          {observationCount > 0 && <p className="text-xs text-muted-foreground">{zh ? `内容将完整保留，保存为 ${observationCount} 条观察事项，每条不超过 ${STRATEGY_ENTRY_MAX_CHARACTERS.toLocaleString('en-US')} 字符。` : `All text is preserved in ${observationCount} observation items of at most ${STRATEGY_ENTRY_MAX_CHARACTERS.toLocaleString('en-US')} characters each.`}</p>}
        </label>}
        <label className="block space-y-2 text-sm"><span>{zh ? '保存位置' : 'Save to'}</span><select aria-label={zh ? '保存位置' : 'Save to'} className="w-full rounded-lg border bg-background p-2" value={draftId} disabled={save.isPending} onChange={event => { if (save.isError) save.reset(); setDraftId(event.target.value); }}>
          <option value="">{zh ? '新建一份草稿' : 'Create a new draft'}</option>{drafts.map(item => <option key={item.id} value={item.id}>{item.content.title}</option>)}
        </select></label>
        {draftsCursor && <Button size="sm" variant="outline" disabled={save.isPending || loadDrafts.isPending} onClick={() => loadDrafts.mutate()}>{zh ? '读取更早草稿' : 'Load older drafts'}</Button>}
        {draft && <div className="rounded-xl border bg-muted/30 p-3 text-sm"><p className="font-medium">{zh ? '保留已有手写内容' : 'Existing manual text stays'}</p><p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{draft.content.body || (zh ? '已有条目保留在草稿中。' : 'Existing entries remain in the draft.')}</p></div>}
        {(workspace.isError || loadDrafts.isError || source.kind === 'report' && report.isError || selectionAllowed && addition.isError || save.isError) && <p role="alert" className="text-sm text-destructive">{failureText}</p>}
        {(source.kind === 'report' && report.isPending || selectionAllowed && (addition.isPending || addition.isFetching)) && <p role="status" className="text-sm text-muted-foreground">{zh ? '正在核对固定来源…' : 'Checking the pinned source…'}</p>}
        {selectionAllowed && addition.data && !addition.isFetching && <div className="min-w-0 space-y-2 rounded-xl border p-3"><h3 className="text-sm font-medium">{addition.data.alreadyAdded ? (zh ? '此来源已在草稿中' : 'This source is already in the draft') : (zh ? '将新增的策略条目' : 'Strategy entries to add')}</h3>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{addition.data.source.title} · {new Date(addition.data.source.createdAt).toLocaleString(i18n.language)}</p>
          {addition.data.entries.map(entry => <ResearchMarkdown key={entry.id}>{entry.text}</ResearchMarkdown>)}
          {executionPlan && <div className="space-y-2 rounded-lg bg-primary/5 p-3 text-xs leading-6"><p className="font-medium">{executionPlan.readiness === 'ready' ? (zh ? '执行说明待你核对' : 'Execution details await your review') : executionPlan.readiness === 'no_trade' ? (zh ? '暂不交易' : 'No trade proposed') : (zh ? '待补信息，尚不可执行' : 'Needs information before execution')}</p>
            {executionPlan.noTradeReason && <p className="[overflow-wrap:anywhere]">{executionPlan.noTradeReason}</p>}
            {executionPlan.preview.entries.map(entry => <p key={entry.id} className="[overflow-wrap:anywhere]">{entry.explanation[zh ? 'zh-CN' : 'en']}</p>)}
            {executionPlan.parameterOrigin !== 'system_observation' && (executionPlan.strategy.limits || executionPlan.readiness !== 'no_trade') && <><p className="font-medium">{zh ? 'AI 提议的风险边界' : 'AI-proposed risk limits'}</p>
            {executionPlan.strategy.limits ? <ul>{Object.entries(executionPlan.strategy.limits).map(([key, value]) => <li key={key}>{limitLabels[key]}: {value}%</li>)}</ul> : <p>{zh ? '应用前需补充并核对风险边界。' : 'Complete and review risk limits before applying.'}</p>}</>}
            {[...new Set([...executionPlan.gaps, ...executionPlan.preview.issues.map(issue => issue.message[zh ? 'zh-CN' : 'en'])])].map(item => <p key={item} className="text-amber-700 [overflow-wrap:anywhere] dark:text-amber-300">{item}</p>)}
            {draft && <p className="text-muted-foreground">{zh ? '已有草稿的期限和风险边界保留，应用前请再次核对。' : 'The existing draft keeps its period and risk limits. Review them again before applying.'}</p>}
          </div>}
          <p className="text-xs text-muted-foreground">{zh ? '保留原报告或观点引用；保存草稿不会自动交易。' : 'The exact report or opinion remains pinned. Saving a draft does not start trading.'}</p>
        </div>}
        <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={onClose} disabled={save.isPending}>{zh ? '取消' : 'Cancel'}</Button>
          <Button onClick={() => save.mutate()} disabled={!selectionAllowed || !addition.data || addition.isPending || addition.isFetching || addition.isError || save.isPending || addition.data.alreadyAdded || !!draftId && !draft}>
            {save.isPending ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存到草稿' : 'Save to draft')}</Button></div>
      </div>}
  </DialogContent></Dialog>;
}
