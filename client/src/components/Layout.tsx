/**
 * @file components/Layout.tsx
 * @description 应用级全局壳：侧栏导航、顶栏、用户菜单、主题切换与会话守卫。
 *
 * 由 `app.tsx` 以 layout 路由挂载；所有功能页面都渲染在它的 `<Outlet/>` 内。
 * 顶栏的市场状态指示器也归本组件所有。
 *
 * 鉴权：本壳要求本地已有会话（仅检查 token 是否存在；真实有效性由服务端与
 * http 401 拦截器兜底）。用户菜单通过 GET /api/auth/me 读取个人资料。
 */
import { Outlet, NavLink, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchMyProfile } from '@/api';
import { hasSession, tokenStore } from '@/api/http';
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
  X,
  Circle,
  LogOut,
} from 'lucide-react';
import { useTheme } from '../hooks/use-theme';
import { getAggregateMarketStatus, forceRefreshAllQuotes } from '../hooks/use-market-quotes';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { Mascot } from '@/components/Mascot';
import { AppearancePicker } from '@/components/AppearancePicker';

/**
 * 侧栏导航条目。`end: true` 标记 index 路由：仅在路径完全一致时激活，
 * 而不是在所有子路由上都激活。
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

/** 侧栏用户区块使用的个人资料结构。 */
interface SidebarProfile {
  id: string;
  username: string;
  displayName: string | null;
}

/**
 * 根布局组件。渲染响应式侧栏（移动端为 off-canvas 抽屉）、带页面标题 +
 * 市场状态指示器的顶栏，以及路由出口 `<Outlet/>`。无会话时重定向到 /login。
 */
function Layout() {
  const { theme, toggleTheme } = useTheme();
  const { t, i18n } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  // 设置页使用专用布局变体（由 app-shell-settings class 驱动差异化样式）。
  const inSettings =
    location.pathname === '/settings' || location.pathname.startsWith('/settings/');
  const pageScrollRef = useRef<HTMLElement>(null);
  // 语言判定：zh-CN 及其他中文变体都按中文处理。
  const zh = i18n.language.startsWith('zh');
  // 把 11 个导航项切成三组（我的投资 / 研究与实验 / 偏好设置）；分组标签按当前语言就地生成。
  const navGroups = [
    { label: zh ? '我的投资' : 'Portfolio', items: navItems.slice(0, 4) },
    { label: zh ? '研究与实验' : 'Research & lab', items: navItems.slice(4, 10) },
    { label: zh ? '偏好设置' : 'Preferences', items: navItems.slice(10) },
  ];

  // 中英互切：zh-CN <-> en。
  const toggleLang = () => {
    const next = i18n.language === 'zh-CN' ? 'en' : 'zh-CN';
    setLanguage(next);
  };

  // 路由变化时：收起移动端抽屉，并把内容区滚动位置复位到顶部。
  useEffect(() => {
    setMobileOpen(false);
    if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
  }, [location.pathname]);

  // 会话守卫：本地无 token 即重定向登录页（记录来源路径，供登录后回跳）。
  if (!hasSession()) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return (
    <div
      className={`app-shell flex w-screen overflow-hidden bg-background text-foreground ${inSettings ? 'app-shell-settings' : ''} ${location.pathname === '/council' ? 'h-dvh' : 'h-screen'}`}
    >
      {/* 侧栏 */}
      <aside
        aria-label={zh ? '主导航' : 'Main navigation'}
        className={`app-sidebar fixed inset-y-0 left-0 z-40 w-56 transform bg-sidebar text-sidebar-foreground transition-transform duration-200 md:static md:translate-x-0 ${
          mobileOpen ? 'translate-x-0 visible' : '-translate-x-full invisible md:visible'
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="app-brand flex items-center justify-between">
            <NavLink to="/" className="flex items-center gap-2.5" aria-label={t('layout.appName')}>
              <Mascot className="app-brand-mark" />
              <div className="app-brand-copy">
                <div className="app-wordmark">
                  Squabble<span className="text-[var(--brand)]">.</span>
                </div>
                <div className="app-brand-caption">BULLS. BEARS. YOU.</div>
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
                    aria-label={t(item.label)}
                    title={t(item.label)}
                    className={({ isActive }) =>
                      `app-nav-link flex items-center px-3 py-2 text-sm transition-colors ${
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                      }`
                    }
                  >
                    <item.icon size={18} />
                    <span>{t(item.label)}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>

          <div className="app-sidebar-footer border-t border-sidebar-border">
            <SidebarUserBlock />
            <div className="app-footer-actions">
              <button
                onClick={toggleTheme}
                aria-label={
                  zh ? (theme === 'dark' ? '浅色' : '深色') : theme === 'dark' ? 'Light' : 'Dark'
                }
                title={
                  zh ? (theme === 'dark' ? '浅色' : '深色') : theme === 'dark' ? 'Light' : 'Dark'
                }
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                <span>
                  {zh ? (theme === 'dark' ? '浅色' : '深色') : theme === 'dark' ? 'Light' : 'Dark'}
                </span>
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
              <LogoutButton />
            </div>
          </div>
        </div>
      </aside>

      {/* 移动端遮罩层 */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* 主内容区 */}
      <div className="app-workspace flex flex-1 flex-col overflow-hidden">
        {/* 顶栏 */}
        <header className="app-topbar flex flex-shrink-0 items-center justify-between border-b border-border">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              aria-label={zh ? '打开导航' : 'Open navigation'}
              aria-expanded={mobileOpen}
              className="shrink-0 rounded-md p-1.5 hover:bg-secondary md:hidden"
            >
              <Menu size={20} />
            </button>
            <div className="app-page-title">
              {(() => {
                const match = navItems.find((item) => {
                  if (item.end) return location.pathname === item.path;
                  return location.pathname.startsWith(item.path);
                });
                return match ? t(match.label) : t('layout.appName');
              })()}
            </div>
          </div>
          <div className="app-topbar-actions">
            <div className="app-market-status">
              <MarketStatusIndicator />
            </div>
            <AppearancePicker />
          </div>
        </header>

        {/* 页面内容 */}
        <main
          ref={pageScrollRef}
          className={
            inSettings
              ? 'app-content app-settings-content flex min-h-0 flex-1 flex-col overflow-hidden'
              : location.pathname === '/council'
                ? 'app-content flex min-h-0 flex-1 flex-col overflow-hidden safe-bottom'
                : 'app-content flex-1 overflow-y-auto safe-bottom'
          }
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * 顶栏市场状态圆点。每 30 秒轮询一次聚合市场阶段：只要有一个市场处于连续
 * 交易时段就显示"交易中"（绿色），否则显示"休市"。附带一个强制刷新行情的按钮。
 */
function MarketStatusIndicator() {
  const { t } = useTranslation();
  const [anyTrading, setAnyTrading] = useState(false);

  // 先立即检查一次，再按 30 秒节奏轮询聚合市场状态（卸载时清理定时器）。
  useEffect(() => {
    const check = () => {
      const { anyTrading: at } = getAggregateMarketStatus();
      setAnyTrading(at);
    };
    check();
    const timer = setInterval(check, 30000);
    return () => clearInterval(timer);
  }, []);

  // 状态文案与配色成对出现：交易中为成功绿，休市为弱化灰。
  const statusLabel = anyTrading ? t('layout.trading') : t('layout.closed');
  const statusColor = anyTrading ? 'text-success' : 'text-muted-foreground';

  return (
    <div className="flex items-center gap-3 text-sm">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex cursor-help items-center gap-1.5">
            <Circle size={8} className={`fill-current ${statusColor}`} />
            <span className={`${statusColor} text-xs font-medium`}>{statusLabel}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('layout.marketHours')}</TooltipContent>
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
 * 侧栏用户区块：首字母头像、显示名与用户名。
 * 通过 react-query 请求 GET /api/auth/me；加载完成前显示骨架屏。
 */
function SidebarUserBlock() {
  const { t } = useTranslation();
  const { data: profile, isLoading } = useQuery<SidebarProfile>({
    queryKey: ['auth', 'me'],
    queryFn: fetchMyProfile,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // 显示名兜底链：demo 演示账号固定本地化文案 -> displayName -> username。
  const name =
    profile?.username === 'demo' && profile.displayName === '演示用户'
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

/** 登出：清除本地会话并返回登录页。 */
function LogoutButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // 清空本地 token 与 react-query 缓存，替换式跳转回登录页（避免"后退"回到受保护页面）。
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
