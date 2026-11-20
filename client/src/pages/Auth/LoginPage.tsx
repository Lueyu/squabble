/**
 * LoginPage.tsx — 一方账号体系登录页：账密表单 + 注册开关探测 + 登录成功落 token 并回跳。
 *
 * 职责边界：
 *  - 仅登录：校验非空 → apiLogin → tokenStore 保存 → navigate(from)；不处理注册/找回本身。
 *  - 注册入口显隐、注册状态探测失败重试，均由 fetchRegistrationStatus 结果驱动。
 * 上下游：
 *  - 上游（路由入口/谁引用）：app.tsx 的 /login 路由；受保护页面经 location.state.from 回跳至此。
 *  - 下游（调用哪些 hooks/api/组件）：useTranslation/useNavigate/useLocation；apiLogin、
 *    fetchRegistrationStatus、tokenStore；AuthShell、Button/Input/Label、toast。
 * 关键约定：
 *  - registrationOpen 为 boolean | null：null 表示状态未知（不渲染注册入口）；探测失败置
 *    registrationStatusError 并提供刷新重试。
 *  - from = location.state?.from?.pathname ?? '/'，登录成功后 replace 跳转，避免历史残留登录页。
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

/** 从 Axios 错误或原生 Error 中提取服务端 message，供 toast 展示。 */
function errorMessage(error: unknown): string {
  const e = error as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message ?? e?.message ?? '';
}

function LoginPage() {
  // —— 状态声明区 ——
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string } } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 注册开关三态：null=探测中/未知，true=开放注册，false=已关闭
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);
  const [registrationStatusError, setRegistrationStatusError] = useState(false);
  // 登录成功后的回跳目标（受保护页跳转登录时携带）
  const from = location.state?.from?.pathname ?? '/';

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
  // 提交登录：先做非空校验，成功后保存双 token 并按来源页回跳
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

  // —— 渲染区 ——
  return (
    <AuthShell title={t('auth.loginTitle')} subtitle={t('auth.welcomeBack')}>
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
        {/* 密码输入 */}
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
        {/* 忘记密码入口 */}
        <div className="text-right text-sm">
          <Link
            to="/recover"
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t('auth.forgotPassword')}
          </Link>
        </div>
        {/* 提交按钮：提交中禁用并切换文案 */}
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? t('auth.loggingIn') : t('auth.login')}
        </Button>
      </form>

      {/* 什么时候走到这里：注册开关探测成功且开放注册时，显示注册入口 */}
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
      {/* 什么时候走到这里：注册状态探测失败时，提示并提供整页刷新重试 */}
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
