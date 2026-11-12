import { teamsApi } from '@/api/teams';
import { teamRunsApi } from '@/api/team-runs';
import { portfolioWorkspaceApi } from '@/api/portfolio-workspace';
import { previewAiInvestment } from '@/api/ai-investment';
import type { AgentProfile } from '@shared/agent-roster.interface';
import type { AiInvestmentPreview } from '@shared/investment-policy.interface';
import type { BindingPreviewInput, TeamDetail, TeamDisplayInput, TeamDraftInput, TeamPreview, TeamPublishPreviewInput } from '@shared/team-workspace.interface';
import type { TeamRunAgreement, TeamRunAgreementInput, TeamRunAgreementPreview } from '@shared/team-run.interface';
import type { TradingMarket } from '@shared/trading-market.interface';
import type { ModelConnection } from '@shared/model-connections.interface';
import type { CreatePortfolioAccountRequest } from '@shared/portfolio-workspace.interface';
import { guidedRunBudget, rosterTeamConfig, guidedSeedBlockers } from './guided-team-state';

export const GUIDED_TEAM_KEY = 'squabble.team-guided-create';
type ReviewStage = 'seed' | 'publish' | 'binding' | 'agreement' | 'changed';
export interface GuidedTeamRecord {
  version: 1; key: string; name: string; agents: AgentProfile[]; models: ModelConnection[];
  preview: AiInvestmentPreview; market: TradingMarket; dailyUsd: string; language?: 'zh-CN' | 'en';
  teamId?: string; draft?: TeamDraftInput; draftSaved?: boolean; display?: TeamDisplayInput;
  displaySaved?: boolean; publish?: TeamPreview; publishInput?: TeamPublishPreviewInput; publishedVersionId?: string;
  accountId?: string; accountInput?: CreatePortfolioAccountRequest; binding?: TeamPreview; bindingInput?: BindingPreviewInput; bindingId?: string; bindingRevision?: number;
  agreementInput?: TeamRunAgreementInput; agreementPreview?: TeamRunAgreementPreview; agreement?: TeamRunAgreement;
  reviewRequired?: ReviewStage; reviewEpochs?: Partial<Record<ReviewStage, number>>; refreshPending?: ReviewStage;
}
export interface GuidedTeamPorts {
  teams: Pick<typeof teamsApi, 'create' | 'detail' | 'saveDraft' | 'saveDisplay' | 'publishPreview' | 'publish' | 'bindingPreview' | 'binding'>;
  accounts: Pick<typeof portfolioWorkspaceApi, 'create'>;
  runs: Pick<typeof teamRunsApi, 'status' | 'preview' | 'confirm' | 'start'>;
  previewHoldings?: typeof previewAiInvestment;
}
const defaultPorts: GuidedTeamPorts = { teams: teamsApi, accounts: portfolioWorkspaceApi, runs: teamRunsApi, previewHoldings: previewAiInvestment };
type Progress = (record: GuidedTeamRecord, label: string) => void;
export class GuidedTeamReviewRequired extends Error {
  constructor(readonly stage: ReviewStage) { super(stage === 'changed' ? 'Startup authority changed; review the existing team' : `Review the ${stage} preview before continuing`); }
}
export class GuidedTeamValidationError extends Error {
  constructor(readonly code: 'name' | 'budget' | 'members' | 'connection' | 'holdings') { super(`Guided setup needs ${code}`); }
}
const keyFor = (record: GuidedTeamRecord, step: string, stage?: ReviewStage) => `${record.key}:${step}${stage && record.reviewEpochs?.[stage] ? `:${record.reviewEpochs[stage]}` : ''}`;
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function requireReview(record: GuidedTeamRecord, stage: ReviewStage, progress: Progress): never {
  record.reviewRequired = stage; progress(record, stage); throw new GuidedTeamReviewRequired(stage);
}
function responseCode(error: unknown): string {
  const data = (error as { response?: { data?: { code?: string; message?: string; error?: { code?: string; message?: string } } | string } })?.response?.data;
  return typeof data === 'string' ? data : data?.error?.code ?? data?.code ?? data?.error?.message ?? data?.message ?? '';
}
/** Only definitive server rejections may change a request. A timeout retains the exact original payload. */
async function confirmed<T>(record: GuidedTeamRecord, stage: Exclude<ReviewStage, 'changed'>, progress: Progress, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (['PREVIEW_EXPIRED', 'SOURCE_CHANGED_REPREVIEW', 'TEAM_PREVIEW_STALE', 'TEAM_PREVIEW_CONSUMED'].includes(responseCode(error))) requireReview(record, stage, progress);
    if (['TEAM_REVISION_CONFLICT', 'TEAM_BINDING_CONFLICT', 'TEAM_REQUEST_KEY_CONFLICT', 'TEAM_REAPPROVAL_REQUIRED'].includes(responseCode(error))) requireReview(record, 'changed', progress);
    throw error;
  }
}
export function validateGuidedTeamStart(record: GuidedTeamRecord): void {
  if (!record.name.trim() || record.name.trim().length > 60) throw new GuidedTeamValidationError('name');
  try { guidedRunBudget(record.dailyUsd, record.agents.some(agent => agent.currentVersion.config.executor.executionMode !== 'model')); }
  catch { throw new GuidedTeamValidationError('budget'); }
  // The guided path fits the existing eight-call account ceiling. Larger organizations remain available in advanced editing.
  if (!record.agents.length || record.agents.length > 4 || new Set(record.agents.map(agent => agent.id)).size !== record.agents.length) throw new GuidedTeamValidationError('members');
  try { rosterTeamConfig(record.agents, record.models, record.agents.map((_, index) => `validation-${index}`)); }
  catch { throw new GuidedTeamValidationError('connection'); }
  if (!record.accountId && guidedSeedBlockers(record.preview.needsInput).length) throw new GuidedTeamValidationError('holdings');
}
function assertVersion(record: GuidedTeamRecord, team: TeamDetail, progress: Progress): void {
  if (team.status !== 'active' || !record.publishedVersionId || team.currentVersionId !== record.publishedVersionId) requireReview(record, 'changed', progress);
}
function assertBinding(record: GuidedTeamRecord, team: TeamDetail, progress: Progress): void {
  assertVersion(record, team, progress);
  if (!record.bindingId || !team.binding || team.binding.state !== 'active' || team.binding.id !== record.bindingId || team.binding.accountId !== record.accountId || team.accountId !== record.accountId || team.binding.teamVersionId !== record.publishedVersionId || team.bindingRevision !== record.bindingRevision) requireReview(record, 'changed', progress);
}
function agreementInput(record: GuidedTeamRecord, team: TeamDetail): TeamRunAgreementInput {
  return { requestKey: keyFor(record, 'agreement-preview', 'agreement'), teamVersionId: record.publishedVersionId!, bindingId: record.bindingId!, expectedBindingRevision: team.bindingRevision, objective: 'Review this simulated portfolio using current evidence; preserve uncertainty, propose only justified actions within confirmed account risk rules.', market: record.market, cadence: { kind: 'after_close', delayMinutes: 60 }, budget: guidedRunBudget(record.dailyUsd, record.agents.some(agent => agent.currentVersion.config.executor.executionMode !== 'model')), replacementPolicy: { kind: 'replace_combination', allocationPct: 100 }, inputRefs: [] };
}
/** Every committed step is recovered through its original receipt, never inferred from the latest team version. */
export async function executeGuidedTeam(record: GuidedTeamRecord, progress: Progress, ports: GuidedTeamPorts = defaultPorts): Promise<string> {
  if (record.reviewRequired) throw new GuidedTeamReviewRequired(record.reviewRequired);
  validateGuidedTeamStart(record);
  const save = (label: string) => progress(record, label);
  if (!record.teamId) {
    if (Date.parse(record.preview.expiresAt) <= Date.now()) requireReview(record, 'seed', progress);
    save('team');
    const team = await ports.teams.create({ requestKey: keyFor(record, 'team'), name: record.name, description: 'Guided team: persistent agents and independent paper account' });
    record.teamId = team.id; save('members');
  }
  let team = await ports.teams.detail(record.teamId);
  if (team.status !== 'active') requireReview(record, 'changed', progress);
  if (!record.draftSaved) {
    if (!record.draft) { record.draft = { requestKey: keyFor(record, 'draft'), expectedSemanticRevision: team.semanticRevision, config: rosterTeamConfig(record.agents, record.models, record.agents.map(() => crypto.randomUUID())) }; save('members'); }
    await confirmed(record, 'publish', progress, () => ports.teams.saveDraft(team.id, record.draft!)); record.draftSaved = true; save('members');
  }
  if (!record.displaySaved) {
    if (!record.display) { record.display = { requestKey: keyFor(record, 'display'), expectedDisplayRevision: team.displayRevision, display: { ...team.display, name: record.name, roleLabels: Object.fromEntries(record.draft!.config.roles.map((role, index) => [role.id, record.agents[index].name])) } }; save('members'); }
    await confirmed(record, 'publish', progress, () => ports.teams.saveDisplay(team.id, record.display!)); record.displaySaved = true; save('publish');
  }
  if (!record.publishedVersionId) {
    team = await ports.teams.detail(team.id);
    if (!record.publish) {
      if (team.currentVersionId || stable(team.draft.config) !== stable(record.draft?.config)) requireReview(record, 'changed', progress);
      if (!record.publishInput) { record.publishInput = { requestKey: keyFor(record, 'publish-preview', 'publish'), expectedSemanticRevision: team.semanticRevision }; save('publish'); }
      record.publish = await ports.teams.publishPreview(team.id, record.publishInput); save('publish');
    }
    const receipt = await confirmed(record, 'publish', progress, () => ports.teams.publish(team.id, { requestKey: keyFor(record, 'publish', 'publish'), previewId: record.publish!.previewId, previewHash: record.publish!.previewHash }));
    if (stable(receipt.version.config) !== stable(record.draft?.config)) requireReview(record, 'changed', progress);
    record.publishedVersionId = receipt.version.id; save('publish');
  }
  team = await ports.teams.detail(team.id); assertVersion(record, team, progress);
  if (!record.accountId) {
    save('account');
    if (!record.accountInput) { record.accountInput = { requestKey: keyFor(record, 'account', 'seed'), previewId: record.preview.previewId, name: `${record.name}${record.language === 'en' ? ' simulation' : ' 模拟盘'}`.slice(0, 80), confirmOpeningCash: true }; save('account'); }
    const account = await confirmed(record, 'seed', progress, () => ports.accounts.create(record.accountInput!));
    record.accountId = account.accountId; save('binding');
  }
  team = await ports.teams.detail(team.id); assertVersion(record, team, progress);
  if (!record.bindingId) {
    if (!record.binding) {
      if (team.binding || team.accountId) requireReview(record, 'changed', progress);
      if (!record.bindingInput) { record.bindingInput = { requestKey: keyFor(record, 'binding-preview', 'binding'), action: 'assign', accountId: record.accountId, teamVersionId: record.publishedVersionId!, expectedBindingRevision: team.bindingRevision, expectedAccountBindingId: null, executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true }; save('binding'); }
      record.binding = await ports.teams.bindingPreview(team.id, record.bindingInput); save('binding');
    }
    const receipt = await confirmed(record, 'binding', progress, () => ports.teams.binding(team.id, { requestKey: keyFor(record, 'binding', 'binding'), previewId: record.binding!.previewId, previewHash: record.binding!.previewHash }));
    if (!receipt.binding || receipt.binding.accountId !== record.accountId || receipt.binding.teamVersionId !== record.publishedVersionId) requireReview(record, 'changed', progress);
    record.bindingId = receipt.binding.id; record.bindingRevision = receipt.team.bindingRevision; save('binding');
  }
  team = await ports.teams.detail(team.id); assertBinding(record, team, progress);
  if (!record.agreement) {
    if (!record.agreementPreview) {
      const status = await ports.runs.status(team.id);
      if (status.agreement) requireReview(record, 'changed', progress);
      if (!record.agreementInput) { record.agreementInput = agreementInput(record, team); save('agreement'); }
      record.agreementPreview = await ports.runs.preview(team.id, record.agreementInput); save('agreement');
    }
    record.agreement = await confirmed(record, 'agreement', progress, () => ports.runs.confirm(team.id, { requestKey: keyFor(record, 'agreement', 'agreement'), previewId: record.agreementPreview!.previewId, previewHash: record.agreementPreview!.previewHash })); save('start');
  }
  if (!record.agreementInput) requireReview(record, 'changed', progress);
  const { requestKey: _requestKey, ...configuration } = record.agreementInput;
  if (record.agreement.accountId !== record.accountId || stable(record.agreement.configuration) !== stable(configuration)) requireReview(record, 'changed', progress);
  await confirmed(record, 'agreement', progress, () => ports.runs.start(team.id, { requestKey: keyFor(record, 'start', 'agreement'), expectedRevision: record.agreement!.revision }));
  const current = (await ports.runs.status(team.id)).agreement;
  if (!current || current.id !== record.agreement.id || current.state !== 'running' || stable(current.configuration) !== stable(configuration)) requireReview(record, 'changed', progress);
  save('done'); return team.id;
}
/** A fresh preview is prepared only after a definite rejection and is shown for another explicit review. */
export async function refreshGuidedTeamReview(record: GuidedTeamRecord, progress: Progress, ports: GuidedTeamPorts = defaultPorts): Promise<void> {
  const stage = record.reviewRequired;
  if (!stage || stage === 'changed') throw new GuidedTeamReviewRequired('changed');
  if (record.refreshPending !== stage) {
    record.reviewEpochs = { ...record.reviewEpochs, [stage]: (record.reviewEpochs?.[stage] ?? 0) + 1 };
    record.refreshPending = stage;
    if (stage === 'seed') delete record.accountInput;
    if (stage === 'publish') { delete record.publish; delete record.publishInput; }
    if (stage === 'binding') { delete record.binding; delete record.bindingInput; }
    if (stage === 'agreement') { delete record.agreementPreview; delete record.agreementInput; }
    progress(record, stage);
  }
  if (stage === 'seed') {
    if (record.accountId || !ports.previewHoldings) throw new GuidedTeamReviewRequired('changed');
    record.preview = await ports.previewHoldings({ origin: 'holdings', requestKey: keyFor(record, 'seed', 'seed') });
  } else {
    const team = await ports.teams.detail(record.teamId!);
    if (stage === 'publish') {
      if (team.status !== 'active' || team.currentVersionId || stable(team.draft.config) !== stable(record.draft?.config)) requireReview(record, 'changed', progress);
      if (!record.publishInput) { record.publishInput = { requestKey: keyFor(record, 'publish-preview', 'publish'), expectedSemanticRevision: team.semanticRevision }; progress(record, stage); }
      record.publish = await ports.teams.publishPreview(team.id, record.publishInput);
    } else if (stage === 'binding') {
      assertVersion(record, team, progress);
      if (team.binding || team.accountId) requireReview(record, 'changed', progress);
      if (!record.bindingInput) { record.bindingInput = { requestKey: keyFor(record, 'binding-preview', 'binding'), action: 'assign', accountId: record.accountId!, teamVersionId: record.publishedVersionId!, expectedBindingRevision: team.bindingRevision, expectedAccountBindingId: null, executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true }; progress(record, stage); }
      record.binding = await ports.teams.bindingPreview(team.id, record.bindingInput);
    } else {
      assertBinding(record, team, progress);
      if ((await ports.runs.status(team.id)).agreement) requireReview(record, 'changed', progress);
      if (!record.agreementInput) { record.agreementInput = agreementInput(record, team); progress(record, stage); }
      record.agreementPreview = await ports.runs.preview(team.id, record.agreementInput);
    }
  }
  delete record.reviewRequired; delete record.refreshPending;
  if (stage === 'seed' && guidedSeedBlockers(record.preview.needsInput).length) record.reviewRequired = 'seed';
  progress(record, 'review');
}
export function readGuidedTeam(): GuidedTeamRecord | null {
  try { const value = JSON.parse(sessionStorage.getItem(GUIDED_TEAM_KEY) ?? 'null'); return value?.version === 1 && typeof value.key === 'string' && Array.isArray(value.agents) && value.preview?.previewId ? value : null; } catch { return null; }
}
