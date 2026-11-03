import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { CouncilMessage } from '@shared/council.interface';
import { councilCopyText } from '@/utils/council-message-text';

export default function CouncilMessageActions({ message, onReply }: {
  message: CouncilMessage; onReply?: (message: CouncilMessage) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(councilCopyText(message)); setCopied(true); }
    catch { toast.error(t('council.studio.copyFailed')); }
  };
  return <div className="council-message-actions">
    {onReply && <button type="button" onClick={() => onReply(message)}><MessageCircle />{t('council.studio.followUp')}</button>}
    <button type="button" onClick={() => void copy()} onBlur={() => setCopied(false)} aria-label={t('council.studio.copy')}>
      {copied ? <Check /> : <Copy />}<span role="status">{t(copied ? 'council.studio.copied' : 'council.studio.copy')}</span>
    </button>
  </div>;
}
