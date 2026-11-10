export const SETTINGS_SECTIONS = [
  { id: 'models', group: 'research' },
  { id: 'agents', group: 'research' },
  { id: 'data', group: 'research' },
  { id: 'budget', group: 'research' },
  { id: 'rules', group: 'research' },
  { id: 'notifications', group: 'personal' },
  { id: 'mcp', group: 'research' },
  { id: 'appearance', group: 'personal' },
  { id: 'security', group: 'personal' },
  { id: 'updates', group: 'personal' },
  { id: 'guide', group: 'help' },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];
export const SETTINGS_GROUPS = ['research', 'personal', 'help'] as const;

/** Keep saved links from the former single-page settings screen working. */
export function resolveSettingsSection(pathname: string, hash = ''): SettingsSection | null {
  const path = pathname.replace(/\/+$/u, '');
  if (path === '/settings') {
    if (hash === '#research-budget') return 'budget';
    if (hash === '#local-agents') return 'agents';
    return 'models';
  }
  return SETTINGS_SECTIONS.find(section => path === `/settings/${section.id}`)?.id ?? null;
}
