import { useTranslation } from 'react-i18next';
import type { DebateOutcome } from '@shared/simple-conversation.interface';
import ResearchMarkdown from '@/components/ResearchMarkdown';
import {readableResearchText} from '@/utils/research-experience';

export default function DebateSummary({ outcome, members, mode }: { outcome: DebateOutcome; members: Array<{ id: string; name: string }>; mode: string }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const action = { observe: zh ? '继续观察' : 'Keep observing', research_more: zh ? '补充资料后再判断' : 'Gather more evidence', consider_action: zh ? '考虑下一步行动' : 'Consider the next action' };
  return <section className="space-y-3 rounded-xl border bg-card p-4 text-sm" aria-label={zh ? '讨论小结' : 'Discussion summary'}>
    <h2 className="font-semibold">{zh ? '讨论小结' : 'Discussion summary'}{mode === 'single' && <span className="ml-2 text-xs font-normal text-muted-foreground">{zh ? '单人分析' : 'Single-source analysis'}</span>}</h2>
    {outcome.summary&&<ResearchMarkdown>{readableResearchText(outcome.summary)}</ResearchMarkdown>}
    {mode === 'single' && <p className="text-xs text-muted-foreground">{zh ? '仅一位完成，尚未经其他股友交叉检查。' : 'Only one member completed. Other members have not cross-checked this view.'}</p>}
    <div><h3 className="font-medium">{zh ? '已经确认什么' : 'What is established'}</h3><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{outcome.confirmed.join('\n') || (zh ? '尚无足够证据确认。' : 'No finding has enough evidence yet.')}</p></div>
    <div><h3 className="font-medium">{zh ? '还在争论什么' : 'What remains disputed'}</h3>{outcome.disagreements.length ? outcome.disagreements.map((item, i) => <div key={`${item.claimId}:${i}`} className="mt-2 space-y-1 rounded-lg bg-muted/50 p-3"><p className="break-words font-medium">{item.claimId}</p>{item.positions.map((position, n) => <p key={`${position.memberId}:${n}`} className="break-words text-muted-foreground">{members.find(member => member.id === position.memberId)?.name || position.memberId}: {position.view}</p>)}</div>)
      : <p className="mt-1 text-muted-foreground">{zh ? '没有记录到实质分歧。' : 'No substantive disagreement was recorded.'}</p>}</div>
    <div><h3 className="font-medium">{zh ? '目前怎么做' : 'What to do now'}</h3><p className="mt-1 text-muted-foreground">{action[outcome.currentAction]}</p></div>
    <div><h3 className="font-medium">{zh ? '什么信息会改变判断' : 'What could change this view'}</h3><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{outcome.nextEvidence.join('\n') || (zh ? '等待可验证的新证据。' : 'Wait for new verifiable evidence.')}</p></div>
  </section>;
}
