/**
 * RiskAlertBadge - summarizes the risk-gate check results as a single badge.
 *
 * A "risk gate" runs a set of rules against a rating before it is finalized.
 * Rules are either 'hard' (blocking) or 'soft' (advisory). Display priority:
 *   1. any failed HARD rule  -> rose badge: blocking violations exist
 *   2. any failed SOFT rule  -> amber badge: warnings, not blocking
 *   3. none failed           -> emerald badge: risk gate passed
 */
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type { RiskGateResult } from '@shared/api.interface';
import { useTranslation } from 'react-i18next';

interface RiskAlertBadgeProps {
  /** All risk-gate rule results for the current agent run */
  results: RiskGateResult[];
}

/** Renders the aggregate risk-gate status badge (hard > soft > pass priority). */
function RiskAlertBadge({ results }: RiskAlertBadgeProps) {
  const { t } = useTranslation();
  // Count blocking vs advisory rule failures separately
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
