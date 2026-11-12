/** Shared appearance preferences, synchronized across consumers and browser tabs. */
import { useLayoutEffect, useSyncExternalStore } from 'react';
import type { SetStateAction } from 'react';

export type Theme = 'light' | 'dark';
export const DESIGN_THEMES = ['classic', 'arcade', 'comic', 'orbit'] as const;
export type DesignTheme = (typeof DESIGN_THEMES)[number];

interface AppearanceState {
  theme: Theme;
  designTheme: DesignTheme;
}

const THEME_KEY = 'pt-theme';
const DESIGN_THEME_KEY = 'sq-design-theme';
const DEFAULT_APPEARANCE: AppearanceState = { theme: 'light', designTheme: 'classic' };
const listeners = new Set<() => void>();

function readPreference(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    // Privacy settings can disable storage; appearance remains usable in memory.
    return null;
  }
}

function resolveTheme(value: string | null): Theme {
  return value === 'dark' ? 'dark' : 'light';
}

export function isDesignTheme(value: string | null): value is DesignTheme {
  return DESIGN_THEMES.some((designTheme: DesignTheme) => designTheme === value);
}

function resolveDesignTheme(value: string | null): DesignTheme {
  return isDesignTheme(value) ? value : 'classic';
}

let appearance: AppearanceState = {
  theme: resolveTheme(readPreference(THEME_KEY)),
  designTheme: resolveDesignTheme(readPreference(DESIGN_THEME_KEY)),
};

function applyAppearance(): void {
  if (typeof document === 'undefined') return;
  const root: HTMLElement = document.documentElement;
  root.classList.toggle('dark', appearance.theme === 'dark');
  root.dataset.designTheme = appearance.designTheme;
  root.style.colorScheme = appearance.theme;
}

function updateAppearance(next: AppearanceState): void {
  if (appearance.theme === next.theme && appearance.designTheme === next.designTheme) return;
  appearance = next;
  applyAppearance();
  listeners.forEach((listener: () => void) => listener());
}

function persistPreference(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  } catch {
    // Keeping this tab's preference does not depend on persistent storage.
  }
}

function setTheme(value: SetStateAction<Theme>): void {
  const next: Theme = typeof value === 'function' ? value(appearance.theme) : value;
  updateAppearance({ ...appearance, theme: next });
  persistPreference(THEME_KEY, next);
}

function toggleTheme(): void {
  setTheme((previous: Theme) => previous === 'dark' ? 'light' : 'dark');
}

function setDesignTheme(designTheme: DesignTheme): void {
  updateAppearance({ ...appearance, designTheme });
  persistPreference(DESIGN_THEME_KEY, designTheme);
}

function handleStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== THEME_KEY && event.key !== DESIGN_THEME_KEY) return;
  try {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
  } catch {
    return;
  }
  if (event.key === null) {
    updateAppearance(DEFAULT_APPEARANCE);
  } else if (event.key === THEME_KEY) {
    updateAppearance({ ...appearance, theme: resolveTheme(event.newValue) });
  } else {
    updateAppearance({ ...appearance, designTheme: resolveDesignTheme(event.newValue) });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('storage', handleStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', handleStorage);
    }
  };
}

const getSnapshot = (): AppearanceState => appearance;
const getServerSnapshot = (): AppearanceState => DEFAULT_APPEARANCE;

applyAppearance();

/** Body portals share the active workspace palette; leaving the shell releases it. */
export function useAppearanceScope(simple: boolean): void {
  useLayoutEffect(() => {
    if (!simple) return;
    const root = document.documentElement;
    root.dataset.workspaceExperience = 'simple';
    return () => { delete root.dataset.workspaceExperience; };
  }, [simple]);
}

/** Existing mode API plus an independent visual design preference. */
export function useTheme() {
  const state: AppearanceState = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { ...state, setTheme, toggleTheme, setDesignTheme };
}
