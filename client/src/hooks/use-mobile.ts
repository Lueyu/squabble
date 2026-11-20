/**
 * @file hooks/use-mobile.ts
 * @description 移动端断点检测 hook。
 *
 * 视口宽度低于移动端阈值（768px）时返回 `true`，底层用 `matchMedia` 监听，
 * 窗口尺寸变化时实时更新。用于在表格布局与触屏友好的移动列表之间切换。
 *
 * 职责边界：
 *  - 只做视口断点判断；具体布局切换由调用方决定
 * 上下游：
 *  - 上游（谁调用这里）：components/ui/sidebar.tsx（useIsMobile）
 *  - 下游（本文件调用谁）：window.matchMedia
 * 关键约定：
 *  - 阈值 768 对应 Tailwind 的 `md` 断点
 */
import * as React from 'react';

/** Tailwind `md` 断点宽度（px）。 */
const MOBILE_BREAKPOINT = 768;

/**
 * 跟踪当前视口是否处于移动端区间。
 * @returns 视口内宽 < 768px 时为 `true`；effect 在客户端执行前默认 `false`。
 */
export function useIsMobile() {
  // 初始 undefined：首帧返回 false，避免 SSR/首渲染闪烁。
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    // 步骤 1：建立断点媒体查询监听。
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };

    // 步骤 2：挂监听并同步一次初始值。
    mql.addEventListener('change', onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);

    // 步骤 3：卸载时移除监听。
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return !!isMobile;
}
