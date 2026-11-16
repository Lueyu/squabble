/**
 * PrivacyPage.tsx — 隐私说明页：本地存储 / 外发数据 / 浏览器凭据三段说明 + 完整指南链接。
 *
 * 职责边界：
 *  - 纯静态展示页，仅按当前语言选择隐私文档链接，无状态、无请求。
 * 上下游：
 *  - 上游（路由入口/谁引用）：app.tsx 的 /privacy 路由（登录页等处可跳入）。
 *  - 下游（调用哪些 hooks/api/组件）：react-i18next 的 useTranslation；Link、lucide 的 ShieldCheck。
 * 关键约定：
 *  - guideUrl 按语言前缀 zh 分流到 docs/privacy.zh-CN.md 与 docs/privacy.md，链接地址不得改动。
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';

export default function PrivacyPage() {
  const { t, i18n } = useTranslation();
  // 按当前语言选择完整隐私指南的 GitHub 文档地址
  const guideUrl = i18n.language.startsWith('zh')
    ? 'https://github.com/Lueyu/squabble/blob/main/docs/privacy.zh-CN.md'
    : 'https://github.com/Lueyu/squabble/blob/main/docs/privacy.md';

  return (
    <main className="safe-top safe-bottom min-h-screen bg-background px-5 py-12 text-foreground">
      <article className="mx-auto max-w-2xl space-y-8">
        {/* 页头：图标 + 标题 + 引言 */}
        <header className="space-y-3">
          <ShieldCheck className="h-8 w-8 text-primary" aria-hidden="true" />
          <h1 className="text-3xl font-semibold">{t('privacy.title')}</h1>
          <p className="leading-relaxed text-muted-foreground">{t('privacy.intro')}</p>
        </header>
        {/* 本地存储了哪些数据 */}
        <section className="space-y-2">
          <h2 className="text-xl font-semibold">{t('privacy.storedTitle')}</h2>
          <p className="leading-relaxed text-muted-foreground">{t('privacy.stored')}</p>
        </section>
        {/* 哪些数据会外发给第三方服务 */}
        <section className="space-y-2">
          <h2 className="text-xl font-semibold">{t('privacy.outboundTitle')}</h2>
          <p className="leading-relaxed text-muted-foreground">{t('privacy.outbound')}</p>
        </section>
        {/* 浏览器端凭据（cookie/localStorage）的用途 */}
        <section className="space-y-2">
          <h2 className="text-xl font-semibold">{t('privacy.browserTitle')}</h2>
          <p className="leading-relaxed text-muted-foreground">{t('privacy.browser')}</p>
        </section>
        {/* 底部导航：新窗口打开完整指南 + 返回登录页 */}
        <nav className="flex flex-wrap gap-4 text-sm" aria-label={t('privacy.title')}>
          <a
            href={guideUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-4"
          >
            {t('privacy.fullGuide')}
          </a>
          <Link to="/login" className="font-medium text-primary underline underline-offset-4">
            {t('privacy.back')}
          </Link>
        </nav>
      </article>
    </main>
  );
}
