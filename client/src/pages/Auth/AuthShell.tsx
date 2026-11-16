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

/** Shared, appearance-aware entry point for sign-in and account creation. */
export function AuthShell({ title, subtitle, children }: AuthShellProps) {
  const { t } = useTranslation();

  return (
    <div className="auth-page safe-top safe-bottom">
      <header className="auth-toolbar">
        <div className="flex items-center gap-2.5">
          <Mascot className="h-9 w-9" />
          <span className="font-semibold tracking-tight">{t('layout.appName')}</span>
        </div>
        <AppearancePicker />
      </header>

      <main className="auth-shell">
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
      <AuthPrivacyNote className="auth-mobile-privacy" />
    </div>
  );
}
