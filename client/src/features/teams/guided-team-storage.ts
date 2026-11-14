import { getAuthMode } from '@/api/auth-mode';
import type { TradingMarket } from '@shared/trading-market.interface';
import type { GuidedTeamRecord } from './guided-team-create';
import { guidedRequestKey } from './guided-request-keys';

type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const prefix = 'squabble.team-guided-create';
export interface GuidedTeamDraft {
  version: 1;
  name: string;
  selected: string[] | null;
  daily: string;
  market: TradingMarket;
  step: number;
}

/** This partitions private tab caches only; the server remains the authority for identity and access. */
export function guidedOwnerScope(): string | null {
  if (getAuthMode() === 'local') return 'local';
  try {
    const token = window.localStorage.getItem('sq-at');
    const payload = token && JSON.parse(window.atob(token.split('.')[1].replace(/-/gu, '+').replace(/_/gu, '/')));
    return typeof payload?.sub === 'string' && payload.sub ? `account:${payload.sub}` : null;
  } catch { return null; }
}
const cacheKey = (owner: string, kind: string) => `${prefix}.${encodeURIComponent(owner)}.${kind}`;
function read(owner: string | null, kind: string, storage?: TabStorage): unknown {
  try { return owner ? JSON.parse((storage ?? window.sessionStorage).getItem(cacheKey(owner, kind)) ?? 'null') : null; }
  catch { return null; }
}
export function readGuidedDraft(owner: string | null, storage?: TabStorage): GuidedTeamDraft | null {
  const value = read(owner, 'draft', storage) as GuidedTeamDraft | null;
  return value?.version === 1 && typeof value.name === 'string' && typeof value.daily === 'string' && ['CN', 'HK', 'US'].includes(value.market) && (value.selected === null || Array.isArray(value.selected) && value.selected.every(id => typeof id === 'string')) ? value : null;
}
export function saveGuidedDraft(owner: string | null, draft: Omit<GuidedTeamDraft, 'version'>, storage?: TabStorage): void {
  if (!owner) return;
  const value: GuidedTeamDraft = { version: 1, name: draft.name, selected: draft.selected, daily: draft.daily, market: draft.market, step: Math.min(2, Math.max(1, draft.step)) };
  (storage ?? window.sessionStorage).setItem(cacheKey(owner, 'draft'), JSON.stringify(value));
}
export function readGuidedProgress(owner: string | null, storage?: TabStorage): GuidedTeamRecord | null {
  const value = read(owner, 'progress', storage) as GuidedTeamRecord | null;
  return value?.version === 1 && typeof value.key === 'string' && Array.isArray(value.agents) && value.preview?.previewId ? value : null;
}
export function saveGuidedProgress(owner: string | null, record: GuidedTeamRecord, storage?: TabStorage): void {
  if (!owner) throw new Error('A verified workspace session is required to retain startup progress');
  const tab = storage ?? window.sessionStorage;
  tab.setItem(cacheKey(owner, 'progress'), JSON.stringify(record));
  if (record.legacyUnscoped && !record.pendingOperation) {
    try {
      const legacy = JSON.parse(tab.getItem(prefix) ?? 'null');
      if (legacy?.key === record.key) tab.removeItem(prefix);
    } catch { /* A different or unreadable legacy record must remain untouched. */ }
  }
}
export function clearGuidedProgress(owner: string | null, storage?: TabStorage): void {
  if (!owner) return;
  const tab = storage ?? window.sessionStorage;
  tab.removeItem(cacheKey(owner, 'progress'));
  tab.removeItem(cacheKey(owner, 'draft'));
}
/** Ending a resolved obsolete workflow retains all receipts and never deletes its team or account. */
export function endGuidedProgress(owner: string | null, record: GuidedTeamRecord, storage?: TabStorage): boolean {
  if (!owner || record.reviewRequired !== 'changed' || record.pendingOperation) return false;
  const tab = storage ?? window.sessionStorage;
  tab.setItem(cacheKey(owner, `ended.${record.key}`), JSON.stringify(record));
  clearGuidedProgress(owner, tab);
  return true;
}

export function hasLegacyGuidedProgress(storage?: TabStorage): boolean {
  try { return Boolean((storage ?? window.sessionStorage).getItem(prefix)); }
  catch { return false; }
}

export interface LegacyGuidedOwnershipPorts {
  agents: { detail: (id: string) => Promise<{ id: string }> };
  teams: { detail: (id: string) => Promise<{ id: string }> };
  accounts: { account: (id: string) => Promise<{ id: string }> };
  currentOwner: () => string | null;
}

/** Legacy caches have no owner. Read each exact resource through owner-scoped APIs before exposing or copying anything. */
export async function migrateLegacyGuidedProgress(owner: string | null, ports: LegacyGuidedOwnershipPorts, storage?: TabStorage): Promise<GuidedTeamRecord | null> {
  if (!owner) throw new Error('Legacy progress ownership is unverified');
  const tab = storage ?? window.sessionStorage;
  const current = readGuidedProgress(owner, tab);
  if (current) return current;
  const raw = tab.getItem(prefix);
  if (!raw) return null;
  const record = JSON.parse(raw) as GuidedTeamRecord;
  if (record?.version !== 1 || typeof record.key !== 'string' || typeof record.name !== 'string' || !record.preview?.previewId || !record.agents?.length || record.agents.some(agent => typeof agent.id !== 'string')) throw new Error('Legacy progress cannot be verified');
  const checks = [
    ...record.agents.map(agent => ({ id: agent.id, request: ports.agents.detail(agent.id) })),
    ...(record.teamId ? [{ id: record.teamId, request: ports.teams.detail(record.teamId) }] : []),
    ...(record.accountId ? [{ id: record.accountId, request: ports.accounts.account(record.accountId) }] : []),
  ];
  const results = await Promise.allSettled(checks.map(check => check.request));
  if (results.some((result, index) => result.status !== 'fulfilled' || result.value?.id !== checks[index].id) || ports.currentOwner() !== owner || tab.getItem(prefix) !== raw) throw new Error('Legacy progress ownership is unverified');
  if (readGuidedProgress(owner, tab)) throw new Error('Current progress changed during legacy review');
  // The original release sent this exact English payload, even from the Chinese interface.
  record.teamCreateInput ??= { requestKey: guidedRequestKey(record.key, 'team'), name: record.name, description: 'Guided team: persistent agents and independent paper account' };
  record.legacyUnscoped = true;
  if (!record.pendingOperation) {
    if (!record.teamId) record.pendingOperation = 'team';
    else if (record.draft && !record.draftSaved) record.pendingOperation = 'draft';
    else if (record.display && !record.displaySaved) record.pendingOperation = 'display';
    else if (record.publish && !record.publishedVersionId) record.pendingOperation = 'publish';
    else if (record.accountInput && !record.accountId) record.pendingOperation = 'account';
    else if (record.binding && !record.bindingId) record.pendingOperation = 'binding';
    else if (record.agreementPreview && !record.agreement) record.pendingOperation = 'agreement';
    else if (record.agreement && !record.startSaved) record.pendingOperation = 'start';
  }
  saveGuidedProgress(owner, record, tab);
  return record;
}
