import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchStrategyMandate } from '@/api/strategy-mandates';
import { Button } from '@/components/ui/button';

export default function LegacyDecisionPage({ strategyId, versionId }: { strategyId: string; versionId?: string }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const query = useQuery({ queryKey: ['historical-decision', strategyId], queryFn: () => fetchStrategyMandate(strategyId), retry: false });
  return <article className="mx-auto max-w-4xl space-y-4 p-3 sm:p-6"><p className="text-sm text-muted-foreground">{zh ? '当时的决策材料 · 只读' : 'Decision material at the time · Read only'}</p>
    {query.data ? <><h1 className="text-2xl font-semibold">{query.data.title}</h1><p className="text-xs text-muted-foreground">{new Date(query.data.createdAt).toLocaleString(i18n.language)}</p><p className="whitespace-pre-wrap break-words text-sm leading-7">{query.data.objective}</p>{query.data.rules.map(rule => <section key={rule.id} className="space-y-2 rounded-lg border p-4"><h2 className="font-medium">{rule.ticker}</h2><p className="break-words text-sm">{rule.rationale}</p></section>)}{query.data.references.map(ref => <Link key={ref.versionId} className="block text-sm text-primary underline" to={`/analysis/reports/${encodeURIComponent(ref.versionId)}`}>{zh ? '当时保存的研究依据' : 'Research evidence saved at the time'}</Link>)}</>
      : <p role={query.isPending ? 'status' : 'alert'} className="text-sm">{query.isPending ? (zh ? '正在读取原始材料…' : 'Loading original material…') : (zh ? '原始材料不可用，不能用当前分析替代。' : 'Original material is unavailable. Current analysis cannot replace it.')}</p>}
    {versionId && <Link className="block text-primary underline" to={`/analysis/reports/${encodeURIComponent(versionId)}`}>{zh ? '查看链接中的原始依据' : 'Open the original evidence from this link'}</Link>}
    <Button asChild variant="outline"><Link to="/paper">{zh ? '返回 AI 投资' : 'Back to AI investing'}</Link></Button>
  </article>;
}
