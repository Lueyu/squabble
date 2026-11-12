import { isAxiosError } from 'axios';
import type { ModelConnection } from '@shared/model-connections.interface';
import type { CreatePortfolioAccountRequest, PortfolioAccountSummary } from '@shared/portfolio-workspace.interface';
import type { InvestmentPreviewRequest } from '@shared/investment-policy.interface';
import type { TeamDetail, TeamExecutor, TeamSemanticConfig } from '@shared/team-workspace.interface';

/**
 * Template quick start: one reviewed confirmation chains the existing draft,
 * publish, simulation-account and binding endpoints. No step calls a model,
 * starts research or applies a strategy; every mutation keeps its own
 * request key so an uncertain outcome replays instead of duplicating work.
 */
export type QuickStartSeed =
  | { kind: 'cash'; amount: string; currency: 'USD' | 'HKD' | 'CNY' }
  | { kind: 'holdings' }
  | { kind: 'existing'; accountId: string }
  | { kind: 'none' };

export interface QuickStartInput {
  name: string; description: string; avatar: string; templateId: string;
  seed: QuickStartSeed; accountName: string; connectionId: string | null;
}

export type QuickStartStepId = 'team' | 'draft' | 'publish' | 'account' | 'binding';
export type QuickStartStepState = 'pending' | 'running' | 'done' | 'failed';

export interface QuickStartProgress {
  steps: { id: QuickStartStepId; state: QuickStartStepState }[];
  teamId: string | null; versionId: string | null; accountId: string | null; bindingId: string | null;
}

export interface QuickStartKeySlots {
  team: string; draft: string; publishPreview: string; publishConfirm: string;
  accountPreview: string; accountCreate: string; accountCompanion: string;
  bindingPreview: string; bindingConfirm: string;
}

export interface StoredQuickStart {
  savedAt: string; input: QuickStartInput; keys: QuickStartKeySlots; progress: QuickStartProgress;
}

export const QUICK_START_STORAGE_KEY = 'squabble.team-quick-start';
export const QUICK_START_STEP_IDS: QuickStartStepId[] = ['team', 'draft', 'publish', 'account', 'binding'];

/** A connection can serve as the quick-start default only with a usable key and at least one model identifier. */
export function quickStartEligibleConnection(connection: Pick<ModelConnection, 'available' | 'fastModel' | 'slowModel'>): boolean {
  return connection.available && Boolean(connection.fastModel || connection.slowModel);
}

/**
 * The suggested final lead works at the deep tier and specialists answer at the
 * fast tier; both identifiers must match the connection exactly or the server
 * capability check rejects the role.
 */
export function quickStartExecutor(connection: Pick<ModelConnection, 'id' | 'fastModel' | 'slowModel'>, isLead: boolean): TeamExecutor | null {
  const model = isLead ? (connection.slowModel || connection.fastModel) : (connection.fastModel || connection.slowModel);
  if (!model) return null;
  return { executionMode: 'model', connectionId: connection.id, model, tier: model === connection.slowModel ? 'slow' : 'fast', settings: {} };
}

/** Enable every template role with the default connection so the first commission can select any of them. */
export function applyQuickStartExecutors(config: TeamSemanticConfig, connection: Pick<ModelConnection, 'id' | 'fastModel' | 'slowModel'>, leadRoleId: string | null): TeamSemanticConfig {
  return { ...config, roles: config.roles.map(role => { const executor = quickStartExecutor(connection, role.id === leadRoleId); return executor ? { ...role, participation: 'enabled' as const, executor } : role; }) };
}

export function quickStartSteps(input: QuickStartInput): QuickStartStepId[] {
  const creating = input.seed.kind === 'cash' || input.seed.kind === 'holdings';
  return QUICK_START_STEP_IDS.filter(id =>
    (id !== 'draft' || input.connectionId !== null) && (id !== 'account' || creating) && (id !== 'binding' || creating || input.seed.kind === 'existing'));
}

export function initialQuickStartProgress(input: QuickStartInput): QuickStartProgress {
  return { steps: quickStartSteps(input).map(id => ({ id, state: 'pending' as const })), teamId: null, versionId: null, accountId: null, bindingId: null };
}

export function updateQuickStartStep(progress: QuickStartProgress, id: QuickStartStepId, state: QuickStartStepState): QuickStartProgress {
  return { ...progress, steps: progress.steps.map(step => step.id === id ? { ...step, state } : step) };
}

export function quickStartStepLabel(id: QuickStartStepId, zh: boolean): string {
  return ({ team: zh ? '创建团队草稿' : 'Create the team draft', draft: zh ? '配置岗位执行连接' : 'Configure role executor connections', publish: zh ? '发布配置 v1' : 'Publish configuration v1', account: zh ? '创建模拟盘' : 'Create the simulation account', binding: zh ? '关联模拟盘' : 'Link the simulation account' })[id];
}

export function initialQuickStartKeys(generate: () => string = () => crypto.randomUUID()): QuickStartKeySlots {
  return { team: generate(), draft: generate(), publishPreview: generate(), publishConfirm: generate(), accountPreview: generate(), accountCreate: generate(), accountCompanion: generate(), bindingPreview: generate(), bindingConfirm: generate() };
}

export interface QuickStartFieldIssue { field: string; message: string }

/** Client-side gate mirroring the server name and cash-seed rules before the chain starts. */
export function validateQuickStartInput(input: QuickStartInput): QuickStartFieldIssue[] {
  const issues: QuickStartFieldIssue[] = [];
  if (!input.name.trim() || input.name.trim().length > 60) issues.push({ field: 'name', message: 'Enter a team name of 1–60 characters.' });
  if ((input.seed.kind === 'cash' || input.seed.kind === 'holdings') && input.accountName.trim().length > 80)
    issues.push({ field: 'accountName', message: 'Account names are limited to 80 characters; leave it empty to use the team name.' });
  if (input.seed.kind === 'cash' && (!/^\d+(?:\.\d+)?$/.test(input.seed.amount.trim()) || Number(input.seed.amount) <= 0))
    issues.push({ field: 'amount', message: 'Enter a positive starting cash amount.' });
  if (input.seed.kind === 'existing' && !input.seed.accountId)
    issues.push({ field: 'accountId', message: 'Choose a simulation account.' });
  return issues;
}

/** The simulation account inherits the team name unless the user typed its own label. */
export function quickStartAccountName(input: QuickStartInput, zh: boolean): string {
  const typed = input.accountName.trim();
  const suffix = zh ? '模拟盘' : 'simulation';
  return typed || `${input.name.trim()} ${suffix}`.slice(0, 80).trim();
}

/** Cash previews are deterministic; the holdings preview freezes the current real ledger as the seed. */
export function quickStartPreviewRequest(seed: QuickStartSeed, requestKey: string): InvestmentPreviewRequest {
  if (seed.kind === 'cash') return { origin: 'cash', cash: { currency: seed.currency, amount: Number(seed.amount) }, requestKey };
  if (seed.kind === 'holdings') return { origin: 'holdings', requestKey };
  throw new Error('Quick start creates an account only for cash or holdings seeds.');
}

export function quickStartCreateAccountRequest(accountName: string, previewId: string, requestKey: string): CreatePortfolioAccountRequest {
  return { previewId, requestKey, name: accountName };
}

/** After an expired account preview, adopt an account this chain already created instead of risking a duplicate. */
export function adoptCreatedAccount(accounts: PortfolioAccountSummary[], knownAccountIds: ReadonlySet<string>, accountName: string): string | null {
  const created = accounts.filter(account => !knownAccountIds.has(account.id) && account.name === accountName);
  return created.length === 1 ? created[0].id : null;
}

export type QuickStartFailureKind = 'network' | 'server' | 'rejected' | 'recoverable-preview';

export function quickStartErrorCode(error: unknown): string | null {
  if (!isAxiosError(error) || !error.response) return null;
  const body = error.response.data;
  if (body && typeof body === 'object') {
    const data = body as { code?: unknown; error?: { code?: unknown }; message?: unknown };
    if (typeof data.code === 'string') return data.code;
    if (data.error && typeof data.error === 'object' && typeof data.error.code === 'string') return data.error.code;
    if (typeof data.message === 'string' && data.message.startsWith('PREVIEW_')) return data.message;
  }
  return null;
}

/**
 * Expired or consumed previews are the only client-recoverable failure: a
 * fresh preview key is safe because the confirm request has not committed.
 * Plain local errors are deterministic rejections; everything else either
 * proves nothing was committed (4xx) or proves nothing at all (network, 5xx)
 * and replays with the same keys.
 */
export function quickStartFailureKind(error: unknown): QuickStartFailureKind {
  const code = quickStartErrorCode(error);
  if (code === 'PREVIEW_EXPIRED' || code === 'TEAM_PREVIEW_STALE' || code === 'TEAM_PREVIEW_CONSUMED') return 'recoverable-preview';
  if (!isAxiosError(error)) return 'rejected';
  if (!error.response) return 'network';
  if (error.response.status >= 500) return 'server';
  return 'rejected';
}

function readSeed(value: unknown): QuickStartSeed | null {
  if (!value || typeof value !== 'object') return null;
  const seed = value as { kind?: unknown; amount?: unknown; currency?: unknown; accountId?: unknown };
  if (seed.kind === 'none') return { kind: 'none' };
  if (seed.kind === 'holdings') return { kind: 'holdings' };
  if (seed.kind === 'cash' && typeof seed.amount === 'string' && typeof seed.currency === 'string' && ['USD', 'HKD', 'CNY'].includes(seed.currency)) return { kind: 'cash', amount: seed.amount, currency: seed.currency as 'USD' | 'HKD' | 'CNY' };
  if (seed.kind === 'existing' && typeof seed.accountId === 'string') return { kind: 'existing', accountId: seed.accountId };
  return null;
}

/** Session-stored progress survives reloads; request keys never outlive the browser session. */
export function readStoredQuickStart(): StoredQuickStart | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    const value = JSON.parse(window.sessionStorage.getItem(QUICK_START_STORAGE_KEY) ?? 'null') as StoredQuickStart | null;
    if (!value || typeof value !== 'object' || typeof value.savedAt !== 'string') return null;
    const input = value.input;
    if (!input || typeof input !== 'object' || typeof input.name !== 'string' || typeof input.templateId !== 'string') return null;
    const seed = readSeed(input.seed);
    if (!seed) return null;
    const keys = value.keys;
    const progress = value.progress;
    if (!keys || typeof keys !== 'object' || !progress || !Array.isArray(progress.steps)) return null;
    const slots = ['team', 'draft', 'publishPreview', 'publishConfirm', 'accountPreview', 'accountCreate', 'accountCompanion', 'bindingPreview', 'bindingConfirm'] as const;
    if (slots.some(slot => typeof keys[slot] !== 'string')) return null;
    return { savedAt: value.savedAt, input: { ...input, seed }, keys, progress };
  } catch { return null; }
}

export function writeStoredQuickStart(record: StoredQuickStart): boolean {
  try { if (typeof window === 'undefined' || !window.sessionStorage) return false; window.sessionStorage.setItem(QUICK_START_STORAGE_KEY, JSON.stringify(record)); return true; } catch { return false; }
}

export function clearStoredQuickStart(): void {
  try { if (typeof window !== 'undefined' && window.sessionStorage) window.sessionStorage.removeItem(QUICK_START_STORAGE_KEY); } catch { /* Removal is best effort. */ }
}

/** A stored record stays resumable while any step has not finished; completed chains are cleared on success. */
export function storedQuickStartResumable(record: StoredQuickStart | null): boolean {
  return !!record && record.progress.steps.some(step => step.state !== 'done');
}
