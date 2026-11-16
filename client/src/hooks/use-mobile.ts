/**
 * @file hooks/use-mobile.ts
 * @brief Breakpoint detection hook.
 *
 * Returns `true` when the viewport is below the mobile threshold (768px),
 * backed by a `matchMedia` listener so it updates live on resize. Used to
 * swap between table layouts and touch-friendly mobile lists.
 */
import * as React from 'react';

/** Tailwind `md` breakpoint width in px. */
const MOBILE_BREAKPOINT = 768;

/**
 * Track whether the current viewport is in the mobile range.
 * @returns `true` when inner width < 768px; defaults to `false` before the
 *          effect runs on the client.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener('change', onChange);
    // Synchronize initial value after mount.
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return !!isMobile;
}
