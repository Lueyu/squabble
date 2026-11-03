import type { CouncilMessage, CouncilSession } from '@shared/council.interface';
import type { ResearchEvent, ResearchEventStatus } from '@shared/research-events.interface';

const MAX_TASK_EVENTS = 256;
export interface ResearchActivityView extends ResearchEvent { key: string; startedAt: string }
export interface ResearchTaskView {
  key: string; taskId: string; revision: number; memberId: string; memberName: string; turn: number;
  status: ResearchEventStatus; summary?: string; startedAt: string; endedAt?: string; durationMs?: number;
  activities: ResearchActivityView[]; sourceCount: number; isStale: boolean; truncated: boolean;
  replyMessageId?: string; lastSequence: number;
}

export function researchIsActive(status: ResearchEventStatus): boolean {
  return status === 'queued' || status === 'running';
}

export function researchSourceUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** The whole-session snapshot is authoritative; sequence numbers are local to each task. */
export function researchTimeline(session: CouncilSession): {
  tasks: ResearchTaskView[]; cursor: string; truncated: boolean;
} {
  const groups = new Map<string, Map<string, ResearchEvent>>();
  for (const event of session.researchEvents ?? []) {
    if (event.sessionId !== session.id) continue;
    const key = JSON.stringify([event.revision, event.taskId, event.turn]);
    const group = groups.get(key) ?? new Map<string, ResearchEvent>();
    const existing = group.get(event.id);
    if (!existing || existing.sequence < event.sequence) group.set(event.id, event);
    groups.set(key, group);
  }
  const tasks: ResearchTaskView[] = [];
  for (const [key, group] of groups) {
    const all = [...group.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    const first = all[0];
    const last = all[all.length - 1];
    const activities = new Map<string, ResearchActivityView>();
    for (const event of all.slice(-MAX_TASK_EVENTS)) {
      if (event.kind === 'task') continue;
      const activityKey = event.kind === 'tool' && event.callId ? `tool:${event.callId}` : event.id;
      const previous = activities.get(activityKey);
      const startedAt = previous && (!researchIsActive(event.status) || researchIsActive(previous.status))
        ? previous.startedAt : event.at;
      const duration = event.kind === 'tool' && !researchIsActive(event.status) && previous
        ? Date.parse(event.at) - Date.parse(startedAt) : undefined;
      activities.set(activityKey, { ...event, key: activityKey, startedAt,
        durationMs: event.durationMs ?? (Number.isFinite(duration) ? Math.max(0, duration!) : undefined) });
    }
    // API evidence batches have tool lifecycles only. Their latest call outcomes
    // establish completion; native/model tasks keep their explicit lifecycle.
    const toolOnlyStatus = all.every(event => event.kind === 'tool')
      ? (['running', 'queued', 'failed', 'cancelled', 'interrupted', 'unavailable'] as const)
        .find(status => [...activities.values()].some(activity => activity.status === status)) ?? 'succeeded'
      : undefined;
    const lifecycle = all.filter(event => event.kind === 'task');
    const terminal = [...lifecycle].reverse().find(event => !researchIsActive(event.status));
    const latestTask = lifecycle.at(-1);
    const sameTaskTurns = new Set((session.researchEvents ?? []).filter(event => event.sessionId === session.id
      && event.taskId === first.taskId && event.revision === first.revision).map(event => event.turn));
    const reply = session.messages.find(message => message.taskId === first.taskId && message.revision === first.revision
      && (message.turn === first.turn || (message.turn === undefined && sameTaskTurns.size === 1))
      && message.role !== 'user' && message.role !== 'system' && !message.acquisition && message.phase !== 'progress');
    const isStale = first.revision !== session.revision;
    let status = terminal?.status ?? latestTask?.status ?? toolOnlyStatus ?? 'running';
    if (!terminal && latestTask?.status === 'queued' && all.some(event => event.kind === 'tool' && event.sequence > latestTask.sequence)) {
      status = 'running';
    }
    if (researchIsActive(status)) {
      if (reply) status = 'succeeded';
      else if (isStale || session.status !== 'running') status = 'interrupted';
    }
    const endedAt = researchIsActive(status) ? undefined : terminal?.at ?? reply?.createdAt ?? last.at;
    // Include queued time and evidence acquisition so the card never moves past a user follow-up.
    const startedAt = first.at;
    const duration = endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : undefined;
    const visibleActivities = [...activities.values()].map(activity => {
      if (activity.kind === 'capability' && researchIsActive(activity.status)) {
        return { ...activity, status: 'unavailable' as const };
      }
      if (activity.kind === 'tool' && !researchIsActive(status) && researchIsActive(activity.status)) {
        return { ...activity, status: status === 'cancelled' ? 'cancelled' as const : 'interrupted' as const };
      }
      return activity;
    });
    const sources = new Set(visibleActivities.flatMap(activity => activity.sources?.map(source => source.url || source.title) ?? []));
    tasks.push({ key, taskId: first.taskId, revision: first.revision, memberId: first.memberId,
      memberName: first.memberName, turn: first.turn, status,
      summary: terminal?.summary ?? latestTask?.summary ?? (toolOnlyStatus ? last.summary : undefined), startedAt, endedAt,
      durationMs: terminal?.durationMs ?? (Number.isFinite(duration) ? Math.max(0, duration!) : undefined),
      activities: visibleActivities, sourceCount: sources.size, isStale,
      truncated: all.length > MAX_TASK_EVENTS, replyMessageId: reply?.id, lastSequence: last.sequence });
  }
  tasks.sort((a, b) => a.revision - b.revision || a.turn - b.turn || a.startedAt.localeCompare(b.startedAt) || a.key.localeCompare(b.key));
  return { tasks, cursor: JSON.stringify(tasks.map(task => [task.key, task.lastSequence])),
    truncated: Boolean(session.researchEventsTruncated) || tasks.some(task => task.truncated) };
}

export interface ResearchConversationEntry {
  key: string;
  at: string;
  task?: ResearchTaskView;
  message?: CouncilMessage;
  legacyActivity?: CouncilMessage;
}

/** One persistent card per observed task/turn; completion fills that card instead of adding another one. */
export function researchConversation(session: CouncilSession): {
  entries: ResearchConversationEntry[]; cursor: string; truncated: boolean;
} {
  const timeline = researchTimeline(session);
  const replies = new Set(timeline.tasks.flatMap(task => task.replyMessageId ? [task.replyMessageId] : []));
  const entries: ResearchConversationEntry[] = timeline.tasks.map(task => ({ key: task.key, at: task.startedAt, task,
    message: task.replyMessageId ? session.messages.find(message => message.id === task.replyMessageId) : undefined }));
  for (const message of session.messages) {
    if (replies.has(message.id)) continue;
    if (message.acquisition || message.phase === 'progress') {
      // Modern progress rows are storage for the event stream, not another chat message.
      if (!message.researchEventId) entries.push({ key: message.id, at: message.createdAt, legacyActivity: message });
    } else entries.push({ key: message.id, at: message.createdAt, message });
  }
  entries.sort((left, right) => left.at.localeCompare(right.at));
  return { entries, cursor: timeline.cursor, truncated: timeline.truncated };
}
