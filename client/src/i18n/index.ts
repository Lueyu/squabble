/**
 * @file client/src/i18n/index.ts
 * @description i18n 引导：基于 react-i18next 的 zh-CN + en 双语资源包。
 *
 * 语言偏好持久化在 localStorage（'sq-lang'），缺省跟随浏览器首选语言。
 * 语言切换入口在侧边栏（Layout）。
 *
 * 职责边界：
 *  - 只做 i18next 初始化与语言切换；翻译资源本体在各 JSON 文件
 * 上下游：
 *  - 上游（谁调用这里）：app 入口引入本模块完成初始化；切换语言调用 setLanguage
 *  - 下游（本文件调用谁）：i18next / react-i18next、本目录下 13 组 JSON 资源
 * 关键约定：
 *  - interpolation.escapeValue: false —— React 已自带转义，i18next 不再重复转义
 *  - react.useSuspense: false —— 避免 Suspense 边界外的加载闪烁
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
// 基础通用文案。
import zhCN from './zh-CN.json';
import en from './en.json';
// UI 骨架文案。
import uiZhCN from './ui.zh-CN.json';
import uiEn from './ui.en.json';
// 外观/主题文案。
import appearanceZhCN from './appearance.zh-CN.json';
import appearanceEn from './appearance.en.json';
// 分析流程文案。
import analysisFlowZhCN from './analysis-flow.zh-CN.json';
import analysisFlowEn from './analysis-flow.en.json';
// 集成默认值文案。
import integrationsZhCN from './integration-defaults.zh-CN.json';
import integrationsEn from './integration-defaults.en.json';
// 行情总览文案。
import marketOverviewZhCN from './market.zh-CN.json';
import marketOverviewEn from './market.en.json';
// Council 文案。
import councilZhCN from './council.zh-CN.json';
import councilEn from './council.en.json';
// 更新提示文案。
import updatesZhCN from './updates.zh-CN.json';
import updatesEn from './updates.en.json';
// 设置页导航文案。
import settingsNavZhCN from './settings-nav.zh-CN.json';
import settingsNavEn from './settings-nav.en.json';

/** 支持的语言清单。 */
export const SUPPORTED_LANGS = ['zh-CN', 'en'] as const;
export type AppLang = (typeof SUPPORTED_LANGS)[number];

/** 语言偏好在 localStorage 里的键。 */
const LANG_KEY = 'sq-lang';

/**
 * 探测初始语言：localStorage 存储 → 浏览器语言 → 兜底 zh-CN。
 */
function detectLang(): AppLang {
  // SSR / 非 browser 环境直接中文。
  if (typeof window === 'undefined') return 'zh-CN';
  try {
    // 步骤 1：先读持久化的偏好。
    const stored = window.localStorage.getItem(LANG_KEY);
    if (stored === 'en' || stored === 'zh-CN') return stored;
  } catch {
    // 浏览器隐私设置可能禁用存储；语言探测继续走浏览器语言。
  }
  // 步骤 2：跟随浏览器首选语言。
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('en')) return 'en';
  // 步骤 3：兜底中文。
  return 'zh-CN';
}

/**
 * 切换语言（同步持久化）。
 * 同时更新 <html lang>，便于无障碍与字体渲染。
 */
export function setLanguage(lang: AppLang): void {
  // 步骤 1：切换 i18next 运行时语言。
  i18n.changeLanguage(lang);
  try {
    // 步骤 2：持久化偏好；失败（隐私模式）只影响下次启动的记忆。
    window.localStorage.setItem(LANG_KEY, lang);
  } catch {
    // 所选语言在当前会话内仍然可用。
  }
  // 步骤 3：同步文档语言属性。
  document.documentElement.lang = lang;
}

// 初始化 i18next：合并全部 JSON 资源包进 translation 命名空间。
i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': {
      translation: {
        ...zhCN,
        ui: uiZhCN,
        appearance: appearanceZhCN,
        analysisFlow: analysisFlowZhCN,
        integrations: integrationsZhCN,
        marketOverview: marketOverviewZhCN,
        council: councilZhCN,
        updates: updatesZhCN,
        settingsNav: settingsNavZhCN,
      },
    },
    en: {
      translation: {
        ...en,
        ui: uiEn,
        appearance: appearanceEn,
        analysisFlow: analysisFlowEn,
        integrations: integrationsEn,
        marketOverview: marketOverviewEn,
        council: councilEn,
        updates: updatesEn,
        settingsNav: settingsNavEn,
      },
    },
  },
  // 初始语言按存储→浏览器→zh-CN 探测；缺失键回退中文。
  lng: detectLang(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export default i18n;
