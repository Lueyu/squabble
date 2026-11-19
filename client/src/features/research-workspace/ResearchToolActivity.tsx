import { useRef } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import http from '@/api/http';
import { listToolActions } from '@/api/tool-connections';
import { recoverResearchRuntime } from '@/api/research-conversations';
import { ToolActionPreview } from '@/features/tool-connections/ToolActionPreview';
import { Button } from '@/components/ui/button';
import type { ResearchConversationView } from '@shared/simple-conversation.interface';
import type { CouncilRuntimeRecoveryInput, CouncilRuntimePending } from '@shared/research-runtime.interface';

interface RunStatus {
  id: string; state: string; cursor: number;
  steps: Array<{ id: string; index: number; state: string; model: string; hasStoredResponse: boolean; usageKnown: boolean }>;
  tools: Array<{ id: string; toolId: string; state: string }>;
}

/** Reads durable facts; only explicit recovery buttons may resume execution. */
export function ResearchToolActivity({ session, readOnly = false }: { session: ResearchConversationView; readOnly?: boolean }) {
  const zh = useTranslation().i18n.language.startsWith('zh'), client = useQueryClient();
  const intents = useRef(new Map<string, string>());
  const runs = useQuery({ queryKey: ['research-runtime', session.id], retry: false,
    queryFn: async () => (await http.get<RunStatus[]>('/api/research-runtime', { params: { sessionId: session.id } })).data,
    refetchInterval: session.status === 'running' ? 3000 : false });
  const approvalRuns = (session.runtimePending ?? []).filter(item => item.state === 'waiting_approval');
  const approvals = useQueries({ queries: approvalRuns.map(({ runId }) => ({
    queryKey: ['tool-actions', session.id, runId], retry: false, queryFn: () => listToolActions(runId),
  })) });
  const failedApprovals = approvals.filter(query => query.isError);
  const previewsByRun = new Map(approvalRuns.map(({ runId }, index) => [runId, approvals[index]?.data]));
  const recovery = useMutation({ retry: false, mutationFn: async ({ pending, action }: {
    pending: CouncilRuntimePending; action: CouncilRuntimeRecoveryInput['action'];
  }) => {
    const payload = { action, expectedRevision: session.revision,
      runtimeTarget: { runId: pending.runId, stepId: pending.stepId, expectedCursor: pending.expectedCursor } };
    const identity = JSON.stringify(payload), requestKey = intents.current.get(identity) ?? crypto.randomUUID();
    intents.current.set(identity, requestKey);
    const saved = await recoverResearchRuntime(session.id, { ...payload, requestKey });
    intents.current.delete(identity);
    client.setQueryData(['research-conversation', session.id], saved);
    await client.invalidateQueries({ queryKey: ['research-runtime', session.id] });
  } });
  if (!runs.data?.length && !session.runtimePending?.length && !runs.isError) return null;
  return <section className="space-y-3 rounded-xl border p-3" aria-label={zh ? '工具研究活动' : 'Research tool activity'}>
    <h3 className="text-sm font-medium">{zh ? '工具研究活动' : 'Research tool activity'}</h3>
    {runs.isError && <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-xs text-destructive">{zh ? '无法读取已保存的运行。' : 'Could not load saved runs.'}</p>
      <Button type="button" size="sm" variant="outline" disabled={runs.isFetching} onClick={() => void runs.refetch()}>
        {zh ? '重试读取运行' : 'Retry saved runs'}
      </Button>
    </div>}
    {failedApprovals.length > 0 && <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-xs text-destructive">{zh ? '无法读取审批预览。' : 'Could not load approval previews.'}</p>
      <Button type="button" size="sm" variant="outline" disabled={failedApprovals.some(query => query.isFetching)}
        onClick={() => { for (const query of failedApprovals) void query.refetch(); }}>
        {zh ? '重试读取审批预览' : 'Retry approval previews'}
      </Button>
    </div>}
    {runs.data?.map(run => <details key={run.id} className="text-xs">
      <summary>{zh ? '已保存运行' : 'Saved run'} · {run.state} · {run.steps.length} {zh ? '模型步骤' : 'model steps'}</summary>
      <ul className="mt-2 space-y-1">{run.steps.map(step => <li key={step.id}>{step.index + 1}. {step.model} · {step.state} · {step.usageKnown ? (zh ? '用量已记录' : 'Usage recorded') : (zh ? '用量未知' : 'Usage unknown')}</li>)}
        {run.tools.map(tool => <li key={tool.id}>{tool.toolId} · {tool.state}</li>)}</ul>
    </details>)}
    {session.runtimePending?.map(pending => {
      const run = runs.data?.find(item => item.id === pending.runId), last = run?.steps.at(-1);
      const previews = previewsByRun.get(pending.runId)?.filter(item => item.runId === pending.runId) ?? [];
      return <article key={pending.runId} className="space-y-3 rounded-lg bg-muted/40 p-3">
        <p className="text-sm">{session.members?.find(member => member.id === pending.memberId)?.name ?? pending.memberId} · {run?.state ?? pending.state}</p>
        {pending.state === 'provider_unknown' && <p className="text-xs text-muted-foreground">{zh
          ? '该同步模型接口不支持远端查回。不会重发未知请求；关闭后仍保留未知费用预留。'
          : 'This synchronous model API cannot retrieve a remote result. The unknown request will not be resent; closing retains the unknown cost reservation.'}</p>}
        {!readOnly && previews.map(action => <ToolActionPreview key={`${action.id}:${action.revision}`} action={action} />)}
        {!readOnly && !pending.resumeRequested && <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={recovery.isPending} onClick={() => recovery.mutate({ pending, action: 'check_existing' })}>{zh ? '刷新已保存状态' : 'Refresh saved status'}</Button>
          {pending.state === 'waiting_approval' && <Button size="sm" disabled={recovery.isPending || !previews.length || previews.some(item => !['approved', 'completed'].includes(item.state))}
            onClick={() => recovery.mutate({ pending, action: 'resume_approval' })}>{zh ? '批准后继续原运行' : 'Resume original run after approval'}</Button>}
          {pending.state === 'failed' && last?.state === 'parse_failed' && last.hasStoredResponse && <Button size="sm" disabled={recovery.isPending}
            onClick={() => recovery.mutate({ pending, action: 'reparse_existing' })}>{zh ? '仅重新校验保存的回答' : 'Revalidate saved response only'}</Button>}
          {pending.state === 'provider_unknown' && <Button size="sm" variant="outline" disabled={recovery.isPending}
            onClick={() => recovery.mutate({ pending, action: 'close_unknown' })}>{zh ? '关闭未知运行并保留预留' : 'Close unknown run; retain reservation'}</Button>}
        </div>}
      </article>;
    })}
    {recovery.isError && <p role="alert" className="text-xs text-destructive">{zh ? '状态尚未确认；已有结果仍保留，请刷新后重试。' : 'Status is unconfirmed. Saved results remain; refresh and retry.'}</p>}
  </section>;
}
