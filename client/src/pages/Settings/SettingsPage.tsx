import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowUpRight, BookOpenText, LockKeyhole } from 'lucide-react';
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
import { resolveSettingsSection, SETTINGS_SECTIONS, type SettingsSection } from './settings-navigation';
import './settings.css';

export default function SettingsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const localWorkspace = getAuthMode() === 'local';
  const requestedSection = resolveSettingsSection(location.pathname, location.hash);
  const active = localWorkspace && requestedSection === 'security' ? 'models' : requestedSection;
  const sections = SETTINGS_SECTIONS.filter(section => !localWorkspace || section.id !== 'security');
  const [visited, setVisited] = useState<SettingsSection[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const previousSection = useRef(active);

  useEffect(() => {
    if (active && location.pathname !== `/settings/${active}`) {
      // Keep the panel tree mounted while normalizing an old entry URL.
      navigate({ pathname: `/settings/${active}`, search: location.search }, { replace: true });
    }
  }, [active, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (!active) return;
    setVisited(current => current.includes(active) ? current : [...current, active]);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (previousSection.current !== active) titleRef.current?.focus({ preventScroll: true });
    previousSection.current = active;
  }, [active]);

  if (!active) return <NotFound />;
  const group = SETTINGS_SECTIONS.find(section => section.id === active)!.group;
  return <div className="settings-shell">
    <SettingsNavigation active={active} />
    <div ref={scrollRef} className="settings-content">
      <div className="settings-content-inner">
        <header className="settings-page-heading">
          <div className="min-w-0">
            <p className="settings-kicker">{t(`settingsNav.groups.${group}`)}</p>
            <h1 ref={titleRef} tabIndex={-1} className="settings-page-title" id="settings-page-title">
              {t(`settingsNav.sections.${active}.title`)}
            </h1>
            <p className="settings-page-description">{t(`settingsNav.sections.${active}.description`)}</p>
          </div>
          {active !== 'guide' && <Button asChild variant="ghost" size="sm" className="settings-help-link">
            <Link to="/settings/guide"><BookOpenText />{t('settingsNav.help')}<ArrowUpRight /></Link>
          </Button>}
        </header>

        {sections.filter(section => section.id === active || visited.includes(section.id)).map(section =>
          <div key={section.id} hidden={active !== section.id} className="settings-panel"
            role="region" aria-label={t(`settingsNav.sections.${section.id}.title`)}>
            <SettingsSectionContent section={section.id} active={active === section.id} />
          </div>)}
      </div>
    </div>
  </div>;
}

function SettingsSectionContent({ section, active }: { section: SettingsSection; active: boolean }) {
  const { t } = useTranslation();
  switch (section) {
    case 'models': return <div className="space-y-6">
      <ModelConnectionsPanel active={active} />
      <IntegrationSettingsPanel section="models" active={active} />
    </div>;
    case 'agents': return <div className="space-y-6"><LocalAgentsPanel /><ResearchMemorySettings /></div>;
    case 'data': return <IntegrationSettingsPanel section="data" active={active} />;
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
