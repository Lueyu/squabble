import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import {
  rememberLocation,
  workspaceScrollTarget,
  returnDestination,
  safeReturnPath,
  type WorkspaceVisit,
} from './workspace-navigation';

const STORAGE_KEY = 'squabble.workspace-navigation.v1';
function readVisits(): WorkspaceVisit[] {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(STORAGE_KEY) ?? '[]',
    );
    if (!Array.isArray(value)) return [];
    return value.filter(
      (row): row is WorkspaceVisit =>
        row &&
        typeof row.key === 'string' &&
        typeof row.index === 'number' &&
        typeof row.scrollTop === 'number' &&
        !!safeReturnPath(row.path),
    );
  } catch {
    return [];
  }
}
function writeVisits(visits: WorkspaceVisit[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(visits));
  } catch {
    /* Navigation still works without storage. */
  }
}
function currentIndex(): number {
  const index: unknown = window.history.state?.idx;
  return typeof index === 'number' ? index : 0;
}

/** History belongs to this tab. Unknown preceding history always uses a safe parent. */
export function useWorkspaceNavigation(
  scrollRef?: RefObject<HTMLElement | null>,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const action = useNavigationType();
  const visits = useRef<WorkspaceVisit[]>(readVisits());

  useLayoutEffect(() => {
    if (!scrollRef) return;
    const element = scrollRef.current;
    if (!element) return;
    visits.current = readVisits();
    const path = location.pathname + location.search + location.hash;
    const target = workspaceScrollTarget(
      visits.current,
      location.key,
      action,
      location.hash,
    );
    const visit: WorkspaceVisit = {
      key: location.key,
      index: currentIndex(),
      path,
      scrollTop: target.top ?? 0,
    };
    visits.current = rememberLocation(visits.current, visit, action);
    writeVisits(visits.current);
    let restoring = target.anchor !== null || target.top > 0;
    let observedTop = target.top ?? 0;
    let frame = 0;
    const deadline = performance.now() + (target.anchor ? 15000 : 2500);
    const restore = () => {
      const anchor = target.anchor
        ? document.getElementById(target.anchor)
        : null;
      const anchorReady =
        !target.anchor || Boolean(anchor && element.contains(anchor));
      const top =
        target.anchor && anchor && element.contains(anchor)
          ? Math.max(
              0,
              element.scrollTop +
                anchor.getBoundingClientRect().top -
                element.getBoundingClientRect().top -
                16,
            )
          : (target.top ?? 0);
      if (anchorReady) element.scrollTop = top;
      if (
        (anchorReady && element.scrollTop >= top - 1) ||
        performance.now() >= deadline
      ) {
        restoring = false;
        observedTop = element.scrollTop;
        visit.scrollTop = observedTop;
        writeVisits(visits.current);
      } else frame = requestAnimationFrame(restore);
    };
    restore();
    const onScroll = () => {
      if (restoring) return;
      observedTop = element.scrollTop;
      visit.scrollTop = observedTop;
      writeVisits(visits.current);
    };
    const onUserScroll = () => {
      restoring = false;
      cancelAnimationFrame(frame);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', onUserScroll, { passive: true });
    element.addEventListener('touchstart', onUserScroll, { passive: true });
    element.addEventListener('keydown', onUserScroll);
    return () => {
      cancelAnimationFrame(frame);
      visit.scrollTop = observedTop;
      writeVisits(visits.current);
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onUserScroll);
      element.removeEventListener('touchstart', onUserScroll);
      element.removeEventListener('keydown', onUserScroll);
    };
  }, [
    location.key,
    location.pathname,
    location.search,
    location.hash,
    action,
    scrollRef,
  ]);

  const goBack = useCallback(
    (fallback: string) => {
      const state: unknown = location.state;
      const returnTo =
        state && typeof state === 'object' && 'returnTo' in state
          ? state.returnTo
          : null;
      const destination = returnDestination(
        readVisits(),
        currentIndex(),
        returnTo,
        fallback,
      );
      if (destination.kind === 'back') navigate(-1);
      else navigate(destination.path);
    },
    [location.state, navigate],
  );
  return { goBack };
}
