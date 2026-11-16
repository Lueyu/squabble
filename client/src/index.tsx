/**
 * @file index.tsx
 * @description 应用入口。
 *
 * 创建 React root，并装配所有页面都依赖的第一方 provider 栈：
 * 路由器（`BrowserRouter`）、react-query client、顶层 `ErrorBoundary`，
 * 以及通过 `createPortal` 挂到 `<body>` 的全局 toast 渲染器（`Toaster`）——
 * portal 让 toast 逃逸出任何会被裁剪的容器。主题 hook 在此处调用一次，
 * 使持久化的 dark/light 偏好在任何路由（包括壳外的 /login）渲染之前生效。
 *
 * 架构：本文件只做 provider 组合；具体路由声明在 `app.tsx`。
 * 打包样式表（Tailwind + 主题 + 排版）也在入口处导入，使其进入入口 chunk。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import RoutesComponent from './app.tsx';
import './index.css';
import './i18n'; // i18n 必须先于任何页面渲染加载
import { createPortal } from 'react-dom';
import { Toaster } from '@/components/ui/sonner';
import { useTheme } from './hooks/use-theme';
import { useTranslation } from 'react-i18next';

/**
 * SPA 的基础路径，用作路由器 basename。Vite 注入 `import.meta.env.BASE_URL`
 * （即构建配置的 `base` 选项，默认 "/"）。
 */
const CLIENT_BASE_PATH = import.meta.env.BASE_URL || '/';

/** 全应用唯一的 react-query client：重试 1 次、窗口聚焦不 refetch、staleTime 30 秒。 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

/** 根级崩溃兜底 UI：品牌标识、错误信息与一个重新加载按钮。 */
function CrashFallback({
  error,
  resetErrorBoundary,
}: {
  error: Error;
  resetErrorBoundary: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-lg">
        <img src="/logo.svg" alt="Squabble" className="mx-auto h-14 w-14" />
        <h1 className="mt-4 text-lg font-semibold text-foreground">{t('ui.common.crashTitle')}</h1>
        <p className="mt-2 break-all text-sm text-muted-foreground">{error.message}</p>
        <Button className="mt-6 w-full" onClick={() => resetErrorBoundary()}>
          {t('common.retry')}
        </Button>
      </div>
    </div>
  );
}

/** 根组件：只负责 provider 组合。 */
const MainApp = () => {
  // 在任何路由（包括 /login）渲染之前，先应用持久化的主题偏好。
  useTheme();

  return (
    <BrowserRouter basename={CLIENT_BASE_PATH}>
      <ErrorBoundary FallbackComponent={CrashFallback} onReset={() => window.location.reload()}>
        <QueryClientProvider client={queryClient}>
          <RoutesComponent />
          {createPortal(<Toaster />, document.body)}
        </QueryClientProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MainApp />
  </React.StrictMode>,
);
