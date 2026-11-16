/**
 * @file components/MultiAgent/ConfidenceBadge.tsx
 * @description 将 AI 分析师的置信度渲染为彩色 outline 徽章。
 * 置信度由 multi-agent rating pipeline 产出（AgentConfidence 类型）：
 *   - high   -> 翡翠绿（证据充分、不确定性低）
 *   - medium -> 琥珀色（证据混杂/部分充分）
 *   - low    -> 石板灰（证据薄弱、不确定性高）
 */
import { Badge } from '@/components/ui/badge';
import type { AgentConfidence } from '@shared/api.interface';
import { useTranslation } from 'react-i18next';

interface ConfidenceBadgeProps {
  /** multi-agent rating 赋予的置信度等级 */
  confidence: AgentConfidence;
  /** 徽章尺寸：'sm' 用于紧凑列表/卡片，'md' 用于标题区（默认 'md'） */
  size?: 'sm' | 'md';
}

/** 每个置信度等级对应的翻译 key + Tailwind 配色 class */
const confidenceMap: Record<AgentConfidence, { labelKey: string; className: string }> = {
  high: {
    labelKey: 'report.highConfidence',
    className:
      'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20',
  },
  medium: {
    labelKey: 'report.mediumConfidence',
    className:
      'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/20',
  },
  low: {
    labelKey: 'report.lowConfidence',
    className:
      'bg-slate-500/15 text-slate-700 dark:text-slate-400 border-slate-500/30 hover:bg-slate-500/20',
  },
};

/** 两种受支持尺寸的紧凑 padding/排版预设 */
const sizeClasses: Record<'sm' | 'md', string> = {
  sm: 'text-xs px-2 py-0 h-5',
  md: 'text-sm px-2.5 py-0.5 h-6',
};

/**
 * 渲染一枚以颜色编码置信度等级的 outline Badge。
 * 先从 confidenceMap 查出文案 + 配色组合，再叠加 sizeClasses 的尺寸预设。
 */
function ConfidenceBadge({ confidence, size = 'md' }: ConfidenceBadgeProps) {
  const { t } = useTranslation();
  const { labelKey, className } = confidenceMap[confidence];
  return (
    <Badge variant="outline" className={`${className} ${sizeClasses[size]} font-medium`}>
      {t(labelKey)}
    </Badge>
  );
}

export default ConfidenceBadge;
