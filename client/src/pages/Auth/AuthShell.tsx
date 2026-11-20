/**
 * AuthShell.tsx — 登录/注册/找回密码共用的外观感知外层布局（品牌介绍区 + 表单面板）。
 *
 * 职责边界：
 *  - 只负责壳层：顶栏（吉祥物 + 应用名 + 外观切换）、左侧品牌介绍、右侧表单容器、隐私提示条。
 *  - 不含任何表单逻辑；title/subtitle/children 由各认证页注入。
 * 上下游：
 *  - 上游（路由入口/谁引用）：LoginPage、RegisterPage、RecoverPage 三个认证页包壳使用。
 *  - 下游（调用哪些 hooks/api/组件）：react-i18next；AppearancePicker、Mascot、Link；auth-theme.css。
 * 关键约定：
 *  - AuthPrivacyNote 在桌面端渲染于介绍区内、移动端渲染于页面底部，两处由 CSS 类控制显隐。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { AppearancePicker } from '@/components/AppearancePicker';
import { Mascot } from '@/components/Mascot';
import './auth-theme.css';

interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
}

/** 隐私提示条：一句话说明 + 跳转 /privacy 的链接，桌面/移动复用同一组件。 */
function AuthPrivacyNote({ className }: { className: string }) {
  const { t } = useTranslation();
  return (
    <div className={`auth-privacy ${className}`}>
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>
        {t('auth.privacyLine')}{' '}
        <Link to="/privacy" className="underline underline-offset-4 hover:text-foreground">
          {t('auth.privacyLink')}
        </Link>
      </p>
    </div>
  );
}

/** 登录与注册共用的、随外观主题变化的入口壳层。 */
export function AuthShell({ title, subtitle, children }: AuthShellProps) {
  const { t } = useTranslation();

  return (
    <div className="auth-page safe-top safe-bottom">
      {/* 顶栏：品牌标识 + 外观（浅色/深色）切换 */}
      <header className="auth-toolbar">
        <div className="flex items-center gap-2.5">
          <Mascot className="h-9 w-9" />
          <span className="font-semibold tracking-tight">{t('layout.appName')}</span>
        </div>
        <AppearancePicker />
      </header>

      <main className="auth-shell">
        {/* 左侧品牌介绍区：动态场景 + 宣传语，仅装饰无交互 */}
        <section className="auth-intro" aria-labelledby="auth-brand-headline">
          <div className="auth-scene" aria-hidden="true">
            <div className="auth-scene-orbit" />
            <Mascot className="auth-mascot" />
            <span className="auth-scene-mark auth-scene-mark-one">+</span>
            <span className="auth-scene-mark auth-scene-mark-two">+</span>
          </div>
          <div className="auth-intro-copy">
            <p className="auth-wordmark">{t('layout.appName')}</p>
            <h2 id="auth-brand-headline" className="auth-intro-title">
              {t('auth.tagline')}
            </h2>
          </div>
          <AuthPrivacyNote className="auth-desktop-privacy" />
        </section>

        {/* 右侧表单面板：标题/副标题由调用方传入，children 为具体表单 */}
        <section className="auth-form-panel" aria-labelledby="auth-form-title">
          <div className="auth-form-heading">
            <h1 id="auth-form-title" className="text-2xl font-semibold tracking-tight">
              {title}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
          </div>
          {children}
        </section>
      </main>
      {/* 移动端隐私提示条：桌面端同类提示显示在介绍区内，此处仅移动端可见 */}
      <AuthPrivacyNote className="auth-mobile-privacy" />
    </div>
  );
}
