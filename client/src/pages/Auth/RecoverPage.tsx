import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { apiRecoverAccount } from '@/api';
import { tokenStore } from '@/api/http';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell } from './AuthShell';

export default function RecoverPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [nextCode, setNextCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const result = await apiRecoverAccount({
        username: username.trim(),
        recoveryCode: code.trim(),
        newPassword: password,
      });
      tokenStore.save(result.accessToken, result.refreshToken);
      if (result.recoveryCode) setNextCode(result.recoveryCode);
      else navigate('/', { replace: true });
    } catch {
      toast.error(t('auth.recoverFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title={t('auth.recoverTitle')} subtitle={t('auth.recoverSubtitle')}>
      {nextCode ? (
        <div className="mt-8 space-y-5">
          <p className="text-sm leading-relaxed">{t('auth.recoveryCodeExplanation')}</p>
          <div
            className="rounded-xl border border-border bg-muted p-4 font-mono text-sm break-all select-all"
            aria-label={t('auth.recoveryCodeLabel')}
          >
            {nextCode}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('auth.recoveryCodeWarning')}
          </p>
          <Button className="w-full" onClick={() => navigate('/', { replace: true })}>
            {t('auth.savedRecoveryCode')}
          </Button>
        </div>
      ) : (
        <>
          <form className="mt-8 space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="recover-username">{t('auth.username')}</Label>
              <Input
                id="recover-username"
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recover-code">{t('auth.recoveryCodeLabel')}</Label>
              <Input
                id="recover-code"
                required
                minLength={48}
                maxLength={48}
                autoComplete="off"
                placeholder={t('auth.recoveryCodePlaceholder')}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recover-password">{t('auth.newPassword')}</Label>
              <Input
                id="recover-password"
                required
                type="password"
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button className="w-full" type="submit" disabled={submitting}>
              {submitting ? t('auth.recovering') : t('auth.recoverButton')}
            </Button>
          </form>
          <Link
            to="/login"
            className="mt-6 text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t('auth.backToLogin')}
          </Link>
        </>
      )}
    </AuthShell>
  );
}
