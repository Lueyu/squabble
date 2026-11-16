/**
 * @file pages/Auth/RegisterPage.tsx
 * @description Registration page. Bilingual via react-i18next.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiRegister, fetchRegistrationStatus } from '@/api';
import { tokenStore } from '@/api/http';
import { AuthShell } from './AuthShell';

function errorMessage(error: unknown): string {
  const e = error as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message ?? e?.message ?? '';
}

function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);
  const [registrationStatusError, setRegistrationStatusError] = useState(false);

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
    if (password !== confirm) {
      toast.warning(t('auth.passwordMismatch'));
      return;
    }
    try {
      setSubmitting(true);
      const result = await apiRegister({
        username: username.trim(),
        password,
        displayName: displayName.trim() || undefined,
      });
      tokenStore.save(result.accessToken, result.refreshToken);
      toast.success(`${t('auth.welcomeJoin')}, ${result.user.displayName ?? result.user.username}`);
      if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
      else navigate('/', { replace: true });
    } catch (error) {
      toast.error(errorMessage(error) || t('auth.registerFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title={t('auth.registerTitle')} subtitle={t('auth.registerTagline')}>
      {registrationOpen === null ? (
        <div className="mt-8 space-y-3 text-sm text-muted-foreground">
          <p>
            {t(
              registrationStatusError
                ? 'auth.registrationStatusUnavailable'
                : 'auth.checkingRegistration',
            )}
          </p>
          {registrationStatusError && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="font-medium text-foreground underline underline-offset-4"
            >
              {t('auth.retry')}
            </button>
          )}
        </div>
      ) : registrationOpen === false && !recoveryCode ? (
        <div className="mt-8 space-y-5 text-sm">
          <p>{t('auth.registrationClosed')}</p>
          <Link to="/login" className="font-medium underline underline-offset-4">
            {t('auth.login')}
          </Link>
        </div>
      ) : recoveryCode ? (
        <div className="mt-8 space-y-5">
          <p className="text-sm leading-relaxed">{t('auth.recoveryCodeExplanation')}</p>
          <div
            className="rounded-xl border border-border bg-muted p-4 font-mono text-sm break-all select-all"
            aria-label={t('auth.recoveryCodeLabel')}
          >
            {recoveryCode}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('auth.recoveryCodeWarning')}
          </p>
          <Button type="button" className="w-full" onClick={() => navigate('/', { replace: true })}>
            {t('auth.savedRecoveryCode')}
          </Button>
        </div>
      ) : (
        <>
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
              <Label htmlFor="displayName">{t('auth.displayName')}</Label>
              <Input
                id="displayName"
                placeholder={t('auth.nicknamePlaceholder')}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                placeholder={t('auth.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">{t('auth.confirmPassword')}</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                placeholder={t('auth.confirmPlaceholder')}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? t('auth.creating') : t('auth.createAccount')}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-muted-foreground">
            {t('auth.hasAccount')}
            <Link
              to="/login"
              className="ml-1 font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t('auth.login')}
            </Link>
          </div>
        </>
      )}
    </AuthShell>
  );
}

export default RegisterPage;
