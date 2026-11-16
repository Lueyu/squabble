/**
 * CouncilChatMessage.tsx — 单条理事会聊天消息：气泡、引用回复、依据、来源与追问按钮。
 *
 * 职责边界：
 *  - 渲染一条 CouncilMessage：系统消息居中弱化；用户消息右对齐主色气泡；成员消息左对齐卡片气泡；
 *  - 气泡内可选：引用回复跳转按钮、模型依据（reasoningSummary）、引用来源折叠列表、
 *    追问按钮组（点击回调 onQuestion）。
 * 上下游：
 *  - 上游（路由入口/谁引用）：CouncilConversation（消息流逐条渲染）。
 *  - 下游（调用哪些 hooks/api/组件）：@/utils/council-state 的 councilMessageDisplayContent；
 *    CouncilMemberAvatar。
 * 关键约定：
 *  - 根节点 id=`council-message-<message.id>` 且 tabIndex=-1——时间线/研究进度"查看回复"
 *    的滚动聚焦目标都锚定在这里，不可改名；
 *  - 采集类（acquisition）与进度类（phase==='progress'）消息直接返回 null，不渲染；
 *  - 成员查找优先按 memberId，无 id 时回退 name+role 匹配；
 *  - 来源 URL 仅接受 http/https（safeSourceUrl 白名单）。
 */
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, CornerUpLeft, FileText, MessageCircle } from 'lucide-react';
import type { CouncilMessage, CouncilSession } from '@shared/council.interface';
import { councilMessageDisplayContent } from '@/utils/council-state';
import CouncilMemberAvatar from './CouncilMemberAvatar';

/** 来源 URL 白名单过滤：只放行 http/https，解析失败或协议不在白名单返回 null。 */
function safeSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** 单条聊天消息（含系统消息与采集/进度占位的短路）。 */
export default function CouncilChatMessage({
  message,
  session,
  onQuestion,
}: {
  message: CouncilMessage;
  session: CouncilSession;
  onQuestion: (question: string) => void;
}) {
  const { t, i18n } = useTranslation();
  // 什么时候走到这里：采集/进度类消息——不属于聊天流，直接不渲染
  if (message.acquisition || message.phase === 'progress') return null;
  // 什么时候走到这里：系统消息——居中灰字，无头像无气泡
  if (message.role === 'system')
    return (
      <article className="mx-auto max-w-xl text-center text-xs leading-6 text-muted-foreground">
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
      </article>
    );
  const isUser = message.role === 'user';
  // 消息归属成员：优先 memberId 精确匹配，回退名字+角色匹配
  const member = session.members?.find((item) =>
    message.memberId
      ? item.id === message.memberId
      : item.name === message.memberName && item.role === message.role,
  );
  // 显示名：用户消息固定"你"，成员消息取消息名或成员名兜底
  const name = isUser ? t('council.you') : message.memberName || member?.name;
  // 被引用的原消息（存在引用 id 时从会话里找）
  const replyTo = message.replyToMessageId
    ? session.messages.find((item) => item.id === message.replyToMessageId)
    : undefined;
  // 全会话证据池：报告按版本倒序展开证据，供引用 id 查找
  const evidence = [...session.reports]
    .sort((left, right) => right.version - left.version)
    .flatMap((report) => report.evidence);
  // 本消息引用的证据：去重 id 后逐个在证据池中定位（可能找不到 → 占位）
  const cited = [...new Set(message.evidenceIds ?? [])].map((id) =>
    evidence.find((item) => item.id === id),
  );
  return (
    <article
      id={`council-message-${message.id}`}
      tabIndex={-1}
      className={`flex items-start gap-2.5 outline-none ${isUser ? 'flex-row-reverse' : ''}`}
    >
      <CouncilMemberAvatar role={message.role} avatar={member?.avatar} className="mt-1" />
      <div
        className={`flex min-w-0 max-w-[calc(100%-3rem)] flex-col sm:max-w-[84%] ${isUser ? 'items-end' : 'items-start'}`}
      >
        {/* 消息头：名字 + 职务（成员消息）+ 时间 */}
        <div
          className={`mb-1.5 flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground ${isUser ? 'justify-end' : ''}`}
        >
          <span className="min-w-0 [overflow-wrap:anywhere] font-medium text-foreground/80">
            {name}
          </span>
          {!isUser && (
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {member?.roleTitle || t(`council.roles.${message.role}`)}
            </span>
          )}
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString(i18n.language, {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </div>
        {/* 气泡：用户主色圆角朝右上；成员卡片圆角朝左上 */}
        <div
          className={`min-w-0 max-w-full rounded-2xl px-4 py-3 shadow-sm ${
            isUser
              ? 'rounded-tr-sm bg-primary/15 text-foreground'
              : 'rounded-tl-sm border border-border/60 bg-card text-card-foreground'
          }`}
        >
          {/* 什么时候走到这里：消息引用了另一条消息——引用条可点击跳回原消息 */}
          {replyTo && (
            <button
              type="button"
              className="mb-3 flex w-full min-w-0 items-start gap-2 rounded-lg border-l-2 border-primary/40 bg-muted/50 px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-muted"
              onClick={() => {
                const target = document.getElementById(`council-message-${replyTo.id}`);
                target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                target?.focus({ preventScroll: true });
              }}
            >
              <CornerUpLeft className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-medium">
                  {t('council.chat.replyTo', {
                    name: replyTo.role === 'user' ? t('council.you') : replyTo.memberName,
                  })}
                </span>
                <span className="mt-1 line-clamp-2 block break-words">
                  {councilMessageDisplayContent(replyTo)}
                </span>
              </span>
            </button>
          )}
          {/* 正文 */}
          <p className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">
            {councilMessageDisplayContent(message)}
          </p>
          {/* 什么时候走到这里：成员消息带模型依据要点——列出依据列表 */}
          {!isUser && Boolean(message.reasoningSummary?.length) && (
            <div className="mt-3 border-t border-border/70 pt-2.5 text-xs">
              <p className="font-medium text-muted-foreground">{t('council.chat.basis')}</p>
              <ul className="mt-2 list-disc space-y-1.5 pl-4 leading-6 text-muted-foreground">
                {message.reasoningSummary?.map((point: string, index: number) => (
                  <li className="break-words" key={index}>
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* 什么时候走到这里：成员消息引用了证据——折叠展示来源卡（找不到的给占位） */}
          {!isUser && cited.length > 0 && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <FileText className="size-3" />
                  {t('council.chat.sources', { count: cited.length })}
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                {cited.map((item, index: number) => {
                  const url = item ? safeSourceUrl(item.sourceUrl) : null;
                  return (
                    <div key={index} className="rounded-lg bg-muted/50 p-2.5 leading-5">
                      {item ? (
                        <>
                          <p className="break-words font-medium">{item.title}</p>
                          <p className="mt-1 line-clamp-4 break-words text-muted-foreground">
                            {item.content}
                          </p>
                          {url && (
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-1 inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              {t('council.report.source')}
                              <ArrowUpRight className="size-3" />
                            </a>
                          )}
                        </>
                      ) : (
                        <p className="text-muted-foreground">
                          {t('council.chat.sourcePending', { index: index + 1 })}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </details>
          )}
        </div>
        {/* 什么时候走到这里：成员消息带追问选项——点击回填到输入框（onQuestion） */}
        {!isUser && Boolean(message.questions?.length) && (
          <div className="mt-2 flex max-w-full flex-col gap-1.5">
            {message.questions?.map((question: string, index: number) => (
              <button
                type="button"
                key={index}
                onClick={() => onQuestion(question)}
                className="flex items-start gap-1.5 rounded-lg border border-border bg-card/70 px-2.5 py-2 text-left text-xs leading-5 text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MessageCircle className="mt-1 size-3 shrink-0" />
                <span className="break-words">{question}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
