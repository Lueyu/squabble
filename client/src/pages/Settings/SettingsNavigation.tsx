import { useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useToolConnectionCopy } from '@/features/tool-connections/tool-connection-copy';
import { useWorkspaceNavigation } from '@/features/navigation/use-workspace-navigation';
import { isConnectionSettingsSection, visibleSettingsSections, type SettingsSection } from './settings-navigation';

export default function SettingsNavigation({ active, localWorkspace, placement }: {
  active: SettingsSection;
  localWorkspace: boolean;
  placement: 'rail' | 'page';
}) {
  const { t } = useTranslation();
  const toolCopy = useToolConnectionCopy();
  const location = useLocation();
  const connections = isConnectionSettingsSection(active);
  const sections = visibleSettingsSections(localWorkspace);
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const label = (section: SettingsSection) => section === 'tools' ? toolCopy.title : t(`settingsNav.sections.${section}.title`);

  const link = (section: SettingsSection) => (
    <Link
      key={section}
      to={{
        pathname: `/settings/${section}`,
        search: connections && isConnectionSettingsSection(section) ? location.search : '',
      }}
      state={connections && isConnectionSettingsSection(section) ? location.state : undefined}
      onClick={() => setOpen(false)}
      aria-current={active === section ? 'page' : undefined}
    >
      {label(section)}
    </Link>
  );

  return <nav className={`settings-navigation settings-navigation-${placement}`} aria-label={t('settingsNav.navigation')}
    onKeyDown={event => {
      if (placement === 'page' && open && event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        toggleRef.current?.focus();
      }
    }}>
    {placement === 'page'
      ? <button ref={toggleRef} type="button" className="settings-category-toggle"
          aria-expanded={open} aria-controls="settings-category-menu" onClick={() => setOpen(value => !value)}>
          <span>{t('settingsNav.category')}</span><strong>{label(active)}</strong><ChevronDown size={16} aria-hidden="true" />
        </button>
      : <h2 className="settings-category-title">{t('settingsNav.category')}</h2>}
    <div id={placement === 'page' ? 'settings-category-menu' : undefined} hidden={placement === 'page' && !open}
      className="settings-category-list">
      {(['research', 'personal', 'help'] as const).map(group => <div className="settings-category-group" key={group}>
        <h3>{t(`settingsNav.groups.${group}`)}</h3>
        {sections.filter(section => section.group === group).map(section => link(section.id))}
      </div>)}
    </div>
  </nav>;
}

export function SettingsLocation({ active }: { active: SettingsSection }) {
  const { t } = useTranslation();
  const toolCopy = useToolConnectionCopy();
  const { goBack } = useWorkspaceNavigation();
  return <div className="workspace-return-location">
    <Button type="button" variant="outline" size="sm" aria-label={t('settingsNav.back')}
      onClick={() => goBack(active === 'models' ? '/' : '/settings/models')}>
      <ArrowLeft size={15} /><span className="hidden sm:inline">{t('settingsNav.back')}</span>
    </Button>
    <span className="workspace-location">
      <span className="hidden lg:inline">{t('settingsNav.title')}</span>
      <ChevronRight className="hidden shrink-0 lg:block" size={13} aria-hidden="true" />
      <span className="min-w-0 truncate">{active === 'tools' ? toolCopy.title : t(`settingsNav.sections.${active}.title`)}</span>
    </span>
  </div>;
}
