/**
 * @file index.tsx
 * @description Application entry point.
 *
 * Creates the React root and wires the first-party provider stack every page
 * depends on: the router (`BrowserRouter`), the react-query client, a
 * top-level `ErrorBoundary`, and the global toast renderer (`Toaster`)
 * portaled onto `<body>` so toasts escape any clipped containers. The theme
 * hook is called once here so the persisted dark/light preference applies
 * before any route (including /login outside the app layout) renders.
 *
 * Architecture: this file only composes providers; actual routes are declared
 * in `app.tsx`. The bundle stylesheet (Tailwind + theme + typography) is
 * imported here so it is part of the entry chunk.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import RoutesComponent from './app.tsx';
import AuthModeGate from './components/AuthModeGate';
import './index.css';
import './i18n'; // i18n must load before any page renders
import { createPortal } from 'react-dom';
import { Toaster } from '@/components/ui/sonner';
import { useTheme } from './hooks/use-theme';
import { useTranslation } from 'react-i18next';

/**
 * Base path for the SPA, used as the router basename. Vite injects
 * `import.meta.env.BASE_URL` (the `base` build option, default "/").
 */
const CLIENT_BASE_PATH = import.meta.env.BASE_URL || '/';

/** Single react-query client for the whole app: modest retries, no refetch-on-focus. */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

/** Root-level crash fallback: brand mark, the error, and a reload button. */
function CrashFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
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

/** Root component: providers only. */
const MainApp = () => {
  // Apply the persisted theme before any route renders (including /login).
  useTheme();

  return (
    <BrowserRouter basename={CLIENT_BASE_PATH}>
      <ErrorBoundary FallbackComponent={CrashFallback} onReset={() => window.location.reload()}>
        <QueryClientProvider client={queryClient}>
          <AuthModeGate><RoutesComponent /></AuthModeGate>
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
