/**
 * @file components/Layout.tsx
 * @description App-level shell: sidebar navigation, top bar, user menu, theme
 * toggle and the session guard.
 *
 * Mounted as the layout route in `app.tsx`; every feature page renders inside
 * its `<Outlet/>`. Also owns the market-status indicator shown in the top bar.
 *
 * Auth: account mode requires a stored session; local mode opens the workspace
 * directly. The account-mode user menu reads GET /api/auth/me.
 */
import { Outlet, NavLink, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchMyProfile } from '@/api';
import { hasSession, tokenStore } from '@/api/http';
import { getAuthMode } from '@/api/auth-mode';
import { setLanguage } from '@/i18n';
import {
  FlaskConical,
  Bot,
  Users,
  Upload,
  Languages,
  LayoutDashboard,
  Briefcase,
  Eye,
  BarChart3,
  BookOpen,
  Receipt,
  Settings,
  Sun,
  Moon,
  RefreshCw,
  Menu,
  Monitor,
  X,
  Circle,
  LogOut,
  Database,
  Brain,
  Bell,
} from 'lucide-react';
import { useTheme } from '../hooks/use-theme';
import { getAggregateMarketStatus, forceRefreshAllQuotes } from '../hooks/use-market-quotes';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { Mascot } from '@/components/Mascot';
import { AppearancePicker } from '@/components/AppearancePicker';
import { useSimpleExperience } from '@/hooks/use-simple-experience';
import { workspaceSections, resolveWorkspaceRoute } from '@/features/navigation/workspace-navigation';
import { useWorkspaceNavigation } from '@/features/navigation/use-workspace-navigation';
import { WorkspaceNavigationBar, WorkspaceSectionTabs } from '@/features/navigation/WorkspaceNavigationBar';
import { WorkspaceSearch } from '@/features/navigation/WorkspaceSearch';

/**
 * Sidebar navigation entries. `end: true` marks the index route so it is only
 * active on the exact path rather than on every child route.
 */
const navItems = [
  { path: '/', label: 'nav.dashboard', icon: LayoutDashboard, end: true },
  { path: '/holdings', label: 'nav.holdings', icon: Briefcase },
  { path: '/import', label: 'nav.import', icon: Upload },
  { path: '/watchlist', label: 'nav.watchlist', icon: Eye },
  { path: '/analysis', label: 'nav.analysis', icon: BarChart3 },
  { path: '/paper', label: 'nav.paper', icon: FlaskConical },
  { path: '/agent-builder', label: 'ui.builder.nav', icon: Bot },
  { path: '/council', label: 'council.nav', icon: Users },
  { path: '/journal', label: 'nav.journal', icon: BookOpen },
  { path: '/transactions', label: 'nav.transactions', icon: Receipt },
  { path: '/settings', label: 'ui.settings.nav', icon: Settings },
];

/** Profile shape used by the sidebar user block. */
interface SidebarProfile {
  id: string;
  username: string;
  displayName: string | null;
}

/**
 * Root layout component. Renders the responsive sidebar (off-canvas on
 * mobile), top bar with page title + market indicator, and the routed
 * `<Outlet/>`. Redirects to /login when no session exists.
 */
function Layout() {
  const localWorkspace = getAuthMode() === 'local';
  const { theme, toggleTheme } = useTheme();
  const { t, i18n } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const inSettings = location.pathname === '/settings' || location.pathname.startsWith('/settings/');
  const pageScrollRef = useRef<HTMLElement>(null);
  const zh = i18n.language.startsWith('zh');
  const { enabled: simple } = useSimpleExperience();
  const sectionIcons = { overview: LayoutDashboard, friends: Users, daily: BookOpen, research: FlaskConical, assets: Briefcase, data: Database, memory: Brain, settings: Settings };
  const simpleItems = simple ? workspaceSections(i18n.language).map(item => ({ ...item, icon: sectionIcons[item.id], literal: true })) : [];
  const allItems = simple ? simpleItems : navItems;
  const currentRoute = resolveWorkspaceRoute(location.pathname, i18n.language);
  const focusedFlow = simple && currentRoute.kind === 'flow';
  useWorkspaceNavigation(inSettings ? undefined : pageScrollRef);
  const navGroups = simple ? [
    { label: zh ? '日常' : 'Every day', items: simpleItems.filter(item => item.group === 'daily') },
    { label: zh ? '工作区' : 'Workspace', items: simpleItems.filter(item => item.group === 'workspace') },
  ] : [
    { label: zh ? '我的投资' : 'Portfolio', items: navItems.slice(0, 4) },
    { label: zh ? '研究与实验' : 'Research & lab', items: navItems.slice(4, 10) },
    { label: zh ? '偏好设置' : 'Preferences', items: navItems.slice(10) },
  ];

  const toggleLang = () => {
    const next = i18n.language === 'zh-CN' ? 'en' : 'zh-CN';
    setLanguage(next);
  };

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  if (!hasSession()) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return (
    <div className={`app-shell ${simple ? 'app-shell-simple' : ''} flex w-screen overflow-hidden bg-background text-foreground ${inSettings ? 'app-shell-settings' : ''} ${location.pathname === '/council' ? 'h-dvh' : 'h-screen'}`}>
      {/* Sidebar */}
      <aside
        aria-label={zh ? '主导航' : 'Main navigation'}
        className={`app-sidebar fixed inset-y-0 left-0 z-40 w-56 transform bg-sidebar text-sidebar-foreground transition-transform duration-200 md:static md:translate-x-0 ${
          mobileOpen ? 'translate-x-0 visible' : '-translate-x-full invisible md:visible'
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="app-brand flex items-center justify-between">
            <NavLink to="/" className="flex items-center gap-2.5" aria-label={t('layout.appName')}>
              {!simple && <Mascot className="app-brand-mark" />}
              <div className="app-brand-copy">
                <div className="app-wordmark">{simple ? 'squabble' : 'Squabble'}<span className="text-[var(--brand)]">.</span></div>
                <div className="app-brand-caption">{simple ? (zh ? '一群股友，陪你验证想法' : 'Companions to test your ideas.') : 'BULLS. BEARS. YOU.'}</div>
              </div>
            </NavLink>
            <button
              onClick={() => setMobileOpen(false)}
              aria-label={zh ? '关闭导航' : 'Close navigation'}
              className="rounded-md p-1 hover:bg-sidebar-accent md:hidden"
            >
              <X size={18} />
            </button>
          </div>

          <nav className="app-nav min-h-0 flex-1 overflow-y-auto">
            {navGroups.map((group) => (
              <div key={group.label} className="app-nav-group">
                <div className="app-nav-label">{group.label}</div>
                {group.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.end}
                aria-label={'literal' in item ? item.label : t(item.label)}
                title={'literal' in item ? item.label : t(item.label)}
                className={({ isActive }) =>
                  `app-nav-link flex items-center px-3 py-2 text-sm transition-colors ${
                    (simple && 'id' in item ? item.id === currentRoute.section : isActive)
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                  }`
                }
              >
                <item.icon size={18} />
                <span>{'literal' in item ? item.label : t(item.label)}</span>
              </NavLink>
                ))}
              </div>
            ))}
          </nav>

          <div className="app-sidebar-footer border-t border-sidebar-border">
            {localWorkspace ? <div className="app-user-block flex items-center gap-2.5 rounded-md px-2 py-1.5"
              title={t('layout.localWorkspace')}>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground">
                <Monitor size={18} aria-hidden="true" />
              </div>
              <span className="app-user-copy min-w-0 truncate text-sm text-sidebar-foreground/80" aria-hidden="true">{t('layout.localWorkspace')}</span>
              <span className="sr-only">{t('layout.localWorkspace')}</span>
            </div> : <SidebarUserBlock />}
            <div className="app-footer-actions">
            <button
              onClick={toggleTheme}
              aria-label={zh ? (theme === 'dark' ? '浅色' : '深色') : (theme === 'dark' ? 'Light' : 'Dark')}
              title={zh ? (theme === 'dark' ? '浅色' : '深色') : (theme === 'dark' ? 'Light' : 'Dark')}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              <span>{zh ? (theme === 'dark' ? '浅色' : '深色') : (theme === 'dark' ? 'Light' : 'Dark')}</span>
            </button>
            <button
              onClick={toggleLang}
              aria-label={i18n.language === 'zh-CN' ? 'English' : '中文'}
              title={i18n.language === 'zh-CN' ? 'English' : '中文'}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            >
              <Languages size={18} />
              <span>{i18n.language === 'zh-CN' ? 'English' : '中文'}</span>
            </button>
            {!localWorkspace && <LogoutButton />}
            {simple && <AppearancePicker />}
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Main content */}
      <div className="app-workspace flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className={`app-topbar ${focusedFlow ? 'app-topbar-flow' : ''} flex flex-shrink-0 items-center justify-between border-b border-border`}>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              aria-label={zh ? '打开导航' : 'Open navigation'}
              aria-expanded={mobileOpen}
              className="shrink-0 rounded-md p-1.5 hover:bg-secondary md:hidden"
            >
              <Menu size={20} />
            </button>
            {simple ? <WorkspaceNavigationBar /> : <div className="app-page-title">
              {(() => {
                const match = allItems.find((item) => {
                  if (item.end) return location.pathname === item.path;
                  return location.pathname.startsWith(item.path);
                });
                return match ? ('literal' in match ? match.label : t(match.label)) : t('layout.appName');
              })()}
            </div>}
          </div>
          {!focusedFlow && <div className="app-topbar-actions">
            {simple && <><WorkspaceSearch /><NavLink to="/settings/notifications" className="workspace-alert-link" aria-label={zh ? '提醒与通知渠道' : 'Alerts and notification channels'}><Bell size={17} /></NavLink></>}
            <div className="app-market-status"><MarketStatusIndicator simple={simple} /></div>
            <AppearancePicker />
          </div>}
        </header>

        {/* Page content */}
        <main ref={pageScrollRef} className={inSettings
          ? 'app-content app-settings-content flex min-h-0 flex-1 flex-col overflow-hidden'
          : location.pathname === '/council'
          ? 'app-content app-council-content app-channel-content flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden safe-bottom'
          : 'app-content flex-1 overflow-y-auto safe-bottom'}>
          {simple && <WorkspaceSectionTabs />}
          <Outlet />
        </main>
        {simple && !focusedFlow && <nav className="portfolio-mobile-nav" aria-label={zh ? '快捷导航' : 'Quick navigation'}>
          {simpleItems.filter(item => ['overview', 'friends', 'daily', 'memory'].includes(item.id)).map(item => <NavLink key={item.path} to={item.path} end={item.end} className={item.id === currentRoute.section ? 'active' : undefined}><item.icon size={18} /><span>{item.label}</span></NavLink>)}
          <button type="button" onClick={() => setMobileOpen(true)} aria-expanded={mobileOpen}><Menu size={18} /><span>{zh ? '更多' : 'More'}</span></button>
        </nav>}
      </div>
    </div>
  );
}

/**
 * Top-bar market status dot. Polls the aggregate market phase every 30s and
 * shows "交易中" (green) when at least one market is in continuous trading,
 * otherwise "休市". Also exposes a refresh button that forces a quote refetch.
 */
function MarketStatusIndicator({simple=false}:{simple?:boolean}) {
  const { t,i18n } = useTranslation();
  const [anyTrading, setAnyTrading] = useState(false);

  useEffect(() => {
    const check = () => {
      const { anyTrading: at } = getAggregateMarketStatus();
      setAnyTrading(at);
    };
    check();
    const timer = setInterval(check, 30000);
    return () => clearInterval(timer);
  }, []);

  const statusLabel = simple ? (i18n.language.startsWith('zh') ? (anyTrading?'市场开市':'市场休市') : (anyTrading?'Market open':'Markets closed')) : anyTrading ? t('layout.trading') : t('layout.closed');
  const statusColor = anyTrading ? 'text-success' : 'text-muted-foreground';

  return (
    <div className="flex items-center gap-3 text-sm">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex cursor-help items-center gap-1.5">
            <Circle size={8} className={`fill-current ${statusColor}`} />
            <span className={`${statusColor} text-xs font-medium`}>
              {statusLabel}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('layout.marketHours')}
        </TooltipContent>
      </Tooltip>
      <button
        className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        title={t('layout.refreshQuotes')}
        onClick={() => forceRefreshAllQuotes()}
      >
        <RefreshCw size={16} />
      </button>
    </div>
  );
}

/**
 * Sidebar user block: avatar with initial, display name and username.
 * Fetches GET /api/auth/me (react-query); shows skeletons until resolved.
 */
function SidebarUserBlock() {
  const { t } = useTranslation();
  const { data: profile, isLoading } = useQuery<SidebarProfile>({
    queryKey: ['auth', 'me'],
    queryFn: fetchMyProfile,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const name = profile?.username === 'demo' && profile.displayName === '演示用户'
    ? t('layout.demoUser')
    : profile?.displayName || profile?.username || '';
  const initial = name ? name.charAt(0).toUpperCase() : '?';

  return (
    <div className="app-user-block flex items-center gap-2.5 rounded-md px-2 py-1.5" title={name}>
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-accent text-sm font-semibold text-sidebar-accent-foreground">
        {isLoading ? <Skeleton className="h-8 w-8 rounded-full" /> : initial}
      </div>
      <div className="app-user-copy min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-sidebar-foreground">
          {isLoading ? <Skeleton className="h-4 w-16" /> : name || t('layout.unknownUser')}
        </div>
        <div className="truncate text-xs text-sidebar-foreground/50">
          {isLoading ? <Skeleton className="mt-1 h-3 w-12" /> : `@${profile?.username ?? ''}`}
        </div>
      </div>
    </div>
  );
}

/** Sign out: drop the local session and return to the login page. */
function LogoutButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const handleLogout = () => {
    tokenStore.clear();
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  return (
    <button
      onClick={handleLogout}
      title={t('layout.logout')}
      className="app-logout flex items-center justify-center rounded-md text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
    >
      <LogOut size={18} />
      <span className="sr-only">{t('layout.logout')}</span>
    </button>
  );
}

export default Layout;
