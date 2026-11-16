/**
 * SettingsNavigation.tsx — 设置页双形态导航：桌面侧边栏（NavLink 分组列表）+ 移动端下拉选择。
 *
 * 职责边界：
 *  - 仅导航：按 SETTINGS_GROUPS 分组渲染全部设置分区；不渲染分区内容、不发起请求。
 *  - 桌面侧边栏与移动端下拉共用 settings-navigation 的分区/分组常量与图标表。
 * 上下游：
 *  - 上游（路由入口/谁引用）：SettingsPage 传当前分区 active。
 *  - 下游（调用哪些 hooks/api/组件）：useTranslation/useNavigate；NavLink、Select 组件族；
 *    lucide 图标；settings-navigation（SETTINGS_GROUPS/SETTINGS_SECTIONS）。
 * 关键约定：
 *  - ICONS 键必须覆盖全部 SettingsSection（类型层强制）；新增分区需同步补充图标。
 *  - 移动端 Select 的 value 即分区 id，选择后 navigate 到 /settings/<id>。
 */
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  BookOpenText,
  Bot,
  ChevronRight,
  Coins,
  Database,
  Palette,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSection } from './settings-navigation';

/** 每个设置分区对应的图标；键集合与 SETTINGS_SECTIONS 一一对应 */
const ICONS: Record<SettingsSection, LucideIcon> = {
  models: Sparkles,
  agents: Bot,
  data: Database,
  budget: Coins,
  rules: SlidersHorizontal,
  appearance: Palette,
  security: ShieldCheck,
  updates: RefreshCw,
  guide: BookOpenText,
};

export default function SettingsNavigation({ active }: { active: SettingsSection }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <>
      {/* 桌面端侧边栏：品牌区 + 分组菜单 + 底部提示 */}
      <aside className="settings-sidebar" aria-label={t('settingsNav.navigation')}>
        <div className="settings-sidebar-heading">
          <span className="settings-kicker">SQUABBLE</span>
          <p className="settings-sidebar-title">{t('ui.settings.nav')}</p>
          <p className="settings-sidebar-intro">{t('settingsNav.intro')}</p>
        </div>
        {/* 分组菜单：先按 SETTINGS_GROUPS 分组，再过滤出该组下的分区逐个渲染 NavLink */}
        <nav className="settings-menu" aria-label={t('settingsNav.navigation')}>
          {SETTINGS_GROUPS.map((group) => (
            <div className="settings-menu-group" key={group}>
              <p className="settings-group-label">{t(`settingsNav.groups.${group}`)}</p>
              {SETTINGS_SECTIONS.filter((section) => section.group === group).map((section) => {
                const Icon = ICONS[section.id];
                return (
                  <NavLink
                    key={section.id}
                    to={`/settings/${section.id}`}
                    end
                    className="settings-menu-link"
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span>{t(`settingsNav.sections.${section.id}.title`)}</span>
                    <ChevronRight size={14} className="settings-menu-arrow" aria-hidden="true" />
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        {/* 侧边栏底部说明（如数据保存位置等提示文案） */}
        <div className="settings-sidebar-note">
          <span className="settings-note-dot" aria-hidden="true" />
          {t('settingsNav.sidebarNote')}
        </div>
      </aside>

      {/* 移动端导航：单个下拉框按组展示全部分区，选中即跳转 */}
      <div className="settings-mobile-navigation">
        <Select value={active} onValueChange={(value) => navigate(`/settings/${value}`)}>
          <SelectTrigger aria-label={t('settingsNav.navigation')} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SETTINGS_GROUPS.map((group) => (
              <SelectGroup key={group}>
                <SelectLabel>{t(`settingsNav.groups.${group}`)}</SelectLabel>
                {SETTINGS_SECTIONS.filter((section) => section.group === group).map((section) => (
                  <SelectItem key={section.id} value={section.id}>
                    {t(`settingsNav.sections.${section.id}.title`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
