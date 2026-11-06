import { useTranslation } from 'react-i18next';
import type { CouncilMessage } from '@shared/council.interface';
import { councilMessageDisplayContent } from '@/utils/council-state';
import ResearchMarkdown from '@/components/ResearchMarkdown';

const normalized = (value: string): string => value.replace(/\s+/gu, ' ').trim();

function additionalRationale(message: CouncilMessage, displayed: string): string[] {
  const seen = new Set<string>();
  return (message.reasoningSummary ?? []).filter((point: string) => {
    const value = normalized(point);
    if (!value || normalized(displayed).includes(value) || seen.has(value)) return false;
    seen.add(value); return true;
  });
}

export default function CouncilResponseBody({ message, compact = false }: { message: CouncilMessage; compact?: boolean }) {
  const { t } = useTranslation();
  const content = councilMessageDisplayContent(message);
  const response = message.response;
  if (!response && compact && message.role !== 'user' && content.length > 600) {
    const paragraph = content.split(/\n\s*\n/u)[0];
    const preview = paragraph.length <= 600 ? paragraph : `${paragraph.slice(0, 600)}…`;
    return <div className="min-w-0 space-y-3"><p className="whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{preview}</p><details className="min-w-0 text-sm"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t('council.chat.details')}</summary><div className="mt-3 min-w-0"><ResearchMarkdown>{content}</ResearchMarkdown></div></details></div>;
  }
  const points = (key: string, values: string[]) => values.length > 0 && <section>
    <h4 className="text-xs font-semibold text-foreground/80">{t(`council.chat.${key}`)}</h4>
    <ul className="mt-1.5 list-disc space-y-1.5 pl-4 text-sm leading-7">
      {values.map((point: string, index: number) => <li key={index} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{point}</li>)}
    </ul>
  </section>;
  if (response) {
    const rendered = [response.thesis, ...response.evidencePoints, ...response.risks, ...response.nextChecks, response.details]
      .filter(Boolean).join('\n\n');
    const extraContent = normalized(content) && !normalized(rendered).includes(normalized(content)) ? content : undefined;
    return <div className="space-y-4">
      <p className="whitespace-pre-wrap text-sm font-medium leading-7 [overflow-wrap:anywhere]">{response.thesis}</p>
      {points('evidencePoints', [...response.evidencePoints, ...additionalRationale(message, `${rendered}\n${content}`)])}
      {points('risks', response.risks)}
      {points('nextChecks', response.nextChecks)}
      {(response.details || extraContent) && <details className="border-t border-border/70 pt-3 text-xs">
        <summary className="cursor-pointer font-medium text-muted-foreground">{t('council.chat.details')}</summary>
        <div className="mt-3 space-y-4 whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">
          {response.details && (compact ? <ResearchMarkdown>{response.details}</ResearchMarkdown> : <p>{response.details}</p>)}
          {extraContent && (compact ? <ResearchMarkdown>{extraContent}</ResearchMarkdown> : <p>{extraContent}</p>)}
        </div>
      </details>}
    </div>;
  }
  return <div className="space-y-4">
    {compact && message.role !== 'user' ? <ResearchMarkdown>{content}</ResearchMarkdown> : <p className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">{content}</p>}
    {message.role !== 'user' && points('basis', additionalRationale(message, content))}
  </div>;
}
