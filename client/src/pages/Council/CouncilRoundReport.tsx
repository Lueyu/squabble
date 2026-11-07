import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CouncilReport } from '@shared/council.interface';
import ResearchMarkdown from '@/components/ResearchMarkdown';
import { Button } from '@/components/ui/button';
import { questionPath } from '@/utils/simple-experience';
import { readableResearchText } from '@/utils/research-experience';

/** The persisted report ID is the event identity, so polling/reconnect cannot duplicate a round. */
export default function CouncilRoundReport({report,onAddToStrategy}:{report:CouncilReport;onAddToStrategy?:(versionId:string)=>void}) {
  const {i18n}=useTranslation(),zh=i18n.language.startsWith('zh');
  const content=readableResearchText(report.summary);
  const paragraph=content.split(/\n\s*\n/u)[0],preview=paragraph.length>600?`${paragraph.slice(0,600)}…`:paragraph;
  const corrected=report.coverage?.inputCorrection?.revalidated===true&&report.coverage.independentDeliveriesComplete===true;
  const complete=report.publicationOutcome!=='failed'&&Boolean(content)&&(report.coverage?.complete!==false||corrected);
  return <article data-round-report={report.id} className="min-w-0 space-y-3 rounded-2xl border border-primary/25 bg-primary/5 p-4 sm:p-5">
    <header className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{corrected?(zh?'完整资料已补充核验':'Full context checked after input correction'):complete?(zh?'本轮研究报告':'Research report for this round'):(zh?'本轮已有研究 · 尚未完整':'Saved research · Round incomplete')}</h3><time className="text-xs text-muted-foreground" dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString(i18n.language)}</time></header>
    {corrected&&<p className="text-xs text-muted-foreground">{zh?'原独立研究使用过部分输入；已用完整资料补充核验并汇总，原始交付保留。':'Original independent research used partial inputs. Full context was subsequently checked and summarized; original deliveries are retained.'}</p>}
    {content?<><ResearchMarkdown>{preview}</ResearchMarkdown><details className="min-w-0"><summary className="cursor-pointer text-sm font-medium">{zh?'完整报告':'Full report'}</summary><div className="mt-3"><ResearchMarkdown>{content}</ResearchMarkdown></div></details></>:<p role="status" className="text-sm text-muted-foreground">{zh?'研究已返回，内容整理待核对。原始材料已保留。':'Research returned; formatting needs review. The original material is preserved.'}</p>}
    {report.dissent.length>0&&<details className="text-sm"><summary className="cursor-pointer">{zh?'分歧与待核实':'Disagreements and checks'}</summary><ul className="mt-2 list-disc space-y-1 pl-5">{report.dissent.map((item,index)=><li key={index}>{readableResearchText(item)}</li>)}</ul></details>}
    {complete&&report.researchVersionId&&<div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" asChild><Link to={`/analysis/reports/${encodeURIComponent(report.researchVersionId)}`}>{zh?'打开报告':'Open report'}</Link></Button><Button size="sm" variant="outline" asChild><Link to={questionPath({versionId:report.researchVersionId})}>{zh?'继续讨论':'Continue discussion'}</Link></Button><Button size="sm" onClick={()=>onAddToStrategy?.(report.researchVersionId!)}>{zh?'加入投资策略':'Add to investment strategy'}</Button></div>}
  </article>;
}
