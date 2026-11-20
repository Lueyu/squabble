import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { fetchModelConnections } from '@/api/model-connections';
import { previewAiInvestment } from '@/api/ai-investment';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import type { AiInvestmentPreview } from '@shared/investment-policy.interface';
import { teamKeys, teamsApi } from '@/api/teams';
import { friendlyError } from '@/utils/error-message';
import { workspaceOwnerScope, writeTabRecovery } from '@/utils/workspace-tab-recovery';
import { teamOnboardingPath } from '@/features/onboarding/onboarding-state';
import {
  adoptCreatedAccount, applyQuickStartExecutors, configureTemplateRoute, clearStoredQuickStart, initialQuickStartKeys, initialQuickStartProgress,
  quickStartAccountName, quickStartCreateAccountRequest, quickStartFailureKind, quickStartPreviewRequest, quickStartTeamRequest, readStoredQuickStart,
  storedQuickStartResumable, updateQuickStartStep, writeStoredQuickStart,
  type QuickStartFailureKind, type QuickStartInput, type QuickStartProgress, type QuickStartStepId, type StoredQuickStart,
} from './team-quick-start';

export interface QuickStartRunState {
  status: 'idle' | 'running' | 'failed' | 'done';
  progress: QuickStartProgress | null;
  failureKind: QuickStartFailureKind | null;
  message: string | null;
  input: QuickStartInput | null;
}

const IDLE: QuickStartRunState = { status: 'idle', progress: null, failureKind: null, message: null, input: null };

/**
 * Orchestration for the template quick start. Each step re-reads fresh team
 * state and skips itself when its goal is already observable, so an interrupted
 * chain resumes without replaying committed mutations; request keys persist in
 * the session record so an uncertain outcome replays the same request.
 */
export function useTeamQuickStart(zh: boolean) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const owner = workspaceOwnerScope();
  const recordRef = useRef<StoredQuickStart | null>(null);
  const runningRef = useRef(false);
  const [state, setState] = useState<QuickStartRunState>(() => {
    const record = readStoredQuickStart();
    return record && storedQuickStartResumable(record) ? {
      status: 'failed', progress: record.progress, failureKind: record.failureKind ?? null, message: null, input: record.input,
    } : IDLE;
  });

  const persist = useCallback((record: StoredQuickStart): void => {
    if (workspaceOwnerScope() !== owner) throw new Error('Workspace session changed');
    if (!writeStoredQuickStart(record) && record.input.onboarding) throw new Error(zh
      ? '无法在此浏览器保留建队请求。请启用会话存储后重试。'
      : 'This browser could not retain the creation request. Enable session storage and retry.');
    recordRef.current = record;
    setState(current => ({ ...current, progress: record.progress }));
  }, [owner, zh]);

  const execute = useCallback(async (record: StoredQuickStart, knownAccountIds: ReadonlySet<string>): Promise<void> => {
    const input = record.input;
    const setStep = (id: QuickStartStepId, stepState: 'running' | 'done' | 'failed'): void => {
      record.progress = updateQuickStartStep(record.progress, id, stepState);
      persist(record);
    };
    const fail = (error: unknown, id: QuickStartStepId): void => {
      if (workspaceOwnerScope() !== owner) return;
      const failureKind = quickStartFailureKind(error);
      record.failureKind = failureKind;
      record.progress = updateQuickStartStep(record.progress, id, 'failed');
      recordRef.current = record;
      writeStoredQuickStart(record);
      if (failureKind === 'rejected' && !input.reviewedSeed) { clearStoredQuickStart(); recordRef.current = null; }
      setState({
        status: 'failed', progress: record.progress, failureKind, input,
        message: friendlyError(error, zh, { zh: '快速开始未完成，已完成的步骤已保留。', en: 'Quick start did not finish. Completed steps are retained.' }),
      });
    };
    setState({ status: 'running', progress: record.progress, failureKind: null, message: null, input });
    try {
      // Step 1: the team draft from the chosen template.
      if (!record.progress.teamId) {
        setStep('team', 'running');
        try {
          const team = await teamsApi.create(quickStartTeamRequest(input, record.keys.team));
          record.progress.teamId = team.id;
          record.initialSemanticRevision = team.draft.semanticRevision;
          persist(record);
        } catch (error) { return fail(error, 'team'); }
      }
      setStep('team', 'done');

      // Step 2: enable every template role on the default connection (skipped when no connection was chosen).
      if (input.templateRoute && record.progress.steps.some(step => step.id === 'draft' && step.state !== 'done')) {
        setStep('draft', 'running');
        try {
          if (!record.draftRequest) {
            const current = await teamsApi.detail(record.progress.teamId!);
            record.draftRequest = {
              requestKey: record.keys.draft,
              expectedSemanticRevision: record.initialSemanticRevision ?? current.draft.semanticRevision,
              config: configureTemplateRoute(current.draft.config, input.templateRoute),
            };
            persist(record);
          }
          const saved = await teamsApi.saveDraft(record.progress.teamId!, record.draftRequest);
          record.initialSemanticRevision = saved.draft.semanticRevision;
          setStep('draft', 'done');
        } catch (error) { return fail(error, 'draft'); }
      } else if (!input.templateRoute && record.progress.steps.some(step => step.id === 'draft')) {
        const current = await teamsApi.detail(record.progress.teamId!);
        if (current.draft.config.roles.some(role => role.participation !== 'enabled' || !role.executor)) {
          setStep('draft', 'running');
          try {
            const connection = (await fetchModelConnections()).find(item => item.id === input.connectionId);
            if (!connection || !connection.available) throw new Error(zh ? '所选默认执行连接已不可用，请在设置中核对后重试。' : 'The chosen default connection is unavailable. Check it in settings and retry.');
            await teamsApi.saveDraft(record.progress.teamId!, { requestKey: record.keys.draft, expectedSemanticRevision: current.draft.semanticRevision, config: applyQuickStartExecutors(current.draft.config, connection, current.draft.config.defaults.leadRoleId) });
          } catch (error) { return fail(error, 'draft'); }
        }
        setStep('draft', 'done');
      }

      // Step 3: publish the template configuration as v1.
      if (record.progress.steps.some(step => step.id === 'publish' && step.state !== 'done')) {
        let current = await teamsApi.detail(record.progress.teamId!);
        if (record.publishPreview || !current.currentVersionId) {
          setStep('publish', 'running');
          try {
            const publishOnce = async () => {
              if (!record.publishPreview) {
                if (input.reviewedSeed && record.initialSemanticRevision != null
                  && current.draft.semanticRevision !== record.initialSemanticRevision) {
                  throw new Error(zh ? '团队草稿已变化，请在团队内核对并发布。' : 'The team draft changed. Review and publish it in the team workspace.');
                }
                record.publishPreview = { requestKey: record.keys.publishPreview, expectedSemanticRevision: current.draft.semanticRevision };
                persist(record);
              }
              if (!record.publishConfirm) {
                const preview = await teamsApi.publishPreview(record.progress.teamId!, record.publishPreview);
                record.publishConfirm = { requestKey: record.keys.publishConfirm, previewId: preview.previewId, previewHash: preview.previewHash };
                persist(record);
              }
              const result = await teamsApi.publish(record.progress.teamId!, record.publishConfirm);
              return result.version.id;
            };
            try { record.progress.versionId = await publishOnce(); }
            catch (error) {
              if (quickStartFailureKind(error) !== 'recoverable-preview') throw error;
              delete record.publishPreview;
              delete record.publishConfirm;
              current = await teamsApi.detail(record.progress.teamId!);
              if (current.currentVersionId) return fail(error, 'publish');
              record.keys.publishPreview = crypto.randomUUID();
              record.keys.publishConfirm = crypto.randomUUID();
              persist(record);
              record.progress.versionId = await publishOnce();
            }
            persist(record);
          } catch (error) { return fail(error, 'publish'); }
        } else record.progress.versionId ??= current.currentVersionId;
        setStep('publish', 'done');
      }

      // Step 4: create the simulation account from the reviewed seed.
      if (record.progress.steps.some(step => step.id === 'account')) {
        if (!record.progress.accountId) {
          setStep('account', 'running');
          const accountName = quickStartAccountName(input, zh);
          try {
            const createOnce = async (): Promise<{ accountId: string }> => {
              const preview = input.reviewedSeed ?? await previewAiInvestment(quickStartPreviewRequest(input.seed, record.keys.accountPreview));
              return portfolioWorkspaceApi.create(quickStartCreateAccountRequest(accountName, preview.previewId, record.keys.accountCreate));
            };
            const createWithRecovery = async (): Promise<{ accountId: string }> => {
              try { return await createOnce(); }
              catch (error) {
                if (input.reviewedSeed || quickStartFailureKind(error) !== 'recoverable-preview') throw error;
                const adopted = adoptCreatedAccount(await portfolioWorkspaceApi.accounts(), knownAccountIds, accountName);
                if (adopted) return { accountId: adopted };
                record.keys.accountPreview = crypto.randomUUID(); record.keys.accountCreate = crypto.randomUUID();
                persist(record);
                return createOnce();
              }
            };
            record.progress.accountId = (await createWithRecovery()).accountId;
            persist(record);
          } catch (error) { return fail(error, 'account'); }
          try { await portfolioWorkspaceApi.setCompanion(record.progress.accountId, { companionId: 'value', expectedRevision: 0, requestKey: record.keys.accountCompanion }); }
          catch { /* Companion identity is presentation only; the account stays fully usable without it. */ }
        }
        setStep('account', 'done');
      }

      // Step 5: bind the account to the published version. A fresh account has
      // no confirmed rules, so continuing them is a documented no-op choice.
      if (record.progress.steps.some(step => step.id === 'binding' && step.state !== 'done')) {
        const accountId = record.progress.accountId ?? (input.seed.kind === 'existing' ? input.seed.accountId : null);
        if (!accountId) return fail(new Error(zh ? '缺少待关联的模拟账户。' : 'No simulation account to bind.'), 'binding');
        let current = await teamsApi.detail(record.progress.teamId!);
        if (record.bindingPreview || !(current.accountId === accountId && current.binding?.state === 'active')) {
          setStep('binding', 'running');
          try {
            const bindOnce = async () => {
              const teamVersionId = record.progress.versionId ?? current.currentVersionId;
              if (!teamVersionId) throw new Error(zh ? '缺少已发布版本，无法关联账户。' : 'A published version is required before binding.');
              if (!record.bindingPreview) {
                const existing = input.reviewedSeed ? null
                  : (await teamsApi.list({ status: 'active', limit: 100 })).items.find(item => item.accountId === accountId)?.binding ?? null;
                record.bindingPreview = {
                  requestKey: record.keys.bindingPreview, action: 'assign', accountId, teamVersionId,
                  expectedBindingRevision: current.bindingRevision, expectedAccountBindingId: existing?.id ?? null,
                  executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true,
                };
                persist(record);
              }
              if (!record.bindingConfirm) {
                const preview = await teamsApi.bindingPreview(record.progress.teamId!, record.bindingPreview);
                record.bindingConfirm = { requestKey: record.keys.bindingConfirm, previewId: preview.previewId, previewHash: preview.previewHash };
                persist(record);
              }
              return teamsApi.binding(record.progress.teamId!, record.bindingConfirm);
            };
            try { record.progress.bindingId = (await bindOnce()).binding?.id ?? null; }
            catch (error) {
              if (quickStartFailureKind(error) !== 'recoverable-preview') throw error;
              current = await teamsApi.detail(record.progress.teamId!);
              if (current.binding?.state === 'active') {
                if (current.accountId !== accountId) return fail(error, 'binding');
                record.progress.bindingId = current.binding.id;
                setStep('binding', 'done');
                return finish(record);
              }
              delete record.bindingPreview;
              delete record.bindingConfirm;
              record.keys.bindingPreview = crypto.randomUUID();
              record.keys.bindingConfirm = crypto.randomUUID();
              persist(record);
              record.progress.bindingId = (await bindOnce()).binding?.id ?? null;
            }
            persist(record);
          } catch (error) { return fail(error, 'binding'); }
        }
        setStep('binding', 'done');
      }
    } catch (error) {
      const step = record.progress.steps.find(item => item.state !== 'done')?.id;
      if (step) return fail(error, step);
    } finally { runningRef.current = false; }

    await finish(record);

    async function finish(completed: StoredQuickStart): Promise<void> {
      const teamId = completed.progress.teamId;
      if (!teamId || workspaceOwnerScope() !== owner) return;
      clearStoredQuickStart();
      recordRef.current = null;
      setState({ status: 'done', progress: completed.progress, failureKind: null, message: null, input });
      await client.invalidateQueries({ queryKey: teamKeys.all });
      await client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.accounts });
      navigate(input.onboarding ? teamOnboardingPath(teamId, 'organization')
        : `/teams/${encodeURIComponent(teamId)}?${input.reviewedSeed ? 'panel=overview' : 'quickStarted=1'}`);
    }
  }, [client, navigate, owner, persist, zh]);

  const run = useCallback((input: QuickStartInput, knownAccountIds: ReadonlySet<string>): void => {
    if (runningRef.current) return;
    const retained = recordRef.current ?? readStoredQuickStart();
    if (storedQuickStartResumable(retained) && retained?.failureKind !== 'name-conflict') {
      runningRef.current = true;
      void execute(retained!, knownAccountIds);
      return;
    }
    const record: StoredQuickStart = {
      savedAt: new Date().toISOString(),
      input: { ...input, accountName: quickStartAccountName(input, zh) },
      keys: initialQuickStartKeys(),
      progress: initialQuickStartProgress(input),
    };
    if (input.reviewedSeed) record.keys.accountPreview = input.reviewedSeed.requestKey;
    try { persist(record); }
    catch (error) {
      setState({ status: 'failed', progress: null, failureKind: 'rejected', message: error instanceof Error ? error.message : null, input });
      return;
    }
    runningRef.current = true;
    if (input.onboarding) writeTabRecovery('team-create', null);
    else try { window.sessionStorage.removeItem('squabble.team-create'); } catch { /* The saved chain supersedes the form draft. */ }
    void execute(record, knownAccountIds);
  }, [execute, persist, zh]);

  const resume = useCallback((knownAccountIds: ReadonlySet<string>): void => {
    if (runningRef.current) return;
    const record = recordRef.current ?? readStoredQuickStart();
    if (!record || record.failureKind === 'name-conflict' || record.progress.steps.every(step => step.state === 'done') ||
        record.input.reviewedSeed && record.failureKind === 'recoverable-preview'
          && record.progress.steps.some(step => step.id === 'account' && step.state === 'failed')) return;
    runningRef.current = true;
    void execute(record, knownAccountIds);
  }, [execute]);

  const reset = useCallback((): void => {
    recordRef.current = null;
    clearStoredQuickStart();
    setState(IDLE);
  }, []);

  /** Expired reviewed seeds need a fresh visible snapshot; completed team/publication steps remain intact. */
  const refreshSeedReview = useCallback(async (): Promise<AiInvestmentPreview> => {
    const record = recordRef.current ?? readStoredQuickStart();
    if (!record?.input.reviewedSeed || record.progress.accountId || state.failureKind !== 'recoverable-preview') throw new Error('A rejected account preview is required before a fresh review');
    if (!record.accountReviewKey || record.receivedAccountReview?.requestKey === record.accountReviewKey && Date.parse(record.receivedAccountReview.expiresAt) <= Date.now()) {
      record.accountReviewKey = crypto.randomUUID();
      delete record.receivedAccountReview;
    }
    persist(record);
    const preview = await previewAiInvestment(quickStartPreviewRequest(record.input.seed, record.accountReviewKey));
    record.receivedAccountReview = { requestKey: record.accountReviewKey, previewId: preview.previewId, expiresAt: preview.expiresAt };
    persist(record);
    return preview;
  }, [persist, state.failureKind]);

  const resumeWithSeedReview = useCallback((preview: AiInvestmentPreview, knownAccountIds: ReadonlySet<string>): void => {
    const record = recordRef.current ?? readStoredQuickStart();
    if (runningRef.current || !record?.accountReviewKey || record.progress.accountId || state.failureKind !== 'recoverable-preview'
      || record.receivedAccountReview?.previewId !== preview.previewId || Date.parse(preview.expiresAt) <= Date.now()) return;
    record.input = { ...record.input, reviewedSeed: { previewId: preview.previewId, requestKey: record.accountReviewKey } };
    record.keys.accountPreview = record.accountReviewKey;
    record.keys.accountCreate = crypto.randomUUID();
    delete record.accountReviewKey;
    delete record.receivedAccountReview;
    persist(record);
    runningRef.current = true;
    void execute(record, knownAccountIds);
  }, [execute, persist, state.failureKind]);

  /** A stored or in-memory record with unfinished steps stays resumable across reloads and dialog closes. */
  const retained = recordRef.current ?? readStoredQuickStart();
  const resumable = storedQuickStartResumable(retained);

  return { state, resumable, resumableInput: retained?.input ?? null, run, resume, reset, refreshSeedReview, resumeWithSeedReview };
}
