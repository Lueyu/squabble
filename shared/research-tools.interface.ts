/**
 * research-tools.interface.ts — 研究工具（任务绑定的只读工具）契约。
 *
 * 职责边界：
 *  - 定义研究阶段工具的五类形状：描述符（ResearchToolDescriptor）、调用与取消请求
 *    （ResearchToolRequest / ResearchToolCancelRequest）、结果（ResearchToolResult）、
 *    任务作用域（ResearchToolScope）、能力协商（ResearchToolCapability）与
 *    工具包（ResearchToolBundle）。
 *  - 安全边界：工具只读、按任务隔离；账号凭据绝不跨过这条边界（见各注释）。
 * 上下游：
 *  - 上游：server/modules/research-tools/* 与 server/modules/local-agents/*（宿主实现），
 *    共 17 个文件 import 本契约（server 15、client 0、shared 内 2）。
 *  - 下游：本文件不引用其他 shared 契约；ResearchSource 被 research-events.interface.ts 复用，
 *    ResearchToolBundle / ResearchToolCapability 被 local-agents.interface.ts 复用。
 * 关键约定：
 *  - annotations.readOnlyHint 恒为 true、destructiveHint 恒为 false（类型层面强制只读）。
 *  - ResearchToolScope.expiresAt：Unix 毫秒时间戳，与 Date.now() 比较，过期即拒绝执行。
 *  - ResearchToolResult.asOf：结果数据的时间基准；truncated 表示结果是否被截断。
 */

/** 研究来源：任务绑定的只读工具；账号凭据绝不跨过这条边界。 */
export interface ResearchSource {
  /** 来源标题（页面名/文献名）。 */
  title: string;
  /** 来源 URL；非网页来源可省略。 */
  url?: string;
  /** 抓取时间（ISO 字符串）。 */
  fetchedAt: string;
}

/** 工具描述符：向执行方（如本地 CLI 代理）声明工具名、用途与输入/输出 schema。 */
export interface ResearchToolDescriptor {
  /** 工具名。 */
  name: string;
  /** 工具用途说明（喂给模型的人读文本）。 */
  description: string;
  /** 输入参数的 JSON Schema。 */
  inputSchema: Record<string, unknown>;
  /** 输出结构的 JSON Schema；可省略。 */
  outputSchema?: Record<string, unknown>;
  /** 安全注记：只读、非破坏性；openWorldHint 表示工具是否访问外部世界。 */
  annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: boolean };
}

/** 调用请求：callId 用于把结果/取消关联回这一次调用。 */
export interface ResearchToolRequest {
  /** 本次调用的唯一 id。 */
  callId: string;
  /** 要执行的工具名（对应 ResearchToolDescriptor.name）。 */
  name: string;
  /** 调用参数（符合该工具的 inputSchema）。 */
  arguments: Record<string, unknown>;
}

/** 取消请求：按任务 + callId 取消一次进行中的工具调用。 */
export interface ResearchToolCancelRequest {
  /** 所属研究任务 id。 */
  taskId: string;
  /** 要取消的调用 id。 */
  callId: string;
}

/** 工具执行结果。partial 表示拿到了部分数据；unavailable 表示工具本身不可用。 */
export interface ResearchToolResult {
  /** 结局：成功 / 部分 / 不可用 / 失败 / 已取消。 */
  status: 'succeeded' | 'partial' | 'unavailable' | 'failed' | 'cancelled';
  /** 结果载荷（结构由各工具的 outputSchema 约定）。 */
  data: unknown;
  /** 结果引用到的来源列表。 */
  sources: ResearchSource[];
  /** 数据的时间基准（ISO 字符串）。 */
  asOf: string;
  /** 结果是否被截断。 */
  truncated: boolean;
  /** 失败/不可用时的机器可读错误码；成功时省略。 */
  errorCode?: string;
}

/** 任务作用域：一次研究调用的绑定上下文，服务端逐项校验，不匹配即拒绝。 */
export interface ResearchToolScope {
  /** 会话 id。 */
  sessionId: string;
  /** 会话修订号（配置变更后递增）。 */
  revision: number;
  /** 委员会成员 id。 */
  memberId: string;
  /** 委员会成员名。 */
  memberName: string;
  /** 当前讨论轮次。 */
  turn: number;
  /** 研究标的代码。 */
  ticker: string;
  /** 输出语言。 */
  language: 'en' | 'zh-CN';
  /** 是否允许联网研究。 */
  webResearch: boolean;
  /** 过期时间（Unix 毫秒），过期后作用域作废。 */
  expiresAt: number;
}

/** 安全兜底包：快照上下文 + 工具描述符。不含 bearer token 或任意服务端 URL。 */
export interface ResearchToolBundle {
  /** 可用工具的描述符列表。 */
  descriptors: ResearchToolDescriptor[];
  /** 上下文快照文本（无网时的研究素材）。 */
  snapshot: string;
}

/** 能力协商：执行方（本地运行时）是否支持 MCP 工具及原因。 */
export interface ResearchToolCapability {
  /** 工具接入方式：mcp = 走 MCP 协议；snapshot = 退化为只读快照。 */
  mode: 'mcp' | 'snapshot';
  /** 判定原因：支持 / 版本不支持 / 运行时不支持。 */
  reason: 'supported' | 'version_unsupported' | 'runtime_unsupported';
}
