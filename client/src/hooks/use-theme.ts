/**
 * @file hooks/use-theme.ts
 * @description 全局外观偏好（明暗主题 + 视觉设计主题）的跨组件、跨页签同步状态。
 *
 * 用 useSyncExternalStore 把模块级 appearance 状态挂到 React；任意消费者
 * 调 setTheme/toggleTheme/setDesignTheme 都会同步写到 localStorage 并应用到
 * documentElement，其他浏览器页签通过 storage 事件跟随变化。
 *
 * 职责边界：
 *  - 只管理 light/dark 与设计主题（classic/arcade/comic/orbit）两件事
 *  - 图表用的语义色板派生在 hooks/use-chart-theme.ts
 * 上下游：
 *  - 上游（谁调用这里）：index.tsx（应用挂载）、Layout、AppearancePicker、Mascot、
 *    use-chart-theme、ui/sonner
 *  - 下游（本文件调用谁）：react 的 useSyncExternalStore；window.localStorage；
 *    document.documentElement（class/dataset/colorScheme 写入）
 * 关键约定：
 *  - 存储键 'pt-theme'（明暗）与 'sq-design-theme'（设计主题）被测试与
 *    AppearancePicker 共享，禁止改名
 *  - localStorage 被隐私设置禁用时，偏好退化为本页签内存态
 */
import { useSyncExternalStore } from 'react';
import type { SetStateAction } from 'react';

export type Theme = 'light' | 'dark';
export const DESIGN_THEMES = ['classic', 'arcade', 'comic', 'orbit'] as const;
export type DesignTheme = (typeof DESIGN_THEMES)[number];

/** 外观状态的形状：明暗主题 + 设计主题。 */
interface AppearanceState {
  theme: Theme;
  designTheme: DesignTheme;
}

const THEME_KEY = 'pt-theme';
const DESIGN_THEME_KEY = 'sq-design-theme';
const DEFAULT_APPEARANCE: AppearanceState = { theme: 'dark', designTheme: 'classic' };
const listeners = new Set<() => void>();

/** 从 localStorage 读取偏好；读取失败（如隐私模式）返回 null。 */
function readPreference(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    // 隐私设置可能禁用存储；外观退化为内存态，仍然可用。
    return null;
  }
}

/** 把存储值解析为合法 Theme；非法值一律回退 dark。 */
function resolveTheme(value: string | null): Theme {
  return value === 'light' ? 'light' : 'dark';
}

/** 判断一个字符串是否是合法的设计主题（类型守卫）。 */
export function isDesignTheme(value: string | null): value is DesignTheme {
  return DESIGN_THEMES.some((designTheme: DesignTheme) => designTheme === value);
}

/** 把存储值解析为合法 DesignTheme；非法值一律回退 classic。 */
function resolveDesignTheme(value: string | null): DesignTheme {
  return isDesignTheme(value) ? value : 'classic';
}

// 模块级状态：初始化时读一次存储（SSR/无 window 环境走默认值）。
let appearance: AppearanceState = {
  theme: resolveTheme(readPreference(THEME_KEY)),
  designTheme: resolveDesignTheme(readPreference(DESIGN_THEME_KEY)),
};

/** 把当前外观应用到 documentElement（dark class、data-design-theme、colorScheme）。 */
function applyAppearance(): void {
  if (typeof document === 'undefined') return;
  const root: HTMLElement = document.documentElement;
  root.classList.toggle('dark', appearance.theme === 'dark');
  root.dataset.designTheme = appearance.designTheme;
  root.style.colorScheme = appearance.theme;
}

/** 更新状态 → 应用到 DOM → 通知全部订阅者；值未变化时短路。 */
function updateAppearance(next: AppearanceState): void {
  if (appearance.theme === next.theme && appearance.designTheme === next.designTheme) return;
  appearance = next;
  applyAppearance();
  listeners.forEach((listener: () => void) => listener());
}

/** 写 localStorage；失败静默（本页签的偏好不依赖持久化存储）。 */
function persistPreference(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  } catch {
    // 本页签的偏好不依赖持久化存储，写失败可忽略。
  }
}

/** 设置明暗主题（支持函数式更新，语义同 useState 的 setter）。 */
function setTheme(value: SetStateAction<Theme>): void {
  const next: Theme = typeof value === 'function' ? value(appearance.theme) : value;
  updateAppearance({ ...appearance, theme: next });
  persistPreference(THEME_KEY, next);
}

/** 在明暗之间切换。 */
function toggleTheme(): void {
  setTheme((previous: Theme) => (previous === 'dark' ? 'light' : 'dark'));
}

/** 设置设计主题（classic/arcade/comic/orbit）。 */
function setDesignTheme(designTheme: DesignTheme): void {
  updateAppearance({ ...appearance, designTheme });
  persistPreference(DESIGN_THEME_KEY, designTheme);
}

/** 其他页签修改存储时的跟随逻辑：清空→默认值，单项变化→单项更新。 */
function handleStorage(event: StorageEvent): void {
  // 只关心本模块的两个键（或清空事件 key === null）。
  if (event.key !== null && event.key !== THEME_KEY && event.key !== DESIGN_THEME_KEY) return;
  try {
    // storageArea 不是本页签的 localStorage 时不处理。
    if (event.storageArea && event.storageArea !== window.localStorage) return;
  } catch {
    return;
  }
  if (event.key === null) {
    // key 为 null 表示 localStorage 被整页清空：回到默认外观。
    updateAppearance(DEFAULT_APPEARANCE);
  } else if (event.key === THEME_KEY) {
    updateAppearance({ ...appearance, theme: resolveTheme(event.newValue) });
  } else {
    updateAppearance({ ...appearance, designTheme: resolveDesignTheme(event.newValue) });
  }
}

/** useSyncExternalStore 的订阅函数；首个订阅者挂上 storage 监听，最后一个退订时移除。 */
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

// 模块加载时立即应用一次外观（无 document 的环境跳过）。
applyAppearance();

/**
 * 读取并操作全局外观：既有的明暗模式 API，外加独立的视觉设计偏好。
 * @returns `{ theme, designTheme, setTheme, toggleTheme, setDesignTheme }`。
 */
export function useTheme() {
  const state: AppearanceState = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { ...state, setTheme, toggleTheme, setDesignTheme };
}
