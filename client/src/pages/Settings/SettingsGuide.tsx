import { useTranslation } from 'react-i18next';
import { ArrowUpRight, BookOpenText } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface GuideLinkProps {
  href: string;
  label: string;
}

function GuideLink({ href, label }: GuideLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <ArrowUpRight className="size-3.5" aria-hidden="true" />
    </a>
  );
}

export default function SettingsGuide() {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-primary">
          <BookOpenText size={18} aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-[0.12em]">
            {t('ui.settings.guide.eyebrow')}
          </span>
        </div>
        <CardTitle className="font-serif text-xl leading-snug">
          {t('ui.settings.guide.title')}
        </CardTitle>
        <CardDescription className="leading-6">{t('integrations.guideIntro')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-8 lg:grid-cols-2">
        <section className="min-w-0 space-y-4" aria-labelledby="settings-default-guide">
          <h2 id="settings-default-guide" className="text-base font-semibold">
            {t('integrations.guideDefaultTitle')}
          </h2>
          <ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-muted-foreground">
            <li>{t('integrations.guideDefaultStep1')}</li>
            <li>{t('integrations.guideDefaultStep2')}</li>
            <li>{t('integrations.guideDefaultStep3')}</li>
          </ol>
        </section>
        <section className="min-w-0 space-y-4" aria-labelledby="settings-free-model-guide">
          <h2 id="settings-free-model-guide" className="text-base font-semibold">
            {t('integrations.guideFreeTitle')}
          </h2>
          <ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-muted-foreground">
            <li>{t('integrations.guideFreeStep1')}</li>
            <li className="break-words">{t('integrations.guideFreeStep2')}</li>
            <li>{t('integrations.guideFreeStep3')}</li>
            <li>{t('integrations.guideFreeStep4')}</li>
          </ol>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <GuideLink
              href="https://openrouter.ai/settings/keys"
              label={t('integrations.freeKeyLink')}
            />
            <GuideLink
              href="https://openrouter.ai/collections/free-models"
              label={t('integrations.freeLimitsLink')}
            />
          </div>
        </section>
        <section className="min-w-0 space-y-5" aria-labelledby="settings-llm-guide">
          <h2 id="settings-llm-guide" className="text-base font-semibold">
            {t('integrations.guideLlmTitle')}
          </h2>
          <ol className="space-y-5">
            <GuideStep number={1} title={t('ui.settings.guide.llm.step1Title')}>
              <p>{t('ui.settings.guide.llm.step1')}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                <GuideLink href="https://platform.openai.com/api-keys" label="OpenAI API keys" />
                <GuideLink href="https://platform.deepseek.com/" label="DeepSeek" />
                <GuideLink
                  href="https://docs.volcengine.com/docs/ark/manage-api-keys?lang=zh"
                  label={t('ui.settings.guide.llm.doubaoKey')}
                />
              </div>
            </GuideStep>
            <GuideStep number={2} title={t('ui.settings.guide.llm.step2Title')}>
              <p>{t('ui.settings.guide.llm.step2')}</p>
              <div className="space-y-1 rounded-lg bg-secondary/50 px-3 py-2 font-mono text-xs text-foreground">
                <p className="break-all">OpenAI · https://api.openai.com/v1</p>
                <p className="break-all">DeepSeek · https://api.deepseek.com</p>
                <p className="break-all">Doubao · https://ark.cn-beijing.volces.com/api/v3</p>
              </div>
              <p>{t('integrations.deepSeekModelHint')}</p>
              <p>{t('integrations.deepSeekModeHint')}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                <GuideLink
                  href="https://developers.openai.com/api/docs/models/all"
                  label={t('ui.settings.guide.llm.openAiModels')}
                />
                <GuideLink
                  href="https://api-docs.deepseek.com/quick_start/pricing/"
                  label={t('ui.settings.guide.llm.deepSeekDocs')}
                />
                <GuideLink
                  href="https://docs.volcengine.com/docs/ark/quick-start-beginner?lang=zh"
                  label={t('ui.settings.guide.llm.doubaoDocs')}
                />
              </div>
            </GuideStep>
            <GuideStep number={3} title={t('ui.settings.guide.llm.step3Title')}>
              <p>{t('ui.settings.guide.llm.step3')}</p>
            </GuideStep>
            <GuideStep number={4} title={t('ui.settings.guide.llm.step4Title')}>
              <p>{t('ui.settings.guide.llm.step4')}</p>
            </GuideStep>
          </ol>
        </section>

        <section className="min-w-0 space-y-5" aria-labelledby="settings-data-guide">
          <h2 id="settings-data-guide" className="text-base font-semibold">
            {t('integrations.guideFinancialTitle')}
          </h2>
          <ol className="space-y-5">
            <GuideStep number={1} title={t('ui.settings.guide.financial.step1Title')}>
              <p>{t('ui.settings.guide.financial.step1')}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                <GuideLink
                  href="https://finnhub.io/register"
                  label={t('ui.settings.guide.financial.register')}
                />
                <GuideLink
                  href="https://finnhub.io/docs/api"
                  label={t('ui.settings.guide.financial.docs')}
                />
              </div>
            </GuideStep>
            <GuideStep number={2} title={t('ui.settings.guide.financial.step2Title')}>
              <p>{t('ui.settings.guide.financial.step2')}</p>
            </GuideStep>
            <GuideStep number={3} title={t('ui.settings.guide.financial.step3Title')}>
              <p>{t('ui.settings.guide.financial.step3')}</p>
            </GuideStep>
            <GuideStep number={4} title={t('ui.settings.guide.financial.step4Title')}>
              <p>{t('ui.settings.guide.financial.step4')}</p>
            </GuideStep>
          </ol>
        </section>
      </CardContent>
    </Card>
  );
}

function GuideStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {number}
      </span>
      <div className="min-w-0 space-y-1 text-sm leading-6 text-muted-foreground">
        <h3 className="font-medium text-foreground">{title}</h3>
        {children}
      </div>
    </li>
  );
}
