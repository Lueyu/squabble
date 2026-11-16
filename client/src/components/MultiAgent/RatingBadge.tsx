/**
 * RatingBadge - renders the analyst rating as a colored outline badge with
 * brand mascots: bullish ratings carry the bull glyph (horns), bearish ones
 * the bear glyph (round ears) — miniatures of the Squabble logo bubbles.
 *
 * Color semantics mirror sell-side rating conventions:
 *   - Strong Buy / Buy   -> bull green (bullish)
 *   - Hold               -> blue (neutral)
 *   - Sell / Strong Sell -> bear red (bearish)
 *   - Watch              -> slate (no actionable call yet)
 */
import { Badge } from '@/components/ui/badge';
import type { AgentRating } from '@shared/api.interface';

interface RatingBadgeProps {
  /** Rating issued by the multi-agent pipeline, e.g. 'Strong Buy' | 'Hold' ... */
  rating: AgentRating;
  /** Badge size: 'sm' for dense layouts, 'md' for headers (default 'md') */
  size?: 'sm' | 'md';
}

/** Tailwind color classes per rating; stronger calls get stronger/fill-like emphasis */
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

/** Compact padding/typography presets for the two supported sizes */
const sizeClasses: Record<'sm' | 'md', string> = {
  sm: 'text-xs px-2 py-0 h-5 gap-1',
  md: 'text-sm px-2.5 py-0.5 h-6 gap-1.5',
};

/** Bull glyph: the logo's bull bubble in miniature — horns plus rounded head. */
function BullGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M4.4 4.2 L2.9 1.2 L6.4 3 Z" />
      <path d="M11.6 4.2 L13.1 1.2 L9.6 3 Z" />
      <rect x="1.6" y="3.6" width="12.8" height="9.2" rx="3.6" />
    </svg>
  );
}

/** Bear glyph: the logo's bear bubble in miniature — round ears plus rounded head. */
function BearGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <circle cx="4.4" cy="4" r="1.9" />
      <circle cx="11.6" cy="4" r="1.9" />
      <rect x="1.6" y="3.6" width="12.8" height="9.2" rx="3.6" />
    </svg>
  );
}

/** Which mascot (if any) belongs to a rating. */
function ratingGlyph(rating: AgentRating) {
  if (rating === 'Buy' || rating === 'Strong Buy') return <BullGlyph />;
  if (rating === 'Sell' || rating === 'Strong Sell') return <BearGlyph />;
  return null;
}

/** Renders an outline Badge colored by ratingStyles; mascot + raw rating string. */
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
