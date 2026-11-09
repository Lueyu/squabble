import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import ResearchMarkdown from '@/components/ResearchMarkdown';
import { fetchResearchDocument } from '@/api/research-documents';
import { Button } from '@/components/ui/button';
import { questionPath } from '@/utils/simple-experience';
import {useState} from 'react';
import type {StrategySourceInput} from '@shared/user-investment-strategy.interface';
import InvestmentStrategySourceDialog from '@/features/investment-strategies/InvestmentStrategySourceDialog';
import {readableResearchSection,researchSectionsRecord,researchReferences} from '@shared/research-reading';
import ReportExecutionPlan from '@/components/ReportExecutionPlan';
import { simulationReviewSections } from '@shared/simulation-review-reading';

/** Always reads the requested immutable document. No lookup or redirect to current research. */
export default function SimpleReportReader({ versionId }: { versionId: string }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [strategySource,setStrategySource]=useState<StrategySourceInput|null>(null);
  const query = useQuery({ queryKey: ['research-document', versionId], queryFn: () => fetchResearchDocument(versionId), enabled: Boolean(versionId) });
  if (query.isPending) return <p role="status" className="p-6">{zh ? '正在读取原始材料…' : 'Loading original material…'}</p>;
  if (!query.data) return <div role="alert" className="space-y-3 p-6"><p>{zh ? '原始材料不可用，不能用当前分析替代。' : 'Original material is unavailable. Current analysis cannot replace it.'}</p><Button onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>;
  const { version } = query.data;
  const archived=researchSectionsRecord(version.sections);
  const references=researchReferences(archived);
  const simulationSections=simulationReviewSections(version,i18n.language);
  const sections=simulationSections??version.sections.filter(section=>!(version.snapshot?.executionPlan&&section.id==='execution-strategy')).map(section=>({...section,content:readableResearchSection(section)})).filter(section=>section.content);
  return <article className="mx-auto w-full max-w-4xl space-y-5 p-3 pb-12 sm:p-6"><p className="text-sm text-muted-foreground">{simulationSections ? (zh?'模拟盘账本复盘 · 只读':'Simulation ledger review · Read only') : (zh ? '当时的研究依据 · 只读' : 'Research at the time · Read only')}</p>
    {simulationSections && <div className="space-y-2 rounded-xl bg-muted/40 p-3 text-sm"><p>{zh?'这里记录模拟账户的估值和执行情况。持仓判断、事件与后续关注请查看每日研究。':'This records simulated account valuations and execution. Holdings findings are in the daily research reports.'}</p><Link className="text-primary underline" to="/analysis#report-history">{zh?'查看持仓研究':'View holdings research'}</Link></div>}
    <h1 className="break-words text-2xl font-semibold">{version.title}</h1><p className="text-sm text-muted-foreground">{new Date(typeof version.snapshot?.generatedAt === "string" ? version.snapshot.generatedAt : version.createdAt).toLocaleString(i18n.language)}{version.dataAsOf && <> · {zh ? '数据截至：' : 'Data as of: '}{version.dataAsOf}</>}</p>
    {(version.status === 'revoked' || version.sourceStatus === 'missing') && <p role="alert" className="rounded-lg border p-3 text-sm">{zh ? '原始材料保留，但部分依据已撤回或不可用。' : 'The original material is preserved; some evidence has been withdrawn or is unavailable.'}</p>}
    <Button asChild variant="outline"><Link to={questionPath({ versionId })}>{zh ? '问问当时的依据' : 'Ask about this evidence'}</Link></Button>
    {sections.length>0&&version.status!=='revoked'&&<Button variant="outline" onClick={()=>setStrategySource({kind:'report',versionId})}>{zh?'选择其他报告内容':'Choose other report content'}</Button>}
    {sections.length?sections.map(section => <section id={section.id} key={section.id} className="space-y-3 rounded-xl border bg-card p-4 sm:p-6"><h2 className="text-lg font-semibold">{section.title}</h2><ResearchMarkdown>{section.content}</ResearchMarkdown></section>):<p role="status">{zh?'研究已返回，内容整理待核对。原始材料已保留，不会重新调用模型。':'Research returned; formatting needs review. The original material is preserved; no model call is made.'}</p>}
    {references&&<ResearchMarkdown>{references}</ResearchMarkdown>}
    {!simulationSections&&<ReportExecutionPlan key={versionId} versionId={versionId} onAddToStrategy={setStrategySource}/>}
    <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">{zh ? '当时的固定资料' : 'Frozen inputs at the time'}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{version.snapshot ? JSON.stringify(version.snapshot, null, 2) : (zh ? '历史快照未知' : 'Historical snapshot unknown')}</pre></details>
    {!sections.length&&<div className="space-y-3"><Button variant="outline" onClick={()=>void query.refetch()}>{zh?'重新整理已有结果':'Reformat saved result'}</Button><details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm">{zh?'原始研究文本':'Original research text'}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{version.content}</pre></details></div>}
    <InvestmentStrategySourceDialog source={strategySource} onClose={()=>setStrategySource(null)}/>
  </article>;
}
