/**
 * RecoverPage.tsx — 凭恢复码找回账号页：恢复码 + 用户名 + 新密码 → 换发新凭据。
 *
 * 职责边界：
 *  - 两阶段页面：未恢复时显示表单；恢复成功且服务端返回新恢复码时，先展示新码让用户抄存，
 *    用户确认后才跳首页。直接登录态由 apiRecoverAccount 的双 token 落入 tokenStore 完成。
 * 上下游：
 *  - 上游（路由入口/谁引用）：app.tsx 的 /recover 路由；LoginPage 的"忘记密码"入口。
 *  - 下游（调用哪些 hooks/api/组件）：useState/useTranslation/useNavigate；apiRecoverAccount、
 *    tokenStore；AuthShell、Button/Input/Label、toast、Link。
 * 关键约定：
 *  - 恢复码长度固定 48（minLength/maxLength 由前端硬约束）；新密码 12-128 位。
 *  - 若服务端未轮换恢复码（result.recoveryCode 为空），则跳过展示直接回首页。
 */
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
  // —— 状态声明区 ——
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  // 服务端轮换后的新恢复码；非空表示进入"抄存新码"阶段
  const [nextCode, setNextCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // —— 事件处理区 ——
  // 提交恢复请求：成功后保存双 token；若返回了轮换的新恢复码则先展示，否则直接回首页
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

  // —— 渲染区 ——
  return (
    <AuthShell title={t('auth.recoverTitle')} subtitle={t('auth.recoverSubtitle')}>
      {/* 什么时候走到这里：恢复成功且服务端轮换了恢复码——先展示新码，用户抄存后手动进入应用 */}
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
          {/* 用户确认已抄存新码，进入首页 */}
          <Button className="w-full" onClick={() => navigate('/', { replace: true })}>
            {t('auth.savedRecoveryCode')}
          </Button>
        </div>
      ) : (
        <>
          {/* 什么时候走到这里：尚未恢复——展示恢复表单 */}
          <form className="mt-8 space-y-4" onSubmit={submit}>
            {/* 用户名输入 */}
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
            {/* 恢复码输入：固定 48 位 */}
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
            {/* 新密码输入：12-128 位 */}
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
            {/* 提交按钮：提交中禁用并切换文案 */}
            <Button className="w-full" type="submit" disabled={submitting}>
              {submitting ? t('auth.recovering') : t('auth.recoverButton')}
            </Button>
          </form>
          {/* 返回登录页 */}
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
