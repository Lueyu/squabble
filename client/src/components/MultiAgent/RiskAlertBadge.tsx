/**
 * @file components/MultiAgent/RiskAlertBadge.tsx
 * @description 将风控闸门（risk gate）检查结果汇总为单枚徽章。
 * 风控闸门在评级定稿前运行一组规则；规则分 'hard'（阻断性）与 'soft'（提示性）。
 * 展示优先级：
 *   1. 任一 HARD 规则未通过 -> 玫瑰红徽章：存在阻断性违规
 *   2. 任一 SOFT 规则未通过 -> 琥珀色徽章：有警告但不阻断
 *   3. 全部通过             -> 翡翠绿徽章：风控闸门通过
 */
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type { RiskGateResult } from '@shared/api.interface';
import { useTranslation } from 'react-i18next';

interface RiskAlertBadgeProps {
  /** 当前 agent run 的全部风控闸门规则结果 */
  results: RiskGateResult[];
}

/** 渲染聚合后的风控闸门状态徽章（优先级：hard > soft > 全部通过）。 */
function RiskAlertBadge({ results }: RiskAlertBadgeProps) {
  const { t } = useTranslation();
  // 分别统计阻断性（hard）与提示性（soft）规则的未通过数量。
  const failedHard = results.filter(
    (r: RiskGateResult) => r.ruleType === 'hard' && !r.passed,
  ).length;
  const failedSoft = results.filter(
    (r: RiskGateResult) => r.ruleType === 'soft' && !r.passed,
  ).length;

  if (failedHard > 0) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-400 font-medium"
      >
        <AlertTriangle size={12} />
        {t('ui.agent.riskHardFailed', { count: failedHard })}
      </Badge>
    );
  }

  if (failedSoft > 0) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400 font-medium"
      >
        <AlertTriangle size={12} />
        {t('ui.agent.riskSoftFailed', { count: failedSoft })}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="gap-1 border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 font-medium"
    >
      <ShieldCheck size={12} />
      {t('ui.agent.riskPassed')}
    </Badge>
  );
}

export default RiskAlertBadge;
