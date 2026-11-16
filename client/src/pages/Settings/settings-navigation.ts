/**
 * settings-navigation.ts — 设置页分区路由的纯函数模块：分区清单、分组常量与 URL 解析。
 *
 * 职责边界：
 *  - 定义全部设置分区（SETTINGS_SECTIONS）与分组（SETTINGS_GROUPS），并把
 *    "/settings[/xxx][#hash]" 解析成分区 id；不涉及组件渲染与数据请求。
 * 上下游：
 *  - 上游（路由入口/谁引用）：SettingsPage、SettingsNavigation 消费本模块；
 *    client/src/utils/settings-navigation.test.cjs 全文转译执行本文件做断言。
 *  - 下游（调用哪些 hooks/api/组件）：无依赖，纯函数。
 * 关键约定：
 *  - resolveSettingsSection 返回 null 表示"未知路由"，调用方（SettingsPage）据此跳转 404，
 *    不做静默兜底。
 *  - '#research-budget'、'#local-agents' 是旧单页设置屏遗留书签，必须继续映射到
 *    budget / agents 分区（保持旧链接可用）。
 */

/** 全部设置分区：id 即路由段，group 用于导航分组展示 */
export const SETTINGS_SECTIONS = [
  { id: 'models', group: 'research' },
  { id: 'agents', group: 'research' },
  { id: 'data', group: 'research' },
  { id: 'budget', group: 'research' },
  { id: 'rules', group: 'research' },
  { id: 'appearance', group: 'personal' },
  { id: 'security', group: 'personal' },
  { id: 'updates', group: 'personal' },
  { id: 'guide', group: 'help' },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];
export const SETTINGS_GROUPS = ['research', 'personal', 'help'] as const;

/** 解析设置页 URL（/settings[/分区][#hash]）为分区 id；尾斜杠容忍，未知路由返回 null。 */
export function resolveSettingsSection(pathname: string, hash = ''): SettingsSection | null {
  // 去掉末尾连续斜杠，统一路径形态
  const path = pathname.replace(/\/+$/u, '');
  if (path === '/settings') {
    // 旧版单页设置屏的书签锚点继续生效
    if (hash === '#research-budget') return 'budget';
    if (hash === '#local-agents') return 'agents';
    return 'models';
  }
  // 显式分区路由：精确匹配分区 id，/settings/models/extra 这类多级路径不通过
  return SETTINGS_SECTIONS.find((section) => path === `/settings/${section.id}`)?.id ?? null;
}
