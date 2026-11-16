/**
 * CouncilResearchProgress.tsx — 研究进展区块：新版事件时间线优先，旧会话回退到消息流解析。
 *
 * 职责边界：
 *  - session.researchEvents 有数据 → 渲染 CouncilResearchTimeline（结构化研究事件）；
 *  - 当前修订没有任何事件 → 在时间线下方追加 LegacyResearchProgress（从旧消息流提取进展行）；
 *  - 完全没有 researchEvents（旧会话）→ 只渲染 LegacyResearchProgress。
 * 上下游：
 *  - 上游（路由入口/谁引用）：CouncilConversation（聊天流中插入研究进展块）。
 *  - 下游（调用哪些 hooks/api/组件）：CouncilResearchTimeline；lucide 图标。
 * 关键约定：
 *  - LegacyResearchProgress 兼容路径：从 messages 里取 acquisition 或 phase==='progress' 的
 *    消息；同一工具步骤可能重复上报，按 memberName+status+detail 去重只保留最新一次；
 *    最多展示最近 4 条；没有进展数据且没有消息时渲染 null。
 */
import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleAlert, Loader2, Search } from 'lucide-react';
import type { CouncilSession } from '@shared/council.interface';
import CouncilResearchTimeline from './CouncilResearchTimeline';

export default function CouncilResearchProgress({ session }: { session: CouncilSession }) {
  // 什么时候走到这里：旧会话没有结构化研究事件——整体走消息流兼容渲染
  if (!session.researchEvents?.length) return <LegacyResearchProgress session={session} />;
  // 当前修订是否已有事件：有则纯时间线，无则时间线+旧版进展块并存
  const hasCurrentEvents = session.researchEvents.some(
    (event) => event.revision === session.revision,
  );
  return (
    <>
      <CouncilResearchTimeline session={session} />
      {/* 什么时候走到这里：当前修订还没有产生任何研究事件——先展示旧版进展块顶住 */}
      {!hasCurrentEvents && (
        <LegacyResearchProgress
          session={{
            ...session,
            messages: session.messages.filter((message) => message.revision === session.revision),
          }}
        />
      )}
    </>
  );
}

/** 旧版研究进展块（兼容无 researchEvents 的会话）：从消息流提取进展并做轮次/成员展示。 */
function LegacyResearchProgress({ session }: { session: CouncilSession }) {
  const { t } = useTranslation();
  // 取进展类消息：带 acquisition 数据或 phase==='progress' 的都算
  const events = session.messages.filter(
    (message) => message.acquisition || message.phase === 'progress',
  );
  // 本地 CLI 可能对同一步骤重复上报。按 成员名\0状态\0详情 去重，
  // 只保留每个公开更新的最新一次，让聊天区显示真实变化而不是重复的"研究中"行。
  const seen = new Set<string>();
  const distinct = [...events]
    .reverse()
    .filter((message) => {
      const key = `${message.memberName}\u0000${message.acquisition?.status ?? ''}\u0000${message.acquisition?.detail ?? message.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .reverse();
  // 当前进行中的成员与最新一条进展
  const progress = session.progress;
  const activeMember = session.members?.find((member) => member.id === progress?.memberId);
  const latest = distinct.at(-1);
  // 什么时候走到这里：既无进行中进度也无历史进展消息——什么都不渲染
  if (!progress && events.length === 0) return null;
  const running = session.status === 'running';
  const phase = progress?.phase ?? 'progress';
  return (
    <section
      aria-label={t('council.progress.history')}
      className="max-w-[84%] rounded-2xl rounded-tl-sm border border-primary/20 bg-card px-4 py-3 text-xs shadow-sm"
    >
      {/* 头部：运行中转圈 + 当前阶段；非运行态显示"历史研究"标签 */}
      <div className="flex items-center gap-2">
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate" role="status">
          {running
            ? activeMember
              ? `${activeMember.name} · ${t(`council.progress.phases.${phase}`)}`
              : t(`council.progress.phases.${phase}`)
            : t('council.progress.history')}
          {/* 什么时候走到这里：运行中但尚无结构化进度——用最新一条进展的数据源名补充 */}
          {!progress && running && latest?.acquisition?.source && ` · ${latest.acquisition.source}`}
        </span>
        {/* 什么时候走到这里：运行中有总轮次——显示 turn/total 计数（封顶防溢出） */}
        {running && progress && progress.totalTurns > 0 && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {t('council.progress.turn', {
              turn: Math.min(progress.turn, progress.totalTurns),
              total: progress.totalTurns,
            })}
          </span>
        )}
      </div>
      {/* 进展明细列表：最多最近 4 条，按状态选图标 */}
      <div className="mt-3 space-y-2 border-t border-border/70 pt-3">
        {/* 什么时候走到这里：还没有任何进展消息——等待占位 */}
        {distinct.length === 0 && (
          <p className="leading-5 text-muted-foreground">{t('council.progress.waiting')}</p>
        )}
        {distinct.slice(-4).map((message) => {
          const acquisition = message.acquisition;
          // failed/partial 用警示图标；started 用搜索图标；其余成功勾
          const failed = acquisition?.status === 'failed' || acquisition?.status === 'partial';
          return (
            <div key={message.id} className="flex items-start gap-2 leading-5">
              {failed ? (
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              ) : acquisition?.status === 'started' ? (
                <Search className="mt-0.5 size-3.5 shrink-0 text-primary" />
              ) : (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" />
              )}
              <p className="min-w-0 break-words">
                <span className="font-medium">{acquisition?.source ?? message.memberName}</span>
                {acquisition && (
                  <span className="ml-2 text-muted-foreground">
                    {t(`council.progress.acquisition.${acquisition.status}`)}
                  </span>
                )}
                <span className="mt-0.5 block text-muted-foreground">
                  {acquisition?.detail || message.content}
                </span>
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
