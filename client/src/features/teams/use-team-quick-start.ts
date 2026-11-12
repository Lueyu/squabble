import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { fetchModelConnections } from '@/api/model-connections';
import { previewAiInvestment } from '@/api/ai-investment';
import { portfolioWorkspaceApi, portfolioWorkspaceKeys } from '@/api/portfolio-workspace';
import { teamKeys, teamsApi } from '@/api/teams';
import { friendlyError } from '@/utils/error-message';
import {
  adoptCreatedAccount, applyQuickStartExecutors, clearStoredQuickStart, initialQuickStartKeys, initialQuickStartProgress,
  quickStartAccountName, quickStartCreateAccountRequest, quickStartFailureKind, quickStartPreviewRequest, readStoredQuickStart,
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
  const recordRef = useRef<StoredQuickStart | null>(null);
  const runningRef = useRef(false);
  const [state, setState] = useState<QuickStartRunState>(IDLE);

  const persist = useCallback((record: StoredQuickStart): void => {
    recordRef.current = record;
    writeStoredQuickStart(record);
    setState(current => ({ ...current, progress: record.progress }));
  }, []);

  const execute = useCallback(async (record: StoredQuickStart, knownAccountIds: ReadonlySet<string>): Promise<void> => {
    const input = record.input;
    const setStep = (id: QuickStartStepId, stepState: 'running' | 'done' | 'failed'): void => {
      record.progress = updateQuickStartStep(record.progress, id, stepState);
      persist(record);
    };
    const fail = (error: unknown, id: QuickStartStepId): void => {
      setStep(id, 'failed');
      const failureKind = quickStartFailureKind(error);
      if (failureKind === 'rejected') { clearStoredQuickStart(); recordRef.current = null; } else persist(record);
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
          const team = await teamsApi.create({ requestKey: record.keys.team, name: input.name.trim(), description: input.description.trim(), avatar: input.avatar.trim() || null, templateId: input.templateId });
          record.progress.teamId = team.id;
          persist(record);
        } catch (error) { return fail(error, 'team'); }
      }
      setStep('team', 'done');

      // Step 2: enable every template role on the default connection (skipped when no connection was chosen).
      if (record.progress.steps.some(step => step.id === 'draft')) {
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
      if (record.progress.steps.some(step => step.id === 'publish')) {
        let current = await teamsApi.detail(record.progress.teamId!);
        if (!current.currentVersionId) {
          setStep('publish', 'running');
          try {
            const publishOnce = async () => {
              const preview = await teamsApi.publishPreview(record.progress.teamId!, { requestKey: record.keys.publishPreview, expectedSemanticRevision: current.draft.semanticRevision });
              const result = await teamsApi.publish(record.progress.teamId!, { requestKey: record.keys.publishConfirm, previewId: preview.previewId, previewHash: preview.previewHash });
              return result.version.id;
            };
            try { record.progress.versionId = await publishOnce(); }
            catch (error) {
              if (quickStartFailureKind(error) !== 'recoverable-preview') throw error;
              record.keys.publishPreview = crypto.randomUUID(); record.keys.publishConfirm = crypto.randomUUID();
              current = await teamsApi.detail(record.progress.teamId!);
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
              const preview = await previewAiInvestment(quickStartPreviewRequest(input.seed, record.keys.accountPreview));
              return portfolioWorkspaceApi.create(quickStartCreateAccountRequest(accountName, preview.previewId, record.keys.accountCreate));
            };
            const createWithRecovery = async (): Promise<{ accountId: string }> => {
              try { return await createOnce(); }
              catch (error) {
                if (quickStartFailureKind(error) !== 'recoverable-preview') throw error;
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
      if (record.progress.steps.some(step => step.id === 'binding')) {
        const accountId = record.progress.accountId ?? (input.seed.kind === 'existing' ? input.seed.accountId : null);
        if (!accountId) return fail(new Error(zh ? '缺少待关联的模拟账户。' : 'No simulation account to bind.'), 'binding');
        let current = await teamsApi.detail(record.progress.teamId!);
        if (!(current.accountId === accountId && current.binding?.state === 'active')) {
          setStep('binding', 'running');
          try {
            const bindOnce = async () => {
              const teamVersionId = record.progress.versionId ?? current.currentVersionId;
              if (!teamVersionId) throw new Error(zh ? '缺少已发布版本，无法关联账户。' : 'A published version is required before binding.');
              const existing = (await teamsApi.list({ status: 'active', limit: 100 })).items.find(item => item.accountId === accountId)?.binding ?? null;
              const preview = await teamsApi.bindingPreview(record.progress.teamId!, {
                requestKey: record.keys.bindingPreview, action: 'assign', accountId, teamVersionId,
                expectedBindingRevision: current.bindingRevision, expectedAccountBindingId: existing?.id ?? null,
                executionChoice: 'keep_confirmed_rules', acknowledgePendingReapproval: true,
              });
              return teamsApi.binding(record.progress.teamId!, { requestKey: record.keys.bindingConfirm, previewId: preview.previewId, previewHash: preview.previewHash });
            };
            try { record.progress.bindingId = (await bindOnce()).binding?.id ?? null; }
            catch (error) {
              if (quickStartFailureKind(error) !== 'recoverable-preview') throw error;
              record.keys.bindingPreview = crypto.randomUUID(); record.keys.bindingConfirm = crypto.randomUUID();
              current = await teamsApi.detail(record.progress.teamId!);
              persist(record);
              record.progress.bindingId = (await bindOnce()).binding?.id ?? null;
            }
            persist(record);
          } catch (error) { return fail(error, 'binding'); }
        }
        setStep('binding', 'done');
      }
    } finally { runningRef.current = false; }

    clearStoredQuickStart();
    recordRef.current = null;
    setState({ status: 'done', progress: record.progress, failureKind: null, message: null, input });
    await client.invalidateQueries({ queryKey: teamKeys.all });
    await client.invalidateQueries({ queryKey: portfolioWorkspaceKeys.accounts });
    navigate(`/teams/${encodeURIComponent(record.progress.teamId!)}?quickStarted=1`);
  }, [client, navigate, persist, zh]);

  const run = useCallback((input: QuickStartInput, knownAccountIds: ReadonlySet<string>): void => {
    if (runningRef.current) return;
    runningRef.current = true;
    try { window.sessionStorage.removeItem('squabble.team-create'); } catch { /* The chain record replaces the form draft. */ }
    const record: StoredQuickStart = { savedAt: new Date().toISOString(), input, keys: initialQuickStartKeys(), progress: initialQuickStartProgress(input) };
    persist(record);
    void execute(record, knownAccountIds);
  }, [execute, persist]);

  const resume = useCallback((knownAccountIds: ReadonlySet<string>): void => {
    if (runningRef.current) return;
    const record = recordRef.current ?? readStoredQuickStart();
    if (!record || record.progress.steps.every(step => step.state === 'done')) return;
    runningRef.current = true;
    void execute(record, knownAccountIds);
  }, [execute]);

  const reset = useCallback((): void => {
    recordRef.current = null;
    clearStoredQuickStart();
    setState(IDLE);
  }, []);

  /** A stored or in-memory record with unfinished steps stays resumable across reloads and dialog closes. */
  const resumable = storedQuickStartResumable(recordRef.current ?? readStoredQuickStart());

  return { state, resumable, run, resume, reset };
}
