import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useToolConnectionCopy } from '@/features/tool-connections/tool-connection-copy';
import { useWorkspaceNavigation } from '@/features/navigation/use-workspace-navigation';
import { CONNECTION_SETTINGS, isConnectionSettingsSection, visibleSettingsSections, type SettingsSection } from './settings-navigation';

export default function SettingsNavigation({ active, localWorkspace, placement }: {
  active: SettingsSection;
  localWorkspace: boolean;
  placement: 'sidebar' | 'page';
}) {
  const { t } = useTranslation();
  const toolCopy = useToolConnectionCopy();
  const location = useLocation();
  const connections = isConnectionSettingsSection(active);
  const otherSections = visibleSettingsSections(localWorkspace).filter(section => !isConnectionSettingsSection(section.id));

  const link = (section: SettingsSection) => (
    <Link
      key={section}
      to={{
        pathname: `/settings/${section}`,
        search: connections && isConnectionSettingsSection(section) ? location.search : '',
      }}
      state={connections && isConnectionSettingsSection(section) ? location.state : undefined}
      aria-current={active === section ? 'page' : undefined}
    >
      {section === 'tools' ? toolCopy.title : t(`settingsNav.sections.${section}.title`)}
    </Link>
  );

  return <div className={`settings-navigation settings-navigation-${placement}`} role="group" aria-label={t('settingsNav.navigation')}>
    <div className="settings-connection-links">{CONNECTION_SETTINGS.map(link)}</div>
    <details className="settings-more-links" key={connections ? 'connections' : 'other'} open={!connections}>
      <summary>{t('settingsNav.more')}<ChevronDown size={14} aria-hidden="true" /></summary>
      <div>{otherSections.map(section => link(section.id))}</div>
    </details>
  </div>;
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
