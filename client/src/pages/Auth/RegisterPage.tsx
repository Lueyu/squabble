/**
 * RegisterPage.tsx — 注册页：四态渲染（探测中/已关闭/展示恢复码/注册表单），注册即登录。
 *
 * 职责边界：
 *  - 探测注册开关 → 校验（非空 + 两次密码一致）→ apiRegister → tokenStore 落 token；
 *    若服务端返回恢复码则先展示让用户抄存，确认后才跳首页。
 *  - 不处理登录/找回；displayName 可选，为空时不传。
 * 上下游：
 *  - 上游（路由入口/谁引用）：app.tsx 的 /register 路由；LoginPage 的注册入口。
 *  - 下游（调用哪些 hooks/api/组件）：useTranslation/useNavigate；apiRegister、
 *    fetchRegistrationStatus、tokenStore；AuthShell、Button/Input/Label、toast、Link。
 * 关键约定：
 *  - 渲染四态优先级：registrationOpen === null（探测中/失败）→ registrationOpen === false 且
 *    未持恢复码（已关闭）→ 已持恢复码（抄存新码）→ 其余（注册表单）。顺序不可调换。
 *  - 密码 12-128 位，由 Input 的 minLength/maxLength 硬约束。
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

/** 从 Axios 错误或原生 Error 中提取服务端 message，供 toast 展示。 */
function errorMessage(error: unknown): string {
  const e = error as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message ?? e?.message ?? '';
}

function RegisterPage() {
  // —— 状态声明区 ——
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 注册成功后服务端返回的一次性恢复码；非空时进入"抄存新码"视图
  const [recoveryCode, setRecoveryCode] = useState('');
  // 注册开关三态：null=探测中/未知
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);
  const [registrationStatusError, setRegistrationStatusError] = useState(false);

  // —— 数据获取区 ——
  // 挂载时探测注册开关；active 标志防止卸载后的 setState
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

  // —— 事件处理区 ——
  // 提交注册：非空校验 → 密码一致性校验 → apiRegister → 落 token → 展示恢复码或直接进首页
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
      // 有轮换的恢复码则先展示，否则直接进入应用
      if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
      else navigate('/', { replace: true });
    } catch (error) {
      toast.error(errorMessage(error) || t('auth.registerFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // —— 渲染区 ——
  return (
    <AuthShell title={t('auth.registerTitle')} subtitle={t('auth.registerTagline')}>
      {/* 什么时候走到这里：注册开关仍在探测或探测失败——显示等待文案，失败时给刷新重试 */}
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
        // 什么时候走到这里：站点已关闭注册（且未处于"抄存恢复码"状态）——提示并引导回登录
        <div className="mt-8 space-y-5 text-sm">
          <p>{t('auth.registrationClosed')}</p>
          <Link to="/login" className="font-medium underline underline-offset-4">
            {t('auth.login')}
          </Link>
        </div>
      ) : recoveryCode ? (
        // 什么时候走到这里：注册成功且服务端返回了新恢复码——先展示让用户抄存
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
          {/* 用户确认已抄存新恢复码，进入首页 */}
          <Button type="button" className="w-full" onClick={() => navigate('/', { replace: true })}>
            {t('auth.savedRecoveryCode')}
          </Button>
        </div>
      ) : (
        // 什么时候走到这里：注册开放且未持恢复码——显示注册表单
        <>
          <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
            {/* 用户名输入 */}
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
            {/* 昵称（可选） */}
            <div className="space-y-2">
              <Label htmlFor="displayName">{t('auth.displayName')}</Label>
              <Input
                id="displayName"
                placeholder={t('auth.nicknamePlaceholder')}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            {/* 密码输入：12-128 位 */}
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
            {/* 确认密码输入 */}
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
            {/* 提交按钮：提交中禁用并切换文案 */}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? t('auth.creating') : t('auth.createAccount')}
            </Button>
          </form>

          {/* 已有账号 → 跳登录 */}
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
