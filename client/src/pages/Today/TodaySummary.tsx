import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export default function TodaySummary({ summary, aiAvailable }: { summary: string | null; aiAvailable: boolean }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  return <section className="space-y-2 rounded-xl border bg-card p-5" aria-label={zh ? '今日摘要' : 'Today’s summary'}>
    <h2 className="font-semibold">{zh ? '今日摘要' : 'Today’s summary'}</h2>
    <p className="whitespace-pre-wrap break-words text-sm leading-7">{summary || (aiAvailable
      ? (zh ? '正在准备今日分析，持仓事实已可查看。' : 'Preparing today’s analysis. Portfolio facts are already available.')
      : (zh ? '连接 AI 后可生成分析。' : 'Connect AI to generate an analysis.'))}</p>
    {!aiAvailable && <Link className="text-sm text-primary underline" to="/settings/agents">{zh ? '连接 AI' : 'Connect AI'}</Link>}
  </section>;
}
