import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Sparkles, NotebookPen } from 'lucide-react';
import type { UserInvestmentStrategy } from '@shared/user-investment-strategy.interface';
import { investmentStrategiesApi } from '@/api/investment-strategies';
import { fetchAiInvestment } from '@/api/ai-investment';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import ResearchMarkdown from '@/components/ResearchMarkdown';
import {
  effectiveInvestmentStatus,
  investmentStatusLabel,
} from '@/utils/ai-investment';
import InvestmentStrategyEditor from './InvestmentStrategyEditor';

export default function InvestmentStrategySection({
  timezone = 'Asia/Shanghai',
}: {
  timezone?: string;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['investment-strategies'],
    queryFn: investmentStrategiesApi.workspace,
    refetchInterval: 15000,
    retry: false,
  });
  const investment = useQuery({
    queryKey: ['ai-investment'],
    queryFn: fetchAiInvestment,
    refetchInterval: 15000,
    retry: false,
  });
  const [editing, setEditing] = useState<{
    item: UserInvestmentStrategy | null;
  } | null>(null);
  const [removing, setRemoving] = useState<{
    item: UserInvestmentStrategy;
    policyRevision?: number;
    requestKey: string;
  } | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const removeLock = useRef(false);
  const [params, setParams] = useSearchParams();
  const requestedId = params.get('investmentStrategyId');
  const opened = useRef<string | null>(null);
  const selected = useQuery({
    queryKey: ['investment-strategy', requestedId],
    queryFn: () => investmentStrategiesApi.get(requestedId!),
    enabled: !!requestedId,
    retry: false,
  });
  const [olderDrafts, setOlderDrafts] = useState<UserInvestmentStrategy[]>([]);
  const [olderHistory, setOlderHistory] = useState<UserInvestmentStrategy[]>(
    [],
  );
  const [draftsCursor, setDraftsCursor] = useState<string | null | undefined>();
  const [historyCursor, setHistoryCursor] = useState<
    string | null | undefined
  >();
  const [paging, setPaging] = useState('');
  const [pageError, setPageError] = useState(false);
  const current = query.data?.current;
  const applied = investment.data?.currentStrategy?.id === current?.id;
  const currentLabel = investmentStatusLabel(
    effectiveInvestmentStatus(investment.data, current),
    zh,
  );
  const drafts = [
    ...new Map(
      [...(query.data?.drafts ?? []), ...olderDrafts].map((s) => [s.id, s]),
    ).values(),
  ];
  const history = [
    ...new Map(
      [...(query.data?.history ?? []), ...olderHistory]
        .filter((s) => s.id !== current?.id)
        .map((s) => [s.id, s]),
    ).values(),
  ];
  const nextDraft =
    draftsCursor === undefined ? query.data?.draftsCursor : draftsCursor;
  const nextHistory =
    historyCursor === undefined ? query.data?.historyCursor : historyCursor;

  // Resolve both the linked draft and the current strategy before mounting the
  // editor, whose confirmation is bound to that opening workspace snapshot.
  useEffect(() => {
    if (!requestedId) {
      opened.current = null;
      return;
    }
    if (
      query.data &&
      !query.isError &&
      !query.isPending &&
      selected.data &&
      opened.current !== requestedId
    ) {
      opened.current = requestedId;
      setEditing({ item: selected.data });
    }
  }, [requestedId, selected.data, query.data, query.isError, query.isPending]);
  const closeEditor = () => {
    setEditing(null);
    if (requestedId) {
      const next = new URLSearchParams(params);
      next.delete('investmentStrategyId');
      setParams(next, { replace: true });
    }
  };
  const changed = () => {
    for (const key of [
      'investment-strategies',
      'investment-strategy',
      'ai-investment',
      'channel',
    ])
      void client.invalidateQueries({ queryKey: [key] });
  };
  const beginRemoval = (item: UserInvestmentStrategy) => {
    setRemoveError('');
    setRemoving({
      item,
      requestKey: crypto.randomUUID(),
      ...(item.status === 'confirmed'
        ? { policyRevision: investment.data?.policy?.revision }
        : {}),
    });
  };
  const remove = async () => {
    if (!removing || removeLock.current) return;
    removeLock.current = true;
    setRemoveBusy(true);
    setRemoveError('');
    try {
      if (removing.item.status === 'draft')
        await investmentStrategiesApi.deleteDraft(
          removing.item.id,
          removing.item.revision,
        );
      else {
        if (!removing.policyRevision)
          throw Error('Simulation state unavailable');
        await investmentStrategiesApi.removeCurrent({
          strategyId: removing.item.id,
          expectedRevision: removing.item.revision,
          expectedPolicyRevision: removing.policyRevision,
          requestKey: removing.requestKey,
        });
      }
      // A deleted row may have been the pagination anchor; restart from a fresh workspace page.
      setOlderDrafts([]);
      setDraftsCursor(undefined);
      setPageError(false);
      if (requestedId === removing.item.id) closeEditor();
      setRemoving(null);
      changed();
    } catch {
      setRemoveError(
        zh
          ? '尚未确认删除。请重新读取策略后再试；重复请求不会重复处理。'
          : 'Removal is unconfirmed. Reload the strategy and retry; repeated requests are safe.',
      );
    } finally {
      removeLock.current = false;
      setRemoveBusy(false);
    }
  };
  const more = async (kind: 'drafts' | 'history') => {
    const cursor = kind === 'drafts' ? nextDraft : nextHistory;
    if (!cursor || paging) return;
    setPaging(kind);
    setPageError(false);
    try {
      const page =
        kind === 'drafts'
          ? await investmentStrategiesApi.drafts(cursor)
          : await investmentStrategiesApi.history(cursor);
      if (kind === 'drafts') {
        setOlderDrafts((d) => [...d, ...page.items]);
        setDraftsCursor(page.nextCursor);
      } else {
        setOlderHistory((h) => [...h, ...page.items]);
        setHistoryCursor(page.nextCursor);
      }
    } catch {
      setPageError(true);
    } finally {
      setPaging('');
    }
  };
  return (
    <section
      id="investment-strategy"
      className="min-w-0 scroll-mt-6 space-y-4 rounded-2xl border bg-card p-4 sm:p-6"
      aria-label={zh ? '我的投资策略' : 'Your investment strategy'}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="rounded-2xl bg-primary/10 p-3 text-primary">
            <NotebookPen size={21} />
          </span>
          <div>
            <h2 className="text-lg font-semibold">
              {zh ? '我的投资策略' : 'Your investment strategy'}
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {zh
                ? '一份总策略，写下你的想法，让股友协助核对和执行。'
                : 'One total strategy. Write your intent and let your stock friends help review and execute it.'}
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setEditing({ item: current ?? null })}>
          {current
            ? zh
              ? '编辑策略'
              : 'Edit strategy'
            : zh
              ? '自己写策略'
              : 'Write a strategy'}
        </Button>
      </header>
      {query.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          {zh ? '正在读取策略…' : 'Loading your strategy…'}
        </p>
      )}
      {query.isError && (
        <div role="alert" className="space-y-2 text-sm">
          <p>
            {zh
              ? '策略暂时无法读取，已保存的内容仍然保留。'
              : 'Your strategy is temporarily unavailable. Saved content is retained.'}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            {zh ? '重新读取' : 'Reload'}
          </Button>
        </div>
      )}
      {requestedId && selected.isError && (
        <p role="alert" className="text-sm text-muted-foreground">
          {zh
            ? '链接中的策略暂时不可读取，可从下方历史重新选择。'
            : 'The linked strategy is unavailable. Choose one from history below.'}
        </p>
      )}
      {current ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-emerald-700 dark:text-emerald-300">
              {currentLabel}
            </span>
            <span className="rounded-full bg-muted px-3 py-1 text-muted-foreground">
              {new Date(current.confirmedAt).toLocaleString(i18n.language)}
            </span>
          </div>
          <h3 className="font-medium">{current.content.title}</h3>
          {current.content.body && (
            <ResearchMarkdown>{current.content.body}</ResearchMarkdown>
          )}
          <ul className="space-y-2">
            {current.content.entries.slice(0, 3).map((entry) => (
              <li
                key={entry.id}
                className="rounded-xl bg-muted/30 p-3 text-sm leading-6 [overflow-wrap:anywhere]"
              >
                {entry.text.length > 500
                  ? `${entry.text.slice(0, 500)}…`
                  : entry.text}
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditing({ item: current })}
          >
            {zh ? '查看全文与执行说明' : 'Read strategy and execution details'}
          </Button>
          {applied && investment.data?.policy && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => beginRemoval(current)}
            >
              {zh ? '停止并移除' : 'Stop and remove'}
            </Button>
          )}
        </div>
      ) : (
        !query.isPending &&
        !query.isError && (
          <div className="rounded-xl bg-primary/5 p-4">
            <p className="text-sm leading-7">
              {zh
                ? '先写一条想法，或把研究结论保存到这里。保存草稿后可以随时修改，应用到模拟盘才会开始执行。'
                : 'Start with an idea or bring a finding from your research. Drafts stay editable; execution starts only after applying one to a simulated account.'}
            </p>
            <Button asChild variant="ghost" size="sm" className="mt-2">
              <Link to="/council">
                <Sparkles size={14} />
                {zh ? '到频道核对事实' : 'Check a fact in the channel'}
              </Link>
            </Button>
          </div>
        )
      )}
      {!!drafts.length && (
        <div className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">
            {zh ? '草稿，尚未应用' : 'Drafts, not applied'}
          </h3>
          {drafts.map((draft) => (
            <div
              key={draft.id}
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium">
                  {draft.content.title}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {draft.sources.length
                    ? `${draft.sources.length} ${zh ? '处讨论来源' : 'discussion sources'}`
                    : zh
                      ? '自己写的策略'
                      : 'Your own strategy'}{' '}
                  · {new Date(draft.updatedAt).toLocaleString(i18n.language)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing({ item: draft })}
                >
                  {zh ? '继续编辑' : 'Continue editing'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => beginRemoval(draft)}
                >
                  {zh ? '删除草稿' : 'Delete draft'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {nextDraft && (
        <Button
          size="sm"
          variant="ghost"
          disabled={!!paging}
          onClick={() => void more('drafts')}
        >
          {zh ? '加载更早的草稿' : 'Load earlier drafts'}
        </Button>
      )}
      {(!!history.length || nextHistory) && (
        <details className="border-t pt-4">
          <summary className="cursor-pointer text-sm font-medium">
            {zh
              ? `已确认历史 · ${history.length}${nextHistory ? '+' : ''}`
              : `Confirmed history · ${history.length}${nextHistory ? '+' : ''}`}
          </summary>
          <ul className="mt-3 space-y-2">
            {history.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span>
                  {item.content.title} ·{' '}
                  {new Date(item.confirmedAt ?? item.updatedAt).toLocaleString(
                    i18n.language,
                  )}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing({ item })}
                >
                  {zh ? '查看与另存草稿' : 'Read or copy as draft'}
                </Button>
              </li>
            ))}
          </ul>
          {nextHistory && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!paging}
              onClick={() => void more('history')}
            >
              {zh ? '加载更早的策略' : 'Load earlier strategies'}
            </Button>
          )}
        </details>
      )}
      {pageError && (
        <p role="alert" className="text-sm text-muted-foreground">
          {zh
            ? '更早记录暂时无法读取，可以重试。'
            : 'Earlier records could not be loaded. You can retry.'}
        </p>
      )}
      {editing && (
        <InvestmentStrategyEditor
          key={editing.item?.id ?? 'new'}
          item={editing.item}
          currentId={current?.id ?? null}
          timezone={timezone}
          investment={investment.data}
          onClose={closeEditor}
          onChanged={changed}
        />
      )}
      {removing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !removeBusy) setRemoving(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {removing.item.status === 'draft'
                  ? zh
                    ? '删除这份草稿？'
                    : 'Delete this draft?'
                  : zh
                    ? '停止并移除当前策略？'
                    : 'Stop and remove the current strategy?'}
              </DialogTitle>
              <DialogDescription>
                {removing.item.status === 'draft'
                  ? zh
                    ? '这份草稿将从列表移除，当前已应用策略保持不变。'
                    : 'This draft will leave your list. The applied strategy stays unchanged.'
                  : zh
                    ? '全部自动买卖将停止，包括自动止损；当前策略移除后只观察。已确认策略和成交历史保留，可随时查看。'
                    : 'All automatic trades stop, including stop-loss. The account will observe after removal. Confirmed strategy and trade history are retained.'}
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm font-medium">{removing.item.content.title}</p>
            {removeError && (
              <p role="alert" className="text-sm text-destructive">
                {removeError}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={removeBusy}
                onClick={() => setRemoving(null)}
              >
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button
                variant="destructive"
                disabled={removeBusy}
                onClick={() => void remove()}
              >
                {removeBusy
                  ? zh
                    ? '正在处理…'
                    : 'Working…'
                  : removing.item.status === 'draft'
                    ? zh
                      ? '确认删除'
                      : 'Confirm deletion'
                    : zh
                      ? '确认停止并移除'
                      : 'Confirm stop and remove'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
