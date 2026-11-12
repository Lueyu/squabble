import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  resolveWorkspaceRoute,
  workspaceSections,
} from './workspace-navigation';
import { assetHref } from '@/features/assets/account-context';
import { useWorkspaceNavigation } from './use-workspace-navigation';

export function WorkspaceNavigationBar() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const location = useLocation();
  const route = resolveWorkspaceRoute(location.pathname, i18n.language);
  const section = workspaceSections(i18n.language).find(
    (item) => item.id === route.section,
  ) ?? { label: route.section === 'daily' ? (zh ? '投资日报' : 'Daily report') : route.title };
  const { goBack } = useWorkspaceNavigation();
  const accountId = new URLSearchParams(location.search).get('accountId') ?? 'real';
  const parent = route.section === 'assets' ? assetHref(route.parent, accountId) : route.parent;
  if (route.kind === 'flow')
    return (
      <div id="workspace-flow-controls" className="workspace-flow-controls">
        <Button
          asChild
          variant="outline"
          size="sm"
          className="workspace-flow-fallback"
        >
          <Link to={parent}>
            <ArrowLeft size={15} />
            {zh ? '返回策略库' : 'Back to strategies'}
          </Link>
        </Button>
        <span className="workspace-location">
          {section.label}
          <ChevronRight size={13} />
          {route.title}
        </span>
      </div>
    );
  return (
    <div className="workspace-return-location">
      {route.kind !== 'root' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => goBack(parent)}
        >
          <ArrowLeft size={15} />
          <span>{zh ? '返回上一页' : 'Go back'}</span>
        </Button>
      )}
      {route.kind === 'root' ? (
        <span className="workspace-location">
          <span className="hidden sm:inline">
            {zh ? '我的工作区' : 'My workspace'}
          </span>
          <ChevronRight size={13} />
          {section.label}
        </span>
      ) : (
        <Link className="workspace-parent-link" to={parent}>
          <span className="hidden sm:inline">
            {zh ? '所属 · ' : 'Within · '}
          </span>
          {section.label}
        </Link>
      )}
    </div>
  );
}

export function WorkspaceSectionTabs() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const location = useLocation();
  const { pathname } = location;
  const accountId = new URLSearchParams(location.search).get('accountId') ?? 'real';
  const section = resolveWorkspaceRoute(pathname, i18n.language).section;
  const items =
    section === 'assets'
      ? [
          ['/holdings', zh ? '持仓与现金' : 'Holdings & cash'],
          ['/transactions', zh ? '交易账本' : 'Ledger'],
          ['/watchlist', zh ? '关注列表' : 'Watchlist'],
          ...(accountId === 'real' ? [['/import', zh ? '导入与对账' : 'Import & reconcile']] : []),
        ]
      : section === 'overview'
        ? [
            ['/', zh ? '投资总览' : 'Overview'],
            ['/paper', zh ? '模拟账户' : 'Simulation accounts'],
          ]
      : section === 'daily' &&
          ['/daily', '/analysis', '/journal'].includes(pathname)
        ? [
            ['/daily', zh ? '总体日报' : 'Daily overview'],
            ['/analysis', zh ? '报告历史' : 'Report history'],
            ['/journal', zh ? '个人复盘' : 'Personal journal'],
          ]
        : [];
  if (!items.length) return null;
  return (
    <nav
      className="workspace-section-tabs"
      aria-label={zh ? '模块内导航' : 'Section navigation'}
    >
      {items.map(([path, label]) => (
        <Link
          key={path}
          to={section === 'assets' ? assetHref(path, accountId, path === '/watchlist' ? new URLSearchParams({ returnTo: `${pathname}${location.search}${location.hash}` }).toString() : '') : path}
          state={{ returnTo: `${pathname}${location.search}${location.hash}` }}
          aria-current={pathname === path ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
