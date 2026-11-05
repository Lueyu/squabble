import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { getAuthMode } from '@/api/auth-mode';

export default function PrivacyPage() {
  const { t, i18n } = useTranslation();
  const localWorkspace = getAuthMode() === 'local';
  const guideUrl = i18n.language.startsWith('zh')
    ? 'https://github.com/Lueyu/squabble/blob/main/docs/privacy.zh-CN.md'
    : 'https://github.com/Lueyu/squabble/blob/main/docs/privacy.md';

  return (
    <main className="safe-top safe-bottom min-h-screen bg-background px-5 py-12 text-foreground">
      <article className="mx-auto max-w-2xl space-y-8">
        <header className="space-y-3">
          <ShieldCheck className="h-8 w-8 text-primary" aria-hidden="true" />
          <h1 className="text-3xl font-semibold">{t('privacy.title')}</h1>
          <p className="leading-relaxed text-muted-foreground">{t('privacy.intro')}</p>
        </header>
        <section className="space-y-2">
          <h2 className="text-xl font-semibold">{t('privacy.storedTitle')}</h2>
          <p className="leading-relaxed text-muted-foreground">{t('privacy.stored')}</p>
        </section>
        <section className="space-y-2">
          <h2 className="text-xl font-semibold">{t('privacy.outboundTitle')}</h2>
          <p className="leading-relaxed text-muted-foreground">{t('privacy.outbound')}</p>
        </section>
        <section className="space-y-2">
          <h2 className="text-xl font-semibold">{t('privacy.browserTitle')}</h2>
          <p className="leading-relaxed text-muted-foreground">{t('privacy.browser')}</p>
        </section>
        <nav className="flex flex-wrap gap-4 text-sm" aria-label={t('privacy.title')}>
          <a href={guideUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4">
            {t('privacy.fullGuide')}
          </a>
          <Link to={localWorkspace ? '/' : '/login'} className="font-medium text-primary underline underline-offset-4">
            {t(localWorkspace ? 'privacy.backToWorkspace' : 'privacy.back')}
          </Link>
        </nav>
      </article>
    </main>
  );
}
