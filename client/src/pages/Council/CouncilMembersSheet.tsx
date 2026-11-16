/**
 * CouncilMembersSheet.tsx — 历史会话成员快照侧拉面板：只读展示一次议会会话的全部成员。
 *
 * 职责边界：
 *  - 以 Sheet（侧拉抽屉）展示历史 session.members 快照：头像、名称、角色、性格、
 *    研究侧重/说话风格标签、模型路由标签、可折叠的系统提示词；
 *  - 成员为空时提示这是旧版快照；底部"使用该团队"按钮把快照还原为当前配置。
 * 上下游：
 *  - 上游（路由入口/谁引用）：CouncilPage（查看历史会话成员时打开）。
 *  - 下游（调用哪些 hooks/api/组件）：useCouncilModels（memberLabel）；Sheet/Button；
 *    CouncilMemberAvatar。
 * 关键约定：
 *  - 只读快照：不发起任何写请求；模型路由仅经 memberLabel 渲染文本；
 *  - 底部说明按成员执行模式分流：全员本地→本地工具提示；否则按 session.webResearch
 *    分流联网开关说明。
 */
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Users } from 'lucide-react';
import type { CouncilMember, CouncilSession } from '@shared/council.interface';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import CouncilMemberAvatar from './CouncilMemberAvatar';
import { useCouncilModels } from './useCouncilModels';

export default function CouncilMembersSheet({
  session,
  onClose,
  onUseTeam,
}: {
  session: CouncilSession;
  onClose: () => void;
  onUseTeam: () => void;
}) {
  const { t } = useTranslation();
  // 模型路由数据（memberLabel 渲染用）
  const models = useCouncilModels();
  // 快照成员列表（旧快照可能缺 members）
  const members = session.members ?? [];
  return (
    <Sheet
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-[min(440px,96vw)] gap-0 p-0 sm:max-w-[440px]">
        {/* 抽屉头：成员数 + 快照提示 */}
        <SheetHeader className="border-b border-border px-5 py-5 pr-12 text-left">
          <SheetTitle className="flex items-center gap-2">
            <Users className="size-4" />
            {t('council.members.groupTitle', { count: members.length })}
          </SheetTitle>
          <SheetDescription>{t('council.members.snapshotHint')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {/* 什么时候走到这里：旧版本快照没有成员数据——占位提示 */}
          {members.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('council.members.legacySnapshot')}</p>
          )}
          {/* 成员卡片：头像+名称+角色头衔、性格、标签、模型路由、可折叠提示词 */}
          {members.map((member: CouncilMember) => (
            <article key={member.id} className="rounded-xl border border-border p-4">
              <div className="flex items-center gap-3">
                <CouncilMemberAvatar role={member.role} avatar={member.avatar} />
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold">{member.name}</h3>
                  <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {/* 职务：优先 roleTitle，缺省用角色名；manager 追加主持人标记 */}
                    {member.roleTitle || t(`council.roles.${member.role}`)}
                    {member.role === 'manager' && ` · ${t('council.members.moderator')}`}
                  </p>
                </div>
              </div>
              {/* 什么时候走到这里：成员配有性格描述 */}
              {member.personality && (
                <p className="mt-3 break-words text-sm leading-6">{member.personality}</p>
              )}
              {/* 标签行：研究侧重 + 说话风格 */}
              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                {(member.researchFocus ?? []).map((focus) => (
                  <span key={focus} className="rounded-md bg-muted px-2 py-1">
                    {t(`council.members.focuses.${focus}`)}
                  </span>
                ))}
                {member.speakingStyle && (
                  <span className="rounded-md bg-muted px-2 py-1">
                    {t(`council.members.styles.${member.speakingStyle}`)}
                  </span>
                )}
              </div>
              {/* 模型路由一行标签（远程连接或本地智能体） */}
              <p className="mt-3 break-words text-xs text-muted-foreground">
                {models.memberLabel(member)}
              </p>
              {/* 什么时候走到这里：成员配有系统提示词——折叠展开查看 */}
              {member.instructions && (
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    {t('council.members.prompt')}
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap break-words leading-6">
                    {member.instructions}
                  </p>
                </details>
              )}
            </article>
          ))}
          {/* 底部说明：全员本地 / 联网开 / 联网关 三选一 */}
          <p className="text-xs leading-5 text-muted-foreground">
            {t(
              members.every((member) => member.executionMode === 'local')
                ? 'council.localAgents.toolsHint'
                : session.webResearch
                  ? 'council.members.webEnabledSnapshot'
                  : 'council.members.webDisabledSnapshot',
            )}
          </p>
        </div>
        {/* 底部操作：把该快照还原为当前团队配置 */}
        <div className="shrink-0 border-t border-border p-4">
          <Button
            type="button"
            className="h-auto min-h-9 w-full whitespace-normal"
            onClick={onUseTeam}
          >
            <ArrowUpRight className="size-4" />
            {t('council.members.useTeam')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
