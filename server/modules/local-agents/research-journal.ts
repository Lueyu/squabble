import type { ResearchActivity, ResearchEvent, ResearchEventStatus } from '../../../shared/research-events.interface';
import type { AgentTask } from './local-agents.store';
import { localAgentLimitMessage } from '../../../shared/local-agent-errors';

const MAX_EVENTS = 256;
const MAX_EVENT_IDS = 2048;
const statuses: ResearchEventStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unavailable'];

export function publicText(value: string, max = 600): string {
  return value.replace(/<(?:think|thinking|reasoning)>[\s\S]*?(?:<\/(?:think|thinking|reasoning)>|$)/gi, '[private content omitted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]{15,})/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?[^\s,"';]+/gi, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, max);
}

/** A second trust boundary after provider parsing / companion input validation. */
export function appendResearchEvents(task: AgentTask, entries: ResearchActivity[], internal = false): void {
  const scope = task.researchScope;
  if (!scope || !internal && !['queued', 'running', 'cancelling'].includes(task.state)) return;
  for (const entry of entries.slice(0, 64)) {
    if (!entry || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(entry.id) || !statuses.includes(entry.status)
      || !['task', 'tool', 'summary', 'capability'].includes(entry.kind) || !internal && entry.kind === 'task'
      || typeof entry.summary !== 'string' || !Number.isFinite(Date.parse(entry.at))) continue;
    const seen = task.eventIds ??= [];
    if (seen.includes(entry.id)) continue;
    if (seen.length >= MAX_EVENT_IDS && !internal) { task.eventsTruncated = true; continue; }
    const at = new Date(Math.max(task.createdAt, Math.min(Date.now(), Date.parse(entry.at)))).toISOString();
    const sources = entry.sources?.slice(0, 8).flatMap(source => {
      if (!source || typeof source.title !== 'string' || !Number.isFinite(Date.parse(source.fetchedAt))) return [];
      let url: string | undefined;
      if (source.url) {
        try {
          const parsed = new URL(source.url);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
            || /^(localhost|127\.|10\.|192\.168\.|\[)/u.test(parsed.hostname)) return [];
          const sensitive = [...parsed.searchParams.keys()].some(key => /token|api[_-]?key|authorization|secret|password|signature/i.test(key));
          parsed.hash = '';
          if (!sensitive && parsed.href.length <= 2048) url = parsed.href;
        } catch { return []; }
      }
      return [{ title: publicText(source.title, 160), fetchedAt: source.fetchedAt, ...(url ? { url } : {}) }];
    });
    const event: ResearchEvent = { id: entry.id, kind: entry.kind, status: entry.status, at, summary: publicText(entry.summary),
      sequence: (task.eventSequence ?? 0) + 1, taskId: task.id, sessionId: scope.sessionId, revision: scope.revision,
      memberId: scope.memberId, memberName: publicText(scope.memberName, 80), turn: scope.turn,
      ...(entry.toolName && /^[A-Za-z][A-Za-z0-9_.:-]{0,100}$/u.test(entry.toolName) ? { toolName: entry.toolName } : {}),
      ...(entry.callId && /^[A-Za-z0-9_.:-]{1,128}$/u.test(entry.callId) ? { callId: entry.callId } : {}),
      ...(typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
        ? { durationMs: Math.max(0, Math.min(600_000, Math.trunc(entry.durationMs))) } : {}),
      ...(sources?.length ? { sources } : {}) };
    seen.push(entry.id); task.eventSequence = event.sequence;
    const events = task.events ??= []; events.push(event);
    if (events.length > MAX_EVENTS) {
      // Retain the initial task marker to keep role identity/start time after a long stream.
      const initial = events[0].kind === 'task' ? events[0] : undefined;
      task.events = initial ? [initial, ...events.slice(-(MAX_EVENTS - 1))] : events.slice(-MAX_EVENTS);
      task.eventsTruncated = true;
    }
  }
}

/** Server-owned task lifecycle: provider output cannot declare a task completed. */
export function recordTaskLifecycle(task: AgentTask, previousState?: AgentTask['state']): void {
  if (!task.researchScope || task.state === previousState) return;
  const map: Partial<Record<AgentTask['state'], ResearchEventStatus>> = {
    staged: 'queued', running: 'running', completed: 'succeeded', failed: task.error === 'LOCAL_INTERRUPTED' ? 'interrupted' : 'failed', cancelled: 'cancelled',
  };
  const status = map[task.state]; if (!status) return;
  const en = task.researchScope.language === 'en';
  const text: Record<string, [string, string]> = {
    queued: ['等待助手执行任务', 'Waiting for the research agent'], running: ['助手正在研究', 'Research agent is working'],
    succeeded: ['本次研究已完成', 'Research task completed'], failed: ['研究失败，请查看连接状态后重试', 'Research failed. Check the agent connection before retrying.'],
    interrupted: ['执行已中断，未自动重试', 'Execution interrupted; no automatic retry was started'], cancelled: ['任务已取消', 'Task cancelled'],
  };
  if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)) {
    const calls = new Map<string, ResearchEvent>();
    for (const event of task.events ?? []) if (event.kind === 'tool' && event.callId) calls.set(event.callId, event);
    for (const event of calls.values()) if (event.status === 'running' || event.status === 'queued') {
      appendResearchEvents(task, [{ id: `closed:${event.id}`.slice(0, 128), kind: 'tool',
        status: status === 'cancelled' ? 'cancelled' : 'interrupted', at: new Date().toISOString(),
        summary: en ? 'Tool did not report a result before the task ended.' : '任务已结束，此工具未回报完成结果。',
        toolName: event.toolName, callId: event.callId, durationMs: Date.now() - Date.parse(event.at) }], true);
    }
  }
  appendResearchEvents(task, [{ id: `task:${task.id}:${status}`, kind: 'task', status,
    at: new Date(task.updatedAt).toISOString(),
    summary: (status === 'failed' ? localAgentLimitMessage(task.error, task.researchScope.language) : undefined) ?? text[status][en ? 1 : 0],
    ...(['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status) ? { durationMs: task.updatedAt - task.createdAt } : {}) }], true);
}
