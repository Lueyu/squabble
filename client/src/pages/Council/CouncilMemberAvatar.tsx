/**
 * CouncilMemberAvatar.tsx — 议会成员头像：按角色/头像键渲染彩色圆角图标。
 *
 * 职责边界：
 *  - 把成员的 avatar（研究侧重键）与消息 role 映射为 lucide 图标 + 背景色的小方块头像；
 *  - 导出 COUNCIL_AVATAR_ICONS 供其他组件按侧重键取图标。
 * 上下游：
 *  - 上游（路由入口/谁引用）：CouncilChatMessage、CouncilMemberEditor、CouncilMembersSheet、
 *    CouncilTeamEditor。
 *  - 下游（调用哪些 hooks/api/组件）：无 hooks；lucide 图标；cn 类名合并。
 * 关键约定：
 *  - 无 avatar 时的回退：manager→moderator、challenger→risk、其余→value；
 *  - role=user 恒用 UserRound 图标 + 主色底；challenger 用次色底；其余主色浅底。
 */
import {
  ChartNoAxesCombined,
  Coins,
  Globe2,
  MessagesSquare,
  Newspaper,
  ShieldCheck,
  TrendingUp,
  UserRound,
} from 'lucide-react';
import type { CouncilMember, CouncilMessage } from '@shared/council.interface';
import { cn } from '@/lib/utils';

// 研究侧重键 → 图标映射（value/growth/risk/technical/news/macro/moderator）
export const COUNCIL_AVATAR_ICONS = {
  value: Coins,
  growth: TrendingUp,
  risk: ShieldCheck,
  technical: ChartNoAxesCombined,
  news: Newspaper,
  macro: Globe2,
  moderator: MessagesSquare,
};

export default function CouncilMemberAvatar({
  avatar,
  role,
  className,
}: {
  avatar?: CouncilMember['avatar'];
  role: CouncilMessage['role'];
  className?: string;
}) {
  // 图标键：优先用成员 avatar；缺省按角色回退（主持人→moderator、挑战者→risk、其余→value）
  const key =
    avatar ?? (role === 'manager' ? 'moderator' : role === 'challenger' ? 'risk' : 'value');
  // 用户消息恒用 UserRound 人形图标；成员用侧重图标
  const Icon = role === 'user' ? UserRound : COUNCIL_AVATAR_ICONS[key];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-xl',
        role === 'user'
          ? 'bg-primary text-primary-foreground'
          : role === 'challenger'
            ? 'bg-secondary text-secondary-foreground'
            : 'bg-primary/10 text-primary',
        className,
      )}
    >
      <Icon className="size-[18px]" />
    </span>
  );
}
