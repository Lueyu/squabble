/**
 * @file components/MultiAgent/RatingBadge.tsx
 * @description 将分析师评级渲染为彩色 outline 徽章，并携带品牌吉祥物：
 * 看涨评级带牛形图标（双角）、看跌评级带熊形图标（圆耳）——
 * 它们是 Squabble logo 气泡的微缩版。
 *
 * 配色语义沿用卖方评级惯例：
 *   - Strong Buy / Buy   -> 牛市绿（看涨）
 *   - Hold               -> 蓝色（中性）
 *   - Sell / Strong Sell -> 熊市红（看跌）
 *   - Watch              -> 石板灰（暂无可操作结论）
 */
import { Badge } from '@/components/ui/badge';
import type { AgentRating } from '@shared/api.interface';

interface RatingBadgeProps {
  /** multi-agent pipeline 出具的评级，如 'Strong Buy' | 'Hold' ... */
  rating: AgentRating;
  /** 徽章尺寸：'sm' 用于紧凑布局，'md' 用于标题区（默认 'md'） */
  size?: 'sm' | 'md';
}

/** 每个评级对应的 Tailwind 配色；越强的结论使用越强/接近实心的强调 */
const ratingStyles: Record<AgentRating, string> = {
  'Strong Buy':
    'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20',
  Buy: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/15',
  Hold: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30 hover:bg-blue-500/20',
  Sell: 'bg-rose-500/10 text-rose-600 dark:text-rose-500 border-rose-500/20 hover:bg-rose-500/15',
  'Strong Sell':
    'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30 hover:bg-rose-500/20',
  Watch:
    'bg-slate-500/15 text-slate-700 dark:text-slate-400 border-slate-500/30 hover:bg-slate-500/20',
};

/** 两种受支持尺寸的紧凑 padding/排版预设 */
const sizeClasses: Record<'sm' | 'md', string> = {
  sm: 'text-xs px-2 py-0 h-5 gap-1',
  md: 'text-sm px-2.5 py-0.5 h-6 gap-1.5',
};

/** 牛形图标：logo 中牛气泡的微缩版 —— 双角加圆角头部。 */
function BullGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M4.4 4.2 L2.9 1.2 L6.4 3 Z" />
      <path d="M11.6 4.2 L13.1 1.2 L9.6 3 Z" />
      <rect x="1.6" y="3.6" width="12.8" height="9.2" rx="3.6" />
    </svg>
  );
}

/** 熊形图标：logo 中熊气泡的微缩版 —— 圆耳加圆角头部。 */
function BearGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <circle cx="4.4" cy="4" r="1.9" />
      <circle cx="11.6" cy="4" r="1.9" />
      <rect x="1.6" y="3.6" width="12.8" height="9.2" rx="3.6" />
    </svg>
  );
}

/** 判断某个评级应搭配哪个吉祥物（没有则返回 null）。 */
function ratingGlyph(rating: AgentRating) {
  if (rating === 'Buy' || rating === 'Strong Buy') return <BullGlyph />;
  if (rating === 'Sell' || rating === 'Strong Sell') return <BearGlyph />;
  return null;
}

/** 渲染一枚按 ratingStyles 着色的 outline Badge；内容为吉祥物 + 原始评级字符串。 */
function RatingBadge({ rating, size = 'md' }: RatingBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={`${ratingStyles[rating]} ${sizeClasses[size]} inline-flex items-center font-medium`}
    >
      {ratingGlyph(rating)}
      {rating}
    </Badge>
  );
}

export default RatingBadge;
