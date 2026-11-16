/**
 * @file utils/research-events.ts
 * @description 把 Council 会话的原始研究事件流折叠成"任务视图"时间线。
 *
 * 职责边界：
 *  - 只做事件 → 展示视图的纯转换；不订阅、不发请求
 * 上下游：
 *  - 上游（谁调用这里）：researchTimeline → Council/CouncilConversation、
 *    Council/CouncilResearchTimeline；researchIsActive / researchSourceUrl →
 *    CouncilResearchTimeline
 *  - 下游（本文件调用谁）：@shared/council.interface、@shared/research-events.interface 的类型
 * 关键约定：
 *  - 每个任务最多保留 MAX_TASK_EVENTS（256）条活动，超出时视图打 truncated 标记
 *  - sequence 只在单个任务内单调；跨任务的先后以任务排序字段为准
 */
import type { CouncilSession } from '@shared/council.interface';
import type { ResearchEvent, ResearchEventStatus } from '@shared/research-events.interface';

/** 单个任务视图最多保留的活动条数（超出部分丢弃并标记 truncated）。 */
const MAX_TASK_EVENTS = 256;

/** 单条活动视图：在事件基础上补展示用的 key 与归一化的 startedAt。 */
export interface ResearchActivityView extends ResearchEvent {
  key: string;
  startedAt: string;
}

/** 一个研究任务的折叠视图（活动列表 + 生命周期状态 + 来源统计）。 */
export interface ResearchTaskView {
  key: string;
  taskId: string;
  revision: number;
  memberId: string;
  memberName: string;
  turn: number;
  status: ResearchEventStatus;
  summary?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  activities: ResearchActivityView[];
  sourceCount: number;
  isStale: boolean;
  truncated: boolean;
  replyMessageId?: string;
  lastSequence: number;
}

/**
 * 判断研究状态是否仍处于活跃（排队中或执行中）。
 */
export function researchIsActive(status: ResearchEventStatus): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * 把来源字符串解析成安全的 http(s) 链接。
 * @returns 合法 http/https URL 的 href；空值、解析失败或其他协议返回 null。
 */
export function researchSourceUrl(value?: string): string | null {
  // 空值直接 null。
  if (!value) return null;
  try {
    // 只放行 http/https 协议。
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * 折叠整个会话的研究事件为任务时间线。
 * 全会话快照是权威数据；sequence 只在单个任务内有意义。
 * @returns 任务视图列表（已排序）、游标（key+lastSequence 的 JSON，
 *          供调用方做增量比较）与整体 truncated 标记。
 */
export function researchTimeline(session: CouncilSession): {
  tasks: ResearchTaskView[];
  cursor: string;
  truncated: boolean;
} {
  // 步骤 1：按 (revision, taskId) 分组；组内按事件 id 去重，只保留 sequence 最大的一条。
  const groups = new Map<string, Map<string, ResearchEvent>>();
  for (const event of session.researchEvents ?? []) {
    // 过滤掉不属于本会话的事件。
    if (event.sessionId !== session.id) continue;
    const key = JSON.stringify([event.revision, event.taskId]);
    const group = groups.get(key) ?? new Map<string, ResearchEvent>();
    const existing = group.get(event.id);
    if (!existing || existing.sequence < event.sequence) group.set(event.id, event);
    groups.set(key, group);
  }

  // 步骤 2：逐组构建任务视图。
  const tasks: ResearchTaskView[] = [];
  for (const [key, group] of groups) {
    // 2.1 组内事件按 sequence 排序（同 sequence 按 id 稳定排序）。
    const all = [...group.values()].sort(
      (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
    );
    const first = all[0];
    const last = all[all.length - 1];

    // 2.2 折叠活动：非 task 事件聚合为活动视图；tool 事件按 callId 归并，
    // startedAt 保留最早出现时间，tool 完成时计算耗时。
    const activities = new Map<string, ResearchActivityView>();
    for (const event of all.slice(-MAX_TASK_EVENTS)) {
      // task 事件本身不是活动，跳过。
      if (event.kind === 'task') continue;
      // tool 事件用 callId 作聚合键（一次调用可能产生多条事件）。
      const activityKey = event.kind === 'tool' && event.callId ? `tool:${event.callId}` : event.id;
      const previous = activities.get(activityKey);
      // startedAt 取"最早的非活跃起点"：新事件已结束且旧事件也非活跃时沿用旧起点。
      const startedAt =
        previous && (!researchIsActive(event.status) || researchIsActive(previous.status))
          ? previous.startedAt
          : event.at;
      // tool 调用结束时计算时长（毫秒）。
      const duration =
        event.kind === 'tool' && !researchIsActive(event.status) && previous
          ? Date.parse(event.at) - Date.parse(startedAt)
          : undefined;
      activities.set(activityKey, {
        ...event,
        key: activityKey,
        startedAt,
        durationMs:
          event.durationMs ?? (Number.isFinite(duration) ? Math.max(0, duration!) : undefined),
      });
    }

    // API 证据批次只有 tool 生命周期。其最新一次调用的结果决定完成状态；
    // 原生/模型任务保留它们显式的 task 生命周期。
    const toolOnlyStatus = all.every((event) => event.kind === 'tool')
      ? ((['running', 'queued', 'failed', 'cancelled', 'interrupted', 'unavailable'] as const).find(
          (status) => [...activities.values()].some((activity) => activity.status === status),
        ) ?? 'succeeded')
      : undefined;

    // 2.3 收集生命周期线索：task 事件、最近一个终态、最后一条 task、
    // 以及会话消息里对应的（非用户/非系统、非进度、非采集）回复。
    const lifecycle = all.filter((event) => event.kind === 'task');
    const terminal = [...lifecycle].reverse().find((event) => !researchIsActive(event.status));
    const latestTask = lifecycle.at(-1);
    const reply = session.messages.find(
      (message) =>
        message.taskId === first.taskId &&
        message.revision === first.revision &&
        message.role !== 'user' &&
        message.role !== 'system' &&
        !message.acquisition &&
        message.phase !== 'progress',
    );
    // revision 落后于当前会话版本的任务视为过期。
    const isStale = first.revision !== session.revision;

    // 2.4 推导任务状态：优先显式终态 → 最后一条 task → 纯 tool 推导 → running。
    let status = terminal?.status ?? latestTask?.status ?? toolOnlyStatus ?? 'running';
    // task 还在排队但之后已有 tool 活动：实际已开跑，纠正为 running。
    if (
      !terminal &&
      latestTask?.status === 'queued' &&
      all.some((event) => event.kind === 'tool' && event.sequence > latestTask.sequence)
    ) {
      status = 'running';
    }
    // 仍活跃的任务用旁证收尾：有回复即成功；过期或会话已停即被中断。
    if (researchIsActive(status)) {
      if (reply) status = 'succeeded';
      else if (isStale || session.status !== 'running') status = 'interrupted';
    }

    // 2.5 计算起止时间与总耗时（未结束的任务没有 endedAt）。
    const endedAt = researchIsActive(status)
      ? undefined
      : (terminal?.at ?? reply?.createdAt ?? last.at);
    const startedAt = lifecycle.find((event) => event.status === 'running')?.at ?? first.at;
    const duration = endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : undefined;

    // 2.6 活动状态收尾：能力类活动随任务中断标记 unavailable；
    // 已结束任务里仍活跃的 tool 活动随任务终态标记 cancelled/interrupted。
    const visibleActivities = [...activities.values()].map((activity) => {
      if (activity.kind === 'capability' && researchIsActive(activity.status)) {
        return { ...activity, status: 'unavailable' as const };
      }
      if (
        activity.kind === 'tool' &&
        !researchIsActive(status) &&
        researchIsActive(activity.status)
      ) {
        return {
          ...activity,
          status: status === 'cancelled' ? ('cancelled' as const) : ('interrupted' as const),
        };
      }
      return activity;
    });

    // 2.7 统计去重后的来源数量。
    const sources = new Set(
      visibleActivities.flatMap(
        (activity) => activity.sources?.map((source) => source.url || source.title) ?? [],
      ),
    );

    // 2.8 产出该任务的视图对象。
    tasks.push({
      key,
      taskId: first.taskId,
      revision: first.revision,
      memberId: first.memberId,
      memberName: first.memberName,
      turn: first.turn,
      status,
      summary:
        terminal?.summary ?? latestTask?.summary ?? (toolOnlyStatus ? last.summary : undefined),
      startedAt,
      endedAt,
      durationMs:
        terminal?.durationMs ?? (Number.isFinite(duration) ? Math.max(0, duration!) : undefined),
      activities: visibleActivities,
      sourceCount: sources.size,
      isStale,
      truncated: all.length > MAX_TASK_EVENTS,
      replyMessageId: reply?.id,
      lastSequence: last.sequence,
    });
  }

  // 步骤 3：任务排序 —— revision → turn → 开始时间 → key，保证时间线稳定。
  tasks.sort(
    (a, b) =>
      a.revision - b.revision ||
      a.turn - b.turn ||
      a.startedAt.localeCompare(b.startedAt) ||
      a.key.localeCompare(b.key),
  );

  // 步骤 4：组装游标与整体 truncated 标记。
  return {
    tasks,
    cursor: JSON.stringify(tasks.map((task) => [task.key, task.lastSequence])),
    truncated: Boolean(session.researchEventsTruncated) || tasks.some((task) => task.truncated),
  };
}
