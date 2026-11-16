import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';

/** The bull/bear conversation remains our signature in every visual world. */
export function Mascot({
  className,
  decorative = true,
}: {
  className?: string;
  decorative?: boolean;
}) {
  const { designTheme } = useTheme();
  return (
    <span className={cn('squabble-mascot', className)} aria-hidden={decorative || undefined}>
      <img
        src={designTheme === 'arcade' ? '/logo-pixel.svg' : '/logo.svg'}
        alt={decorative ? '' : 'Squabble'}
        width="64"
        height="64"
        draggable={false}
      />
    </span>
  );
}
