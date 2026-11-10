import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { History, Plus } from 'lucide-react';
import { fetchResearchConversations } from '@/api/research-conversations';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { createRequestIntent } from '@/utils/simple-experience';
import ResearchHistoryList from '@/features/research-workspace/ResearchHistoryList';
import type { ResearchWorkspaceRequest } from '@/features/research-workspace/research-workspace-state';
import ArchivedCouncilPage from '@/pages/Council/ArchivedCouncilPage';
import '@/pages/Council/council-chat.css';
import '@/features/research-workspace/research-workspace.css';

export default function ResearchWorkspacePage() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('session') || params.get('sessionId');
  const draftKey = selectedId || 'new';
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({
    new: (params.get('question') || '').slice(0, 2000),
  }));
  const requests = useRef(new Map<string, ResearchWorkspaceRequest>());
  if (!requests.current.has(draftKey))
    requests.current.set(draftKey, {
      intent: createRequestIntent(() => crypto.randomUUID()),
    });
  const [historyOpen, setHistoryOpen] = useState(false);
  const sessions = useQuery({
    queryKey: ['research-conversations'],
    queryFn: fetchResearchConversations,
    refetchInterval: 15_000,
  });
  const select = (id: string | null) => {
    setParams(id ? { session: id } : {});
    setHistoryOpen(false);
  };
  const history = (
    <ResearchHistoryList
      sessions={sessions.data ?? []}
      selectedId={selectedId}
      pending={sessions.isPending}
      error={sessions.isError}
      onRetry={() => void sessions.refetch()}
      onSelect={select}
      onDeleted={(id) => {
        if (selectedRef.current === id) select(null);
        requests.current.delete(id);
        setDrafts((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }}
    />
  );

  return (
    <section
      className="research-workspace-shell"
      aria-label={zh ? '研究室' : 'Research room'}
    >
      <aside
        className="research-workspace-sidebar"
        aria-label={zh ? '研究历史' : 'Research history'}
      >
        <header>
          <h1>{zh ? '研究室' : 'Research room'}</h1>
          <Button
            size="sm"
            variant="outline"
            onClick={() => select(null)}
            aria-label={zh ? '新研究' : 'New research'}
          >
            <Plus size={15} />
            {zh ? '新研究' : 'New research'}
          </Button>
        </header>
        <h2>{zh ? '历史研究' : 'Research history'}</h2>
        {history}
      </aside>
      <div className="research-workspace-main">
        <div className="research-workspace-mobile-tools">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setHistoryOpen(true)}
          >
            <History size={15} />
            {zh ? '研究历史' : 'Research history'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => select(null)}
            aria-label={zh ? '新研究' : 'New research'}
          >
            <Plus size={15} />
            {zh ? '新研究' : 'New research'}
          </Button>
        </div>
        <ArchivedCouncilPage
          workspace={{
            draft: drafts[draftKey] ?? '',
            request: requests.current.get(draftKey)!,
            onDraftChange: (value) =>
              setDrafts((previous) => ({ ...previous, [draftKey]: value })),
            onAccepted: (id) => {
              setDrafts((previous) => ({ ...previous, [draftKey]: '' }));
              if (selectedRef.current === selectedId)
                setParams({ session: id });
            },
          }}
        />
      </div>
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent
          side="left"
          className="research-workspace-drawer"
          closeLabel={zh ? '关闭研究历史' : 'Close research history'}
        >
          <SheetHeader>
            <SheetTitle>{zh ? '研究历史' : 'Research history'}</SheetTitle>
            <SheetDescription>
              {zh
                ? '在这里选择任务，原始研究会在对话区打开。'
                : 'Choose a task to open its original research in the conversation area.'}
            </SheetDescription>
          </SheetHeader>
          {history}
        </SheetContent>
      </Sheet>
    </section>
  );
}
