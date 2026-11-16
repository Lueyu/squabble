import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { apiRotateRecoveryCode } from '@/api';
import { tokenStore } from '@/api/http';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function RecoveryCodeCard() {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const result = await apiRotateRecoveryCode(password);
      tokenStore.save(result.accessToken, result.refreshToken);
      setCode(result.recoveryCode ?? '');
      setPassword('');
    } catch {
      toast.error(t('auth.recoveryGenerateFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.recoverySettingsTitle')}</CardTitle>
        <CardDescription>{t('auth.recoverySettingsSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {code && (
          <div className="space-y-2">
            <Label>{t('auth.recoveryCodeLabel')}</Label>
            <div className="rounded-xl border border-border bg-muted p-4 font-mono text-sm break-all select-all">
              {code}
            </div>
            <p className="text-xs text-muted-foreground">{t('auth.recoveryCodeWarning')}</p>
          </div>
        )}
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={generate}>
          <div className="flex-1 space-y-2">
            <Label htmlFor="current-password">{t('auth.password')}</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {t('auth.generateRecoveryCode')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
