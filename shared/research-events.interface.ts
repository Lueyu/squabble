/**
 * research-events.interface.ts — 研究活动事件流的公开契约。
 *
 * 职责边界：
 *  - 定义研究过程的对外事件：单条活动（ResearchActivity）、带定位信息的完整事件
 *    （ResearchEvent）与分页信封（ResearchEventPage）。
 *  - 隐私边界：事件流只含公开活动，绝不包含私有推理块、原始输入、stderr 或凭据
 *    （见 ResearchActivity 注释）。
 * 上下游：
 *  - 上游：server/modules/local-agents/*（事件生产方）与 client/src 研究面板（消费方），
 *    共 15 个文件 import 本契约（server 11、client 2、shared 内 2）。
 *  - 下游：import type { ResearchSource }（来自 research-tools.interface.ts）。
 * 关键约定：
 *  - sequence：会话内单调递增的事件序号；revision：会话修订号；turn：讨论轮次。
 *  - at / fetchedAt：ISO 时间字符串；durationMs：毫秒。
 */

import type { ResearchSource } from './research-tools.interface';

/** 事件状态机：排队 → 运行 → 结局（成功/失败/取消/中断/不可用）。 */
export type ResearchEventStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable';

/** 单条公开活动。只放公开内容：绝不包含私有推理块、原始输入、stderr 或凭据。 */
export interface ResearchActivity {
  /** 活动 id。 */
  id: string;
  /** 活动种类：task=研究任务，tool=工具调用，summary=小结，capability=能力声明。 */
  kind: 'task' | 'tool' | 'summary' | 'capability';
  /** 当前状态（见 ResearchEventStatus）。 */
  status: ResearchEventStatus;
  /** 发生时间（ISO 字符串）。 */
  at: string;
  /** 面向用户的活动摘要（已脱敏）。 */
  summary: string;
  /** kind=tool 时的工具名。 */
  toolName?: string;
  /** kind=tool 时的调用 id（对应 ResearchToolRequest.callId）。 */
  callId?: string;
  /** 耗时（毫秒）。 */
  durationMs?: number;
  /** 活动引用到的来源列表。 */
  sources?: ResearchSource[];
}

/** 完整事件：活动本体 + 会话定位信息，由服务端事件流写入并按序下发。 */
export interface ResearchEvent extends ResearchActivity {
  /** 会话内单调递增的事件序号。 */
  sequence: number;
  /** 所属研究任务 id。 */
  taskId: string;
  /** 所属委员会会话 id。 */
  sessionId: string;
  /** 会话修订号（配置变更后递增，旧修订的事件不可复用）。 */
  revision: number;
  /** 发起活动的委员会成员 id。 */
  memberId: string;
  /** 发起活动的委员会成员名。 */
  memberName: string;
  /** 所属讨论轮次。 */
  turn: number;
}

/** 事件分页：服务端按会话聚合事件并只保留最近 2048 条，超出部分记为截断。 */
export interface ResearchEventPage {
  /** 本页事件（最多 2048 条，按写入顺序）。 */
  events: ResearchEvent[];
  /** 服务端已写入的事件总数（与本页条数之差即被截断的部分）。 */
  cursor: number;
  /** 是否发生截断（事件总数超过 2048，或某任务的事件被就地截断）。 */
  truncated: boolean;
}
