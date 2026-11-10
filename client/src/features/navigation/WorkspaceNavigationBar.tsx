import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  resolveWorkspaceRoute,
  workspaceSections,
} from './workspace-navigation';
import { useWorkspaceNavigation } from './use-workspace-navigation';

export function WorkspaceNavigationBar() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const location = useLocation();
  const route = resolveWorkspaceRoute(location.pathname, i18n.language);
  const section = workspaceSections(i18n.language).find(
    (item) => item.id === route.section,
  )!;
  const { goBack } = useWorkspaceNavigation();
  if (route.kind === 'flow')
    return (
      <div id="workspace-flow-controls" className="workspace-flow-controls">
        <Button
          asChild
          variant="outline"
          size="sm"
          className="workspace-flow-fallback"
        >
          <Link to={route.parent}>
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
          onClick={() => goBack(route.parent)}
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
        <Link className="workspace-parent-link" to={route.parent}>
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
  const { pathname } = useLocation();
  const section = resolveWorkspaceRoute(pathname, i18n.language).section;
  const items =
    section === 'assets'
      ? [
          ['/holdings', zh ? '持仓与现金' : 'Holdings & cash'],
          ['/transactions', zh ? '交易账本' : 'Ledger'],
          ['/watchlist', zh ? '关注列表' : 'Watchlist'],
          ['/import', zh ? '导入与对账' : 'Import & reconcile'],
        ]
      : section === 'daily' &&
          ['/daily', '/analysis', '/journal'].includes(pathname)
        ? [
            ['/daily', zh ? '总体日报' : 'Daily overview'],
            ['/analysis', zh ? '报告与历史' : 'Reports & history'],
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
          to={path}
          aria-current={pathname === path ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
