/**
 * @file client/src/i18n/index.ts
 * @description i18n bootstrap: react-i18next with zh-CN + en bundles.
 *
 * Language is persisted in localStorage ('sq-lang') and defaults to the
 * browser's preferred locale. The switcher lives in the sidebar (Layout).
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './zh-CN.json';
import en from './en.json';
import uiZhCN from './ui.zh-CN.json';
import uiEn from './ui.en.json';
import appearanceZhCN from './appearance.zh-CN.json';
import appearanceEn from './appearance.en.json';
import analysisFlowZhCN from './analysis-flow.zh-CN.json';
import analysisFlowEn from './analysis-flow.en.json';
import integrationsZhCN from './integration-defaults.zh-CN.json';
import integrationsEn from './integration-defaults.en.json';
import marketOverviewZhCN from './market.zh-CN.json';
import marketOverviewEn from './market.en.json';
import councilZhCN from './council.zh-CN.json';
import councilEn from './council.en.json';
import updatesZhCN from './updates.zh-CN.json';
import updatesEn from './updates.en.json';
import strategyZhCN from './strategy.zh-CN.json';
import strategyEn from './strategy.en.json';
import settingsNavZhCN from './settings-nav.zh-CN.json';
import settingsNavEn from './settings-nav.en.json';

export const SUPPORTED_LANGS = ['zh-CN', 'en'] as const;
export type AppLang = (typeof SUPPORTED_LANGS)[number];

const LANG_KEY = 'sq-lang';

/** Detect the initial language: stored -> browser -> zh-CN. */
function detectLang(): AppLang {
  if (typeof window === 'undefined') return 'zh-CN';
  try {
    const stored = window.localStorage.getItem(LANG_KEY);
    if (stored === 'en' || stored === 'zh-CN') return stored;
  } catch {
    // Browser privacy settings may block storage; language detection still works.
  }
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('en')) return 'en';
  return 'zh-CN';
}

/** Switch the language (also persists). */
export function setLanguage(lang: AppLang): void {
  i18n.changeLanguage(lang);
  try {
    window.localStorage.setItem(LANG_KEY, lang);
  } catch {
    // The selected language remains available for the current session.
  }
}

// Keep language-sensitive styles correct on first load, reload and every switch.
i18n.on('languageChanged', (language: string) => {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
});

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: { ...zhCN, ui: uiZhCN, appearance: appearanceZhCN, analysisFlow: analysisFlowZhCN, integrations: integrationsZhCN, marketOverview: marketOverviewZhCN, council: councilZhCN, updates: updatesZhCN, strategy: strategyZhCN, settingsNav: settingsNavZhCN } },
    en: { translation: { ...en, ui: uiEn, appearance: appearanceEn, analysisFlow: analysisFlowEn, integrations: integrationsEn, marketOverview: marketOverviewEn, council: councilEn, updates: updatesEn, strategy: strategyEn, settingsNav: settingsNavEn } },
  },
  lng: detectLang(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export default i18n;
