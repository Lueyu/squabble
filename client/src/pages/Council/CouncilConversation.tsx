/**
 * CouncilConversation.tsx — 理事会对话区：消息流（自动吸底/未读提示）+ 底部输入框。
 *
 * 职责边界：
 *  - 渲染会话消息流（CouncilChatMessage 逐条）+ 研究进度 + 运行/错误占位；
 *  - 维护滚动吸底（stickToBottom）：贴底时新消息自动滚动，离开底部出现"最新消息"按钮；
 *  - 底部输入框：发送消息（send），发送成功且会话待启动时自动触发 run；
 *  - 不管理会话本身的状态流转（由上游 useCouncilActions 提供）。
 * 上下游：
 *  - 上游（路由入口/谁引用）：CouncilPage。
 *  - 下游（调用哪些 hooks/api/组件）：useCouncilActions 的 send/run mutation；
 *    @/utils/council-state 的 shouldSendCouncilMessage / shouldStartCouncilAfterMessage；
 *    @/utils/research-events 的 researchTimeline；AgentBuilder/errorMessage；
 *    CouncilChatMessage / CouncilResearchProgress。
 * 关键约定：
 *  - 消息流容器 role="log" aria-live="polite"（读屏增量播报），滚动判定距底 <96px 视为贴底；
 *  - sending/composing 用 ref 承载（避免闭包过期与重渲染竞态）；
 *  - 用户消息达到 30 条封顶：输入框禁用 + 提示 messageLimit；
 *  - 发送后是否自动 run 由 shouldStartCouncilAfterMessage(前状态, 新状态) 决定。
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, Loader2, MessageCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import type { CouncilMessage, CouncilSession } from '@shared/council.interface';
import type { useCouncilActions } from '@/hooks/use-council';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';
import { shouldSendCouncilMessage, shouldStartCouncilAfterMessage } from '@/utils/council-state';
import { researchTimeline } from '@/utils/research-events';
import CouncilChatMessage from './CouncilChatMessage';
import CouncilResearchProgress from './CouncilResearchProgress';

interface CouncilConversationProps {
  session: CouncilSession;
  actions: ReturnType<typeof useCouncilActions>;
  profileChanged: boolean;
}

/** 会话对话区（消息流 + 输入框）。 */
export default function CouncilConversation({
  session,
  actions,
  profileChanged,
}: CouncilConversationProps) {
  const { t } = useTranslation();
  // === 状态声明区 ===
  // 草稿内容 + 是否离开底部有未读
  const [content, setContent] = useState('');
  const [unread, setUnread] = useState(false);
  // 滚动视口 / 输入框引用
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 是否吸底（贴底自动滚动）；是否发送中；是否输入法组合中
  const stickToBottom = useRef(true);
  const sending = useRef(false);
  const composing = useRef(false);
  // === 派生计算区 ===
  // 最新消息 id / 研究时间线游标：作为滚动 useEffect 的触发源
  const lastMessageId = session.messages.at(-1)?.id;
  const researchCursor = researchTimeline(session).cursor;
  // 当前修订是否已有研究事件（决定是否显示通用运行占位）
  const hasCurrentResearchEvents = session.researchEvents?.some(
    (event) => event.revision === session.revision,
  );
  // 用户消息 30 条封顶判定
  const messageLimitReached =
    session.messages.filter((message: CouncilMessage) => message.role === 'user').length >= 30;

  // === 数据获取区（副作用） ===
  // 新消息/状态变化/研究游标推进时：贴底则滚到底部，否则标记未读
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (stickToBottom.current) viewport.scrollTop = viewport.scrollHeight;
    else setUnread(true);
  }, [lastMessageId, session.status, researchCursor]);

  // === 事件处理区 ===
  // 跳到最新消息并恢复吸底
  const jumpToLatest = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    stickToBottom.current = true;
    setUnread(false);
  };

  // 发送：先发消息；成功后按状态机决定是否自动启动理事会
  const submit = async () => {
    // 空草稿 / 发送中 / 达到消息上限：直接忽略
    if (!content.trim() || sending.current || messageLimitReached) return;
    const submittedDraft = content;
    const previousStatus = session.status;
    sending.current = true;
    let saved: CouncilSession;
    try {
      saved = await actions.send.mutateAsync({ id: session.id, content: submittedDraft.trim() });
      // 草稿未被并发修改才清空，并跳到最新
      setContent((current: string) => (current === submittedDraft ? '' : current));
      jumpToLatest();
    } catch (cause) {
      toast.error(errorMessage(cause, t('council.actionFailed')));
      sending.current = false;
      return;
    }
    // 什么时候走到这里：消息已保存且状态机要求自动启动——追加 run 调用（失败不影响已发消息）
    try {
      if (shouldStartCouncilAfterMessage(previousStatus, saved.status))
        await actions.run.mutateAsync(session.id);
    } catch (cause) {
      toast.error(
        `${t('council.messageSavedRunFailed')} ${errorMessage(cause, t('council.actionFailed'))}`,
      );
    } finally {
      sending.current = false;
    }
  };

  return (
    <>
      {/* === 渲染区：消息流 === */}
      <div className="relative flex min-h-0 flex-1 flex-col bg-muted/25">
        <div
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={t('council.conversation')}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-3 py-5 sm:px-6"
          onScroll={() => {
            const viewport = scrollRef.current;
            if (!viewport) return;
            // 距底不足 96px 视为贴底；贴底时清除未读
            stickToBottom.current =
              viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96;
            if (stickToBottom.current) setUnread(false);
          }}
        >
          {/* 房间提示：有成员列出名字，否则通用提示 */}
          <p className="mx-auto max-w-md text-center text-[11px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {session.members?.length
              ? t('council.members.roomHint', {
                  names: session.members.map((member) => member.name).join(' · '),
                })
              : t('council.roomHint')}
          </p>
          {/* 什么时候走到这里：配置文件在会话期间被修改过——顶部提示 */}
          {profileChanged && (
            <p className="mx-auto max-w-xl rounded-lg bg-card p-3 text-center text-xs leading-5 text-muted-foreground">
              {t('council.profileChanged')}
            </p>
          )}
          {/* 什么时候走到这里：无消息也无研究事件——空态占位（启动中/基础引擎/常规三种文案） */}
          {session.messages.length === 0 && !session.researchEvents?.length && (
            <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-12 text-center text-muted-foreground">
              <MessageCircle className="size-8 text-primary/60" />
              <p className="text-sm leading-6">
                {t(
                  session.status === 'running'
                    ? 'council.startingHint'
                    : session.reports.some((report) => report.engine === 'basic')
                      ? 'council.noMessagesBasic'
                      : 'council.noMessages',
                )}
              </p>
            </div>
          )}
          {/* 消息流逐条渲染 */}
          {session.messages.map((message: CouncilMessage) => (
            <CouncilChatMessage
              key={message.id}
              message={message}
              session={session}
              onQuestion={(question: string) => {
                // 追问按钮：问题回填草稿（追加换行，2000 字封顶）并聚焦输入框
                setContent((current) =>
                  current ? `${current}\n${question}`.slice(0, 2000) : question.slice(0, 2000),
                );
                inputRef.current?.focus();
              }}
            />
          ))}
          {/* 研究进度（时间线或旧版占位，内部自行分流） */}
          <CouncilResearchProgress session={session} />
          {/* 什么时候走到这里：运行中且既无 progress 又无当前修订研究事件——通用"运行中"占位 */}
          {session.status === 'running' && !session.progress && !hasCurrentResearchEvents && (
            <div
              role="status"
              className="flex items-center gap-3 px-1 text-xs text-muted-foreground"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
                <Loader2 className="size-4 animate-spin text-primary" />
              </span>
              {t('council.runningHint')}
            </div>
          )}
          {/* 什么时候走到这里：会话出错——错误横幅 + 设置/预算快捷入口 */}
          {session.error && (
            <div
              role="alert"
              className="mx-auto max-w-xl rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs leading-6"
            >
              <p className="whitespace-pre-wrap break-words text-destructive">{session.error}</p>
              <div className="mt-1 flex flex-wrap gap-x-4 text-muted-foreground">
                <Link to="/settings" className="hover:underline">
                  {t('council.apiSettings')}
                </Link>
                <Link to="/settings/budget" className="hover:underline">
                  {t('council.budget.open')}
                </Link>
              </div>
            </div>
          )}
        </div>
        {/* 什么时候走到这里：离开底部且期间有新消息——悬浮"最新消息"按钮 */}
        {unread && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
            onClick={jumpToLatest}
          >
            <ArrowDown className="size-3.5" />
            {t('council.latestMessages')}
          </Button>
        )}
      </div>
      {/* === 渲染区：输入框 === */}
      <form
        className="shrink-0 border-t border-border bg-card p-3 sm:px-5 sm:py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Label htmlFor="council-message" className="sr-only">
          {t('council.composerLabel')}
        </Label>
        <div className="flex items-end gap-2 rounded-xl border border-input bg-background p-1.5 focus-within:ring-2 focus-within:ring-ring/20">
          <Textarea
            ref={inputRef}
            id="council-message"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={2}
            maxLength={2000}
            disabled={messageLimitReached}
            aria-describedby="council-composer-hint"
            className="min-h-[52px] max-h-32 resize-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            placeholder={t('council.composerPlaceholder')}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              // 发送键判定交给 shouldSendCouncilMessage（含输入法组合中保护）
              if (
                shouldSendCouncilMessage({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: composing.current || event.nativeEvent.isComposing,
                  keyCode: event.nativeEvent.keyCode,
                })
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="submit"
                size="icon"
                className="mb-1 shrink-0 rounded-lg"
                aria-label={t('council.send')}
                disabled={!content.trim() || actions.send.isPending || messageLimitReached}
              >
                {actions.send.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('council.send')}</TooltipContent>
          </Tooltip>
        </div>
        {/* 底部提示：上限已达 / 暂停 / 失败 / 常规，四种文案按状态选择 */}
        <div
          id="council-composer-hint"
          className="mt-2 flex items-center justify-between gap-2 text-[11px] leading-4 text-muted-foreground"
        >
          <p>
            {t(
              messageLimitReached
                ? 'council.messageLimit'
                : session.status === 'paused'
                  ? 'council.pausedHint'
                  : session.status === 'failed'
                    ? 'council.failedHint'
                    : 'council.composerHint',
            )}
          </p>
          <span className="hidden shrink-0 sm:inline">{t('council.keyboardHint')}</span>
        </div>
      </form>
    </>
  );
}
