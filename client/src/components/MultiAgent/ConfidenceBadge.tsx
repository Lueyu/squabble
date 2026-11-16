/**
 * ConfidenceBadge - renders the AI analyst's confidence level as a colored outline badge.
 *
 * Confidence levels are produced by the multi-agent rating pipeline (AgentConfidence):
 *   - high   -> emerald (strong evidence, low uncertainty)
 *   - medium -> amber   (mixed / partial evidence)
 *   - low    -> slate   (weak evidence, high uncertainty)
 */
import { Badge } from '@/components/ui/badge';
import type { AgentConfidence } from '@shared/api.interface';
import { useTranslation } from 'react-i18next';

interface ConfidenceBadgeProps {
  /** Confidence level assigned by the multi-agent rating */
  confidence: AgentConfidence;
  /** Badge size: 'sm' for dense lists/cards, 'md' for headers (default 'md') */
  size?: 'sm' | 'md';
}

/** Translation key + Tailwind color classes per confidence level */
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

/** Compact padding/typography presets for the two supported sizes */
const sizeClasses: Record<'sm' | 'md', string> = {
  sm: 'text-xs px-2 py-0 h-5',
  md: 'text-sm px-2.5 py-0.5 h-6',
};

/**
 * Renders an outline Badge whose color encodes the confidence level.
 * Looks up label + color pair from confidenceMap, then overlays sizeClasses.
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
