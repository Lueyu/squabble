/**
 * @file pages/Auth/LoginPage.tsx
 * @description Login page for the first-party account system.
 * Bilingual (zh-CN / en) via react-i18next.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiLogin, fetchRegistrationStatus } from '@/api';
import { tokenStore } from '@/api/http';
import { AuthShell } from './AuthShell';

function errorMessage(error: unknown): string {
  const e = error as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message ?? e?.message ?? '';
}

function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string } } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);
  const [registrationStatusError, setRegistrationStatusError] = useState(false);
  const from = location.state?.from?.pathname ?? '/';

  useEffect(() => {
    let active = true;
    fetchRegistrationStatus()
      .then((status) => {
        if (active) setRegistrationOpen(status.registrationOpen);
      })
      .catch(() => {
        if (active) setRegistrationStatusError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      toast.warning(t('auth.enterCredentials'));
      return;
    }
    try {
      setSubmitting(true);
      const result = await apiLogin({ username: username.trim(), password });
      tokenStore.save(result.accessToken, result.refreshToken);
      toast.success(`${t('auth.welcomeBack')}, ${result.user.displayName ?? result.user.username}`);
      navigate(from, { replace: true });
    } catch (error) {
      toast.error(errorMessage(error) || t('auth.loginFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title={t('auth.loginTitle')} subtitle={t('auth.welcomeBack')}>
      <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="username">{t('auth.username')}</Label>
          <Input
            id="username"
            autoComplete="username"
            placeholder={t('auth.usernamePlaceholder')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t('auth.password')}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="text-right text-sm">
          <Link
            to="/recover"
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t('auth.forgotPassword')}
          </Link>
        </div>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? t('auth.loggingIn') : t('auth.login')}
        </Button>
      </form>

      {registrationOpen && (
        <div className="mt-6 text-center text-sm text-muted-foreground">
          {t('auth.noAccount')}
          <Link
            to="/register"
            className="ml-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            {t('auth.register')}
          </Link>
        </div>
      )}
      {registrationStatusError && (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          {t('auth.registrationStatusUnavailable')}{' '}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="font-medium underline underline-offset-4"
          >
            {t('auth.retry')}
          </button>
        </p>
      )}
    </AuthShell>
  );
}

export default LoginPage;
