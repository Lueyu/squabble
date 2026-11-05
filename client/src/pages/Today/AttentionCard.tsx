import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TodayAttention } from '@shared/simple-experience.interface';
import { questionPath } from '@/utils/simple-experience';
import { Button } from '@/components/ui/button';

export default function AttentionCard({ item, date }: { item: TodayAttention; date?: string }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  return <article className="min-w-0 space-y-3 rounded-xl border bg-card p-4 sm:p-5">
    <h3 className="break-words text-base font-semibold">{item.title}</h3>
    <p className="break-words text-sm leading-6 text-muted-foreground">{item.detail}</p>
    <Button variant="outline" size="sm" asChild><Link to={questionPath(item.ticker ? { ticker: item.ticker } : { date })}>{zh ? '问问大家' : 'Ask the team'}</Link></Button>
  </article>;
}
