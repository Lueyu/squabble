import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { readableResearchText } from '@/utils/research-experience';

export default function TodaySummary({ summary, aiAvailable, factsOnly = false }: { summary: string | null; aiAvailable: boolean; factsOnly?: boolean }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const text = readableResearchText(summary);
  return <section className="min-w-0 space-y-2" aria-label={zh ? '分析摘要' : 'Analysis summary'}>
    <p className="whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{text || (factsOnly
      ? (zh ? '持仓事实已保存，AI 股友还没有完成这份研究。' : 'Portfolio facts are saved. Your AI stock friends have not completed this research yet.')
      : aiAvailable ? (zh ? '持仓事实已可查看，开始分析后一起看看风险与机会。' : 'Your portfolio facts are ready. Start an analysis to explore risks and opportunities.')
      : (zh ? '持仓事实已可查看，连接 AI 股友后可以开始分析。' : 'Portfolio facts are ready. Connect an AI stock friend to start an analysis.'))}</p>
    {!aiAvailable && <Link className="inline-block text-sm text-primary underline" to="/settings/agents">{zh ? '连接 AI' : 'Connect AI'}</Link>}
  </section>;
}
