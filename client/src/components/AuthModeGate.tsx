import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import http from '@/api/http';
import { setAuthMode } from '@/api/auth-mode';
import { Button } from '@/components/ui/button';

// Share discovery across StrictMode mounts and keep it independent from query
// invalidation during research. Only a failed attempt can be retried.
let modeRequest: Promise<void> | null = null;

function loadAuthMode(): Promise<void> {
  if (!modeRequest) {
    modeRequest = http.get<{ mode: unknown }>('/api/auth/mode').then(({ data }) => {
      if (data?.mode !== 'local' && data?.mode !== 'account') {
        throw new Error('Invalid authentication mode');
      }
      setAuthMode(data.mode);
    }).catch(error => {
      modeRequest = null;
      throw error;
    });
  }
  return modeRequest;
}

/** Do not mount routes or start their API calls until the mode is confirmed. */
export default function AuthModeGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void loadAuthMode().then(
      () => { if (active) setStatus('ready'); },
      () => { if (active) setStatus('error'); },
    );
    return () => { active = false; };
  }, [attempt]);

  if (status === 'ready') return children;

  return <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
    <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-lg">
      <img src="/logo.svg" alt="Squabble" className="mx-auto h-14 w-14" />
      {status === 'error' ? <div role="alert">
        <h1 className="mt-4 text-lg font-semibold">{t('auth.modeFailedTitle')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('auth.modeFailedDescription')}</p>
        <Button className="mt-6 w-full" onClick={() => {
          setStatus('loading');
          setAttempt(current => current + 1);
        }}>{t('common.retry')}</Button>
      </div> : <p role="status" className="mt-4 text-sm text-muted-foreground">{t('auth.modeLoading')}</p>}
    </div>
  </main>;
}
