import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ReportSource } from '@shared/research-document.interface';
import { fetchResearchDocument, importResearchDocument } from '@/api/research-documents';
import { researchDiscussionPath } from '@/utils/research-documents';
import { Button } from '@/components/ui/button';

/** Archive the displayed source before navigating; never replace an old daily card with a latest deep report. */
export default function ResearchSourceActions({ source, versionId }: { source: ReportSource; versionId?: string | null }) {
  const { i18n } = useTranslation(); const en = i18n.resolvedLanguage?.startsWith('en');
  const navigate = useNavigate(); const [busy, setBusy] = useState(false);
  async function open(discuss: boolean) {
    setBusy(true);
    try {
      const version = versionId ? (await fetchResearchDocument(versionId)).version : await importResearchDocument(source);
      navigate(discuss ? researchDiscussionPath(version) : `/analysis/reports/${version.id}`);
    } catch { toast.error(en ? 'Could not save this report version. Please retry.' : '未能保存此报告版本，请重试。'); }
    finally { setBusy(false); }
  }
  return <div className="flex flex-wrap gap-2">
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void open(false)}>{en ? 'Read saved version' : '查看固定版本'}</Button>
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void open(true)}>{en ? 'Discuss this report' : '讨论这份报告'}</Button>
  </div>;
}
