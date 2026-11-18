import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, LockKeyhole } from 'lucide-react';
import { AppearanceControls } from '@/components/AppearancePicker';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { setLanguage } from '@/i18n';
import { getAuthMode } from '@/api/auth-mode';
import NotFound from '@/pages/NotFound/NotFound';
import StrategyRulesPage from '@/pages/StrategyRules/StrategyRulesPage';
import BudgetPanel from './BudgetPanel';
import ResearchMemorySettings from './ResearchMemorySettings';
import IntegrationSettingsPanel from './IntegrationSettingsPanel';
import LocalAgentsPanel from './LocalAgentsPanel';
import ModelConnectionsPanel from './ModelConnectionsPanel';
import { RecoveryCodeCard } from './RecoveryCodeCard';
import SettingsGuide from './SettingsGuide';
import SettingsNavigation from './SettingsNavigation';
import SystemUpdateCard from './SystemUpdateCard';
import ResearchParticipantsPanel from './ResearchParticipantsPanel';
import { useSimpleExperience } from '@/hooks/use-simple-experience';
import { isConnectionSettingsSection, resolveSettingsSection, visibleSettingsSections, type SettingsSection } from './settings-navigation';
import './settings.css';
import { OnboardingConnectionStep } from '@/features/onboarding/OnboardingConnectionStep';
import { NotificationChannelsCard, AgentSessionsCard } from '@/features/integrations/PaperIntegrationPanels';
import { useWorkspaceNavigation } from '@/features/navigation/use-workspace-navigation';
import ToolConnectionsPanel from '@/features/tool-connections/ToolConnectionsPanel';
import { useToolConnectionCopy } from '@/features/tool-connections/tool-connection-copy';

export default function SettingsPage() {
  const { t } = useTranslation();
  const toolCopy = useToolConnectionCopy();
  const location = useLocation();
  const navigate = useNavigate();
  const localWorkspace = getAuthMode() === 'local';
  const active = resolveSettingsSection(location.pathname, location.hash, localWorkspace);
  const sections = visibleSettingsSections(localWorkspace);
  const [visited, setVisited] = useState<SettingsSection[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useWorkspaceNavigation(scrollRef);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const previousSection = useRef(active);

  useEffect(() => {
    if (active && location.pathname !== `/settings/${active}`) {
      // Keep the panel tree mounted while normalizing an old entry URL.
      navigate({ pathname: `/settings/${active}`, search: location.search, hash: location.hash }, { replace: true, state: location.state });
    }
  }, [active, location.pathname, location.search, location.hash, location.state, navigate]);

  useEffect(() => {
    if (!active) return;
    setVisited(current => current.includes(active) ? current : [...current, active]);
    if (previousSection.current !== active) titleRef.current?.focus({ preventScroll: true });
    previousSection.current = active;
  }, [active]);

  if (!active) return <NotFound />;
  const connectionPage = isConnectionSettingsSection(active);
  const onboarding = connectionPage && new URLSearchParams(location.search).get('onboarding') === '1';
  const navigation = <SettingsNavigation active={active} localWorkspace={localWorkspace} placement="page" />;
  return <div className="settings-shell">
    <div ref={scrollRef} className="settings-content">
      <div className="settings-content-inner">
        {!onboarding && <><header className="settings-page-heading">
          <h1 ref={titleRef} tabIndex={-1} className="settings-page-title" id="settings-page-title">
            {connectionPage ? t('settingsNav.connectionTitle') : active === 'tools' ? toolCopy.title : t(`settingsNav.sections.${active}.title`)}
          </h1>
          <p className="settings-page-description">
            {connectionPage ? t('settingsNav.connectionDescription') : active === 'tools' ? toolCopy.description : t(`settingsNav.sections.${active}.description`)}
          </p>
        </header>
        {navigation}</>}

        {sections.filter(section => section.id === active || visited.includes(section.id)).map(section =>
          <div key={section.id} hidden={active !== section.id} className="settings-panel"
            role="region" aria-label={section.id === 'tools' ? toolCopy.title : t(`settingsNav.sections.${section.id}.title`)}>
            {onboarding && active === section.id
              ? <OnboardingConnectionStep navigation={navigation} headingRef={titleRef}>{section.id === 'agents' ? <LocalAgentsPanel /> : <ModelConnectionsPanel />}</OnboardingConnectionStep>
              : <SettingsSectionContent section={section.id} active={active === section.id} />}
          </div>)}
      </div>
    </div>
  </div>;
}

function SettingsSectionContent({ section, active }: { section: SettingsSection; active: boolean }) {
  const { t } = useTranslation();
  const { enabled: simple } = useSimpleExperience();
  switch (section) {
    case 'notifications': return <NotificationChannelsCard active={active} />;
    case 'mcp': return <div className="space-y-4"><Button asChild variant="outline"><Link to="/settings/tools"><ToolConnectionLinkLabel /></Link></Button><AgentSessionsCard active={active} /></div>;
    case 'tools': return <ToolConnectionsPanel active={active} />;
    case 'models': return <div className="space-y-6">
      <ModelConnectionsPanel active={active} />
      <details className="settings-panel-details">
        <summary>{t('settingsNav.additionalModels')}<ChevronRight size={16} aria-hidden="true" /></summary>
        <IntegrationSettingsPanel section="models" active={active} />
      </details>
    </div>;
    case 'agents': return <div className="space-y-6">
      <LocalAgentsPanel />
      <details className="settings-panel-details">
        <summary>{t('settingsNav.additionalAgents')}<ChevronRight size={16} aria-hidden="true" /></summary>
        <div className="space-y-4">{simple && <ResearchParticipantsPanel />}<ResearchMemorySettings /></div>
      </details>
    </div>;
    case 'budget': return <BudgetPanel />;
    case 'rules': return <StrategyRulesPage embedded active={active} />;
    case 'appearance': return <AppearancePanel active={active} />;
    case 'security': return <div className="space-y-5">
      <RecoveryCodeCard />
      <div className="settings-privacy-note"><LockKeyhole size={18} aria-hidden="true" />
        <p>{t('ui.settings.privacyNote')}</p>
      </div>
    </div>;
    case 'updates': return <SystemUpdateCard />;
    case 'guide': return <SettingsGuide />;
  }
}

function ToolConnectionLinkLabel() { return <>{useToolConnectionCopy().toolsDirection}</>; }

function AppearancePanel({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation();
  const [languageOpen, setLanguageOpen] = useState(false);
  return <div className="space-y-6">
    <Card><CardContent className="settings-appearance-controls"><AppearanceControls /></CardContent></Card>
    <Card><CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
      <div><h2 className="font-semibold">{t('settingsNav.language')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('settingsNav.languageHint')}</p></div>
      <Select open={active && languageOpen} onOpenChange={setLanguageOpen}
        value={i18n.language.startsWith('zh') ? 'zh-CN' : 'en'} onValueChange={value => {
        if (value === 'zh-CN' || value === 'en') setLanguage(value);
      }}>
        <SelectTrigger className="w-40" aria-label={t('settingsNav.language')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="zh-CN">简体中文</SelectItem><SelectItem value="en">English</SelectItem></SelectContent>
      </Select>
    </CardContent></Card>
  </div>;
}
