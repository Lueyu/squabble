/** Route ownership is shared by navigation, search and deep-link fallbacks. */
export type WorkspaceSectionId =
  | 'overview'
  | 'friends'
  | 'daily'
  | 'research'
  | 'assets'
  | 'data'
  | 'memory'
  | 'telemetry'
  | 'settings';
export interface WorkspaceSection {
  id: WorkspaceSectionId;
  path: string;
  label: string;
  group: 'daily' | 'workspace';
  end?: boolean;
}
export interface WorkspaceRoute {
  section: WorkspaceSectionId;
  title: string;
  parent: string;
  kind: 'root' | 'detail' | 'flow';
}
export interface WorkspaceVisit {
  key: string;
  index: number;
  path: string;
  scrollTop: number;
}

export function workspaceSections(language: string): WorkspaceSection[] {
  const zh = language.startsWith('zh');
  return [
    {
      id: 'overview',
      path: '/',
      label: zh ? '投资总览' : 'Overview',
      group: 'daily',
      end: true,
    },
    {
      id: 'friends',
      path: '/paper',
      label: zh ? '我的股友' : 'Companions',
      group: 'daily',
    },
    {
      id: 'daily',
      path: '/daily',
      label: zh ? '投资日报' : 'Daily report',
      group: 'daily',
    },
    {
      id: 'research',
      path: '/research',
      label: zh ? '研究室' : 'Research',
      group: 'daily',
    },
    {
      id: 'assets',
      path: '/holdings',
      label: zh ? '资产与账本' : 'Assets & ledger',
      group: 'daily',
    },
    {
      id: 'data',
      path: '/data',
      label: zh ? '数据中心' : 'Data center',
      group: 'workspace',
    },
    {
      id: 'memory',
      path: '/memory',
      label: zh ? '记忆' : 'Memory',
      group: 'workspace',
    },
    {
      id: 'telemetry',
      path: '/telemetry',
      label: zh ? '运行分析' : 'Run analytics',
      group: 'workspace',
    },
    {
      id: 'settings',
      path: '/settings',
      label: zh ? '模型与设置' : 'Models & settings',
      group: 'workspace',
    },
  ];
}

export function resolveWorkspaceRoute(
  pathname: string,
  language: string,
): WorkspaceRoute {
  const zh = language.startsWith('zh');
  const roots = workspaceSections(language);
  const root = roots.find((item) => item.path === pathname);
  if (root)
    return {
      section: root.id,
      title: root.label,
      parent: root.path,
      kind: 'root',
    };
  // /settings normalizes to its default panel. It has no distinct parent screen.
  if (pathname === '/settings/models')
    return {
      section: 'settings',
      title: zh ? '模型与设置' : 'Models & settings',
      parent: '/settings',
      kind: 'root',
    };
  const account = pathname.match(/^\/paper\/([^/]+)(?:\/(.*))?$/u);
  if (account)
    return {
      section: 'friends',
      title: account[2]
        ? zh
          ? '策略组合'
          : 'Strategy combination'
        : zh
          ? '股友账户'
          : 'Companion account',
      parent: account[2] ? '/paper/' + account[1] : '/paper',
      kind: 'detail',
    };
  if (pathname.startsWith('/strategies'))
    return {
      section: 'research',
      title:
        pathname === '/strategies'
          ? zh
            ? '策略库'
            : 'Strategy library'
          : zh
            ? '聊出策略'
            : 'Strategy conversation',
      parent: '/research?tab=strategies',
      kind: pathname === '/strategies' ? 'detail' : 'flow',
    };
  if (pathname.startsWith('/settings/'))
    return {
      section: 'settings',
      title: zh ? '工作区设置' : 'Workspace settings',
      parent: '/settings',
      kind: 'detail',
    };
  if (pathname.startsWith('/telemetry/runs/'))
    return {
      section: 'telemetry',
      title: zh ? '执行详情' : 'Run detail',
      parent: '/telemetry?view=runs',
      kind: 'detail',
    };
  if (['/transactions', '/watchlist', '/import'].includes(pathname))
    return {
      section: 'assets',
      title:
        pathname === '/transactions'
          ? zh
            ? '交易账本'
            : 'Transaction ledger'
          : pathname === '/watchlist'
            ? zh
              ? '关注列表'
              : 'Watchlist'
            : zh
              ? '导入与对账'
              : 'Import & reconcile',
      parent: '/holdings',
      kind: 'detail',
    };
  if (pathname === '/journal')
    return {
      section: 'daily',
      title: zh ? '个人复盘' : 'Personal journal',
      parent: '/daily',
      kind: 'detail',
    };
  if (pathname === '/research/portfolio')
    return {
      section: 'research',
      title: zh ? '持仓研究' : 'Portfolio research',
      parent: '/research',
      kind: 'detail',
    };
  if (pathname.startsWith('/analysis'))
    return {
      section: 'daily',
      title:
        pathname === '/analysis'
          ? zh
            ? '报告历史'
            : 'Report history'
          : zh
            ? '报告详情'
            : 'Report details',
      parent: pathname === '/analysis' ? '/daily' : '/analysis',
      kind: 'detail',
    };
  if (pathname.startsWith('/council') || pathname === '/agent-builder')
    return {
      section: 'research',
      title: zh ? '股友研究' : 'Companion research',
      parent: '/research',
      kind: 'detail',
    };
  if (pathname === '/notifications')
    return {
      section: 'daily',
      title: zh ? '提醒' : 'Notifications',
      parent: '/daily',
      kind: 'detail',
    };
  return {
    section: 'overview',
    title: zh ? '工作区' : 'Workspace',
    parent: '/',
    kind: 'detail',
  };
}

/** Only known application paths may be used as a fallback return destination. */
export function safeReturnPath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f]/u.test(value)
  )
    return null;
  try {
    const parsed = new URL(value, 'https://squabble.invalid');
    if (parsed.origin !== 'https://squabble.invalid') return null;
    if (
      !/^\/(?:$|paper(?:\/|$)|daily(?:\/|$)|research(?:\/|$)|holdings(?:\/|$)|data(?:\/|$)|memory(?:\/|$)|settings(?:\/|$)|strategies(?:\/|$)|analysis(?:\/|$)|council(?:\/|$)|transactions$|watchlist$|import$|journal$|notifications$)/u.test(
        parsed.pathname,
      )
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function rememberLocation(
  visits: WorkspaceVisit[],
  visit: WorkspaceVisit,
  action: string,
): WorkspaceVisit[] {
  const retained = visits.filter(
    (item) =>
      item.key !== visit.key &&
      (action !== 'PUSH' || item.index < visit.index) &&
      (action !== 'REPLACE' || item.index !== visit.index),
  );
  return [...retained, visit].sort((a, b) => a.index - b.index).slice(-80);
}

export function restoredScrollPosition(
  visits: WorkspaceVisit[],
  key: string,
  action: string,
): number {
  return action === 'POP'
    ? (visits.find((item) => item.key === key)?.scrollTop ?? 0)
    : 0;
}

/** A saved visit wins on Back, including an intentional scroll to zero. New hash links target their section. */
export function workspaceScrollTarget(
  visits: WorkspaceVisit[],
  key: string,
  action: string,
  hash: string,
): { top: number; anchor: null } | { top: null; anchor: string } {
  const saved =
    action === 'POP' ? visits.find((item) => item.key === key) : undefined;
  if (saved) return { top: saved.scrollTop, anchor: null };
  if (hash.startsWith('#') && hash.length > 1) {
    try {
      return { top: null, anchor: decodeURIComponent(hash.slice(1)) };
    } catch {
      /* Malformed links start at the top. */
    }
  }
  return { top: 0, anchor: null };
}

export function returnDestination(
  visits: WorkspaceVisit[],
  index: number,
  returnTo: unknown,
  fallback: string,
): { kind: 'back' } | { kind: 'path'; path: string } {
  const previous = visits.find((item) => item.index === index - 1);
  if (previous && safeReturnPath(previous.path)) return { kind: 'back' };
  return {
    kind: 'path',
    path: safeReturnPath(returnTo) ?? safeReturnPath(fallback) ?? '/',
  };
}

export function workspaceDestinations(language: string) {
  const zh = language.startsWith('zh');
  return [
    ...workspaceSections(language),
    {
      path: '/strategies',
      label: zh ? '策略库与草稿' : 'Strategy library & drafts',
    },
    {
      path: '/import',
      label: zh ? '导入持仓与成交' : 'Import holdings & trades',
    },
    { path: '/transactions', label: zh ? '交易账本' : 'Transactions' },
    { path: '/watchlist', label: zh ? '关注列表' : 'Watchlist' },
    { path: '/journal', label: zh ? '个人复盘笔记' : 'Personal journal' },
    { path: '/analysis', label: zh ? '报告历史' : 'Report history' },
    {
      path: '/research/portfolio',
      label: zh ? '持仓研究' : 'Portfolio research',
    },
    { path: '/council', label: zh ? '股友讨论频道' : 'Research channel' },
    {
      path: '/settings/notifications',
      label: zh ? '交易提醒与通知渠道' : 'Trade alerts & channels',
    },
    {
      path: '/settings/mcp',
      label: zh ? 'MCP 连接与访问令牌' : 'MCP connections & access',
    },
    { path: '/settings/agents', label: zh ? '本地 Agent' : 'Local agents' },
    { path: '/settings/budget', label: zh ? '用量与预算' : 'Usage & budget' },
  ];
}
