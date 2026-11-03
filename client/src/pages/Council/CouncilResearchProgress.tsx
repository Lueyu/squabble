import { useTranslation } from 'react-i18next';
import type { CouncilMessage } from '@shared/council.interface';

/** Legacy activity without task identity stays in its original conversation position. */
export default function CouncilResearchProgress({ message }: { message: CouncilMessage }) {
  const { t } = useTranslation();
  const acquisition = message.acquisition;
  const failed = acquisition?.status === 'failed' || acquisition?.status === 'partial';
  return <details className="max-w-[84%] rounded-xl border border-border/60 bg-card px-4 py-3 text-xs">
    <summary className={`cursor-pointer ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
      {t('council.progress.history')} · {message.memberName}
      {acquisition && <span className="ml-2">{t(`council.progress.acquisition.${acquisition.status}`)}</span>}
    </summary>
    <p className="mt-3 whitespace-pre-wrap leading-6 text-muted-foreground [overflow-wrap:anywhere]">
      {acquisition?.detail || message.content}
    </p>
  </details>;
}
