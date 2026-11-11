import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  BookOpenText, Bot, ChevronRight, Coins, Palette, RefreshCw,
  ShieldCheck, SlidersHorizontal, Sparkles, Bell, Plug, type LucideIcon,
} from 'lucide-react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSection } from './settings-navigation';
import { getAuthMode } from '@/api/auth-mode';
import { useToolConnectionCopy } from '@/features/tool-connections/tool-connection-copy';

const ICONS: Record<SettingsSection, LucideIcon> = {
  models: Sparkles, agents: Bot, budget: Coins, rules: SlidersHorizontal,
  appearance: Palette, security: ShieldCheck, updates: RefreshCw, guide: BookOpenText,
  notifications: Bell, mcp: Plug, tools: Plug,
};

export default function SettingsNavigation({ active }: { active: SettingsSection }) {
  const { t } = useTranslation();
  const toolCopy = useToolConnectionCopy();
  const navigate = useNavigate();
  const sections = SETTINGS_SECTIONS.filter(section => getAuthMode() !== 'local' || section.id !== 'security');

  return <>
    <aside className="settings-sidebar" aria-label={t('settingsNav.navigation')}>
      <div className="settings-sidebar-heading">
        <span className="settings-kicker">SQUABBLE</span>
        <p className="settings-sidebar-title">{t('ui.settings.nav')}</p>
        <p className="settings-sidebar-intro">{t('settingsNav.intro')}</p>
      </div>
      <nav className="settings-menu" aria-label={t('settingsNav.navigation')}>
        {SETTINGS_GROUPS.map(group => <div className="settings-menu-group" key={group}>
          <p className="settings-group-label">{t(`settingsNav.groups.${group}`)}</p>
          {sections.filter(section => section.group === group).map(section => {
            const Icon = ICONS[section.id];
            return <NavLink key={section.id} to={`/settings/${section.id}`} end
              className="settings-menu-link">
              <Icon size={18} aria-hidden="true" />
              <span>{section.id === 'tools' ? toolCopy.title : t(`settingsNav.sections.${section.id}.title`)}</span>
              <ChevronRight size={14} className="settings-menu-arrow" aria-hidden="true" />
            </NavLink>;
          })}
        </div>)}
      </nav>
      <div className="settings-sidebar-note">
        <span className="settings-note-dot" aria-hidden="true" />
        {t('settingsNav.sidebarNote')}
      </div>
    </aside>

    <div className="settings-mobile-navigation">
      <Select value={active} onValueChange={value => navigate(`/settings/${value}`)}>
        <SelectTrigger aria-label={t('settingsNav.navigation')} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SETTINGS_GROUPS.map(group => <SelectGroup key={group}>
            <SelectLabel>{t(`settingsNav.groups.${group}`)}</SelectLabel>
            {sections.filter(section => section.group === group).map(section =>
              <SelectItem key={section.id} value={section.id}>
                {section.id === 'tools' ? toolCopy.title : t(`settingsNav.sections.${section.id}.title`)}
              </SelectItem>)}
          </SelectGroup>)}
        </SelectContent>
      </Select>
    </div>
  </>;
}
