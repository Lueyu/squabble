# 团队模拟盘技术设计

日期：2026-11-12。状态：Figma 原型、详细设计和默认参数已批准；用户已授权实现、验证及通过 PR 合入主干。本文保留目标契约；实际源码入口见 [使用说明](../../team-workspace.md)，测试证据和限制见 [验证记录](../../team-workspace-validation.md)。

基线：`b9f1febea567438afd315d6dcf8000d02a64c53e`，启动迁移登记目前到 `60_local_compute.sql`。实现时必须重新检查基线，不能预占 61 号迁移。原型：[V6](https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=248-998)。产品交互以同目录产品规格和已批准原型为准；本稿替代早期“任意配置变更均暂停全盘”的工程假设。

本文 V1/V1.1/V2 仅表示本特性的首期和后续建议范围，不是应用版本号或已承诺的发布时间。

## 1. 实现边界与现有能力

V1.0 增加 `/teams` 和 `/teams/:id`，导航放在“我的股友”后，保留现有 `/paper`。首页保留原区块，通过账户卡片和曲线进入 `/holdings?accountId=real|<paperAccountId>`。一个团队首版最多绑定一个模拟账户，一个账户同时只有一个主责团队；复用方式是复制组织配置，不做一队多账户调度。可先发布未关联账户的组织版本，但不能发起账户研究；绑定后重新检查运行能力。

研究由用户手动预览、确认和发起。资料更新、论点到期先产生“待复核”提示；自动资料触发、定时派发及独立自动研究授权是 V1.1。标准 A2A、跨账户控制实验为 V2。原生助手可担任负责人，不在设计上排除；只有现有适配器能满足本次任务的结构化交付、复核和作用域约束时才可运行。岗位执行方式不预先锁定为某一种模型或助手。

| 现有模块 / 源文件 | 复用能力 | 必须新增的最小适配 |
|---|---|---|
| `server/modules/paper-trading/portfolio-workspace.service.ts` | 账户、策略草稿/预览/应用、确认策略快照、策略并发版本 | 团队决策引用进入预览 hash；事务内验证精确来源；可复用的暂停事务 helper |
| `portfolio-workspace.controller.ts` | `/api/ai-investment/accounts` 账户读写 | 保留原路由；团队 API 不另建账户和账本 |
| `portfolio-comparison.service.ts` | 持久 NAV、比较、当前估值与历史缺失说明 | 团队展示归因；不能补造旧史或将模拟资产汇入实仓 |
| `user-strategy-runtime.ts` | 只执行已确认的账户策略，研究不得直接改变交易意图 | 冻结团队决策/执行上下文；更换团队不重写已确认策略归属 |
| `server/modules/council/council.service.ts` | 会话、冻结成员、预算、执行、取消和恢复 | 创建前注入可信团队 scope；团队专用事务准备与幂等启动入口 |
| `council.tasks.ts`、`council.workflow.ts` | 任务/尝试/交付/复核循环 | 显式工作计划，稳定 workKey，按任务指定复核人；不另写研究引擎 |
| `council.workflow-store.ts` | 任务 claim、版本 fence、接受交付、重启未知状态 | 将团队命令/上下文加入原状态保护；付费返工上限按预览授权，默认 0 |
| `council.workflow-executor.ts`、`local-agents` | model/local 实际执行、远端句柄、结构化结果、费用未知 | 冻结执行器及权限；能力检查；不把本地执行伪装成标准 A2A |
| `research-memory`、`research-documents`、`research-tools` | 论点版本、来源版本、撤销/删除检查、工具作用域 | team audience 在检索、写入、缓存、嵌入和传出全链生效 |
| `research-core`、预算存储 | 预算、用量、恢复、历史 | 沿用 root budget，不另建金额钱包；未知成本不能置 0 |

已核实的约束：`agent-builder.rules.ts` 当前单次 Council 限 1–6 成员且恰好一个 manager；`planResearchTasks` 当前要求 researcher 和 manager 并生成固定任务。拟允许组织画布最多 30 个岗位，单次委托选择最多 6 个实际执行岗位、并行度为 1 或 2；超过时预览明确报错，不能默默裁剪。单人可形成研究闭环，但其复核标为“自检”，不能宣称独立复核。未配置执行器的空缺岗位可保存在组织版本，只有被选入本次执行时才阻止运行。

`PortfolioResearchRouteService.resolve(owner)` 使用 owner 全局偏好并可 native-first 回退 API，不能直接用作团队岗位选择器。团队成员必须显式绑定 executor；离线或不支持时要求用户修改草稿或本次计划，禁止静默切换执行器、模型或提供方。

### 1.1 拟新增文件

- `shared/team-workspace.interface.ts`：下述 DTO、枚举、快照与错误码，无 Nest/数据库依赖。
- `server/database/teams.schema.ts`：新表及约束导出；在现有 schema 汇总和 migration registry 登记。
- `server/database/team-context.ts`：可供 council/paper-trading 调用的纯数据库 scope/fence helper；不得反向 import TeamsModule。
- `server/modules/teams/teams.module.ts`、`teams.controller.ts`、`teams.service.ts`：API、生命周期、账户绑定和读模型。
- `team-version.service.ts`：语义校验、草稿 CAS、发布预览、版本提交；`team-commission.service.ts`：分工编译、委托/命令 outbox。
- `team-runtime-adapter.ts`：对接现有 CouncilService、任务计划和状态投影；`team-decision.service.ts`：精确引用与决策事件；`team-source-access.service.ts`：来源授权和权限 revision。
- `team-contract.ts` / `team-graph.ts`：金额/时间/规范化 hash/关系图和计划的纯函数，避免 controller 中重复规则。
- `team-config.ts`：读取两个发布开关并严格解析；`.env.example` 记录示例，不修改用户实例环境。
- 前端 `client/src/pages/Teams/TeamsPage.tsx`、`TeamWorkspacePage.tsx` 组合页面；`client/src/features/teams/` 包含业务图、React Flow adapter、画布、列表、属性、预览与 `use-team-draft.ts`；`client/src/api/teams.ts` 统一请求，具体文件分工见实施方案。

TeamsModule 依赖现有 CouncilModule、ResearchMemoryModule、PaperTradingModule 和公共数据库设施；既有模块通过共享上下文 helper 与新增可选 DTO 字段识别 team 执行，不反向依赖 TeamsModule。`PortfolioWorkspaceService` 如未导出需最小增加导出/事务 helper，不复制其策略应用逻辑。

## 2. 版本与数据约定

| 字段 | 增长条件 | 不影响的对象 |
|---|---|---|
| `displayRevision` | 名称、头像、显示标签等保存 | 不变更运行版本/预算/策略 |
| `layoutRevision` | 坐标、折叠、缩放、面板位置保存 | 不改变部门归属、职责、连线语义 |
| `semanticRevision` | 草稿的部门、岗位、执行器、职责、权限或关系改变 | 不自动发布、不改变已运行快照 |
| `version` | 确认发布语义草稿，生成不可变 TeamVersion | 不自动启动研究或确认交易 |
| `bindingRevision` | 绑定、换队、解除、账户归档等责任区间变化 | 不篡改旧研究/策略归属 |
| `scopeRevision` | 团队来源授权增删、权限收紧/撤销 | 用作执行前安全 fence，不能靠旧快照继续取新数据 |
| `commissionRevision` | 本次委托的状态/取消/恢复提交 | 不改写其最初组织与成员快照 |

所有实体 ID 为 UUID，ownerId 使用仓库现有 owner 类型。API 时间统一 ISO 8601 UTC（如 `2026-11-12T03:20:00.000Z`），数据库使用带时区时间。金额、成本、数量、比例均为十进制字符串；未知为 `null`，不以 0 或空字符串代替。只在展示边界格式化；累计/风控沿用数据库 numeric/项目 Decimal。金额字段另带 currency；禁止未转换就跨币种合计。整数 revision/count 不使用字符串。

语义图与画布图分离：部门的 `parentDepartmentId`、岗位 `departmentId`、汇报/协作关系属于业务配置；位置等属于 layout。拟引入 `@xyflow/react@12.12.1`（MIT，React peer >=17，与当前 React 19.2 匹配；本轮未安装），通过 adapter 将业务 departmentId 映射为 parentId。UI 库 node/edge 实例不能直接作为持久协议。

## 3. 数据表与约束

以下为拟建模设计，不是已提交 migration。新表统一 `created_at/updated_at`，不可变事件只需 created_at。全部查询先 owner fence，再 team/account fence；跨 owner 返回 404。新表建立 `(owner_id,id)` 唯一键，复合外键只指向同 owner 新表；既有表缺少对应约束时由事务内 owner 校验，不未经审计就重建历史大表约束。

### 3.1 组织、版本、绑定

| 表 | 关键字段 | 索引/不变量 |
|---|---|---|
| `teams` | id, owner_id, name, description, avatar, status=`active\|archived`, display_json, display_revision, layout_json, layout_revision, binding_revision, scope_revision, account_id nullable, current_version_id nullable | `(owner_id,status,updated_at)`；account_id 是当前有效绑定的查询缓存，变更须经交接预览并与 binding 同事务维护；current_version 属于本团队 |
| `team_drafts` | team_id PK, owner_id, semantic_revision, base_version_id nullable, config_json | 一团队一个可修改草稿；CAS semantic_revision；config_json 保留稳定岗位/部门/关系 ID |
| `team_versions` | id, team_id, owner_id, version, semantic_revision, semantic_hash, config_json, display_snapshot, created_by | UNIQUE(team_id,version)；插入后不可改/删；hash 相同可返回已发布版本但必须遵守幂等回执 |
| `team_account_bindings` | id, owner_id, team_id, account_id, binding_revision, team_version_id, state=`active\|superseded\|released\|archived`, previous_binding_id nullable, effective_from, effective_to nullable, execution_choice, policy_snapshot nullable | UNIQUE(team_id) WHERE state='active'；UNIQUE(account_id) WHERE state='active'；历史保留；有效区间不能反向；团队/账户属于同 owner |

发布版本可以未绑定账户；绑定引用明确版本并在绑定预览重新检查能力。发布新版本后，后续委托默认使用新版本，但已创建委托继续旧快照；无需为了研究职责变动创建假换队记录。绑定保存责任主体/启用时版本，委托另外存精确使用版本。一个团队可以经明确交接更换当前账户，但不能同时绑定多个账户；旧委托、判断、来源授权和策略引用仍保留原 accountId，不随当前绑定改写或自动转移使用权。

`execution_choice='keep_confirmed_rules'|'pause_all'` 只描述绑定变更对既有已确认交易规则的处理。保留时冻结其具体 policy/assignment revisions 并记录 continuation 事件；这些规则仍归原批准团队与版本，不能改成新队成绩。暂停时调用现有账户 pause 事务逻辑并明确包含保护单；恢复是后续独立确认。

### 3.2 预览与写入回执

| 表 | 字段 | 约束/用途 |
|---|---|---|
| `team_previews` | id, owner_id, team_id, kind=`publish\|binding\|commission\|archive`, payload_json, guards_json, preview_hash, compiler_version, expires_at, consumed_by_request_key nullable | owner/team/kind/expiry 索引；预览有效期 15 分钟；同 preview 只能成功消费一次；consumed 回执可重放 |
| `team_requests` | id, owner_id, request_key, operation, team_id nullable, input_hash, result_json, http_status, completed_at | UNIQUE(owner_id,request_key)；同 key 同请求返回原结果，同 key 不同输入 409；只存已提交的业务结果，不把数据库回滚误记为成功 |

每个写接口显式接收 requestKey；HTTP header 可镜像但 body/header 不一致直接 400。requestKey 上限 128，禁止把凭证、个人资料塞进 key。预览也是可幂等写入。输入 hash 含 operation、已校验的路由资源身份（teamId、commissionId、grantId 等适用字段）和规范化 body，不含 requestKey；跨资源使用同 key 即使 body 相同也须冲突，不能重放另一个团队回执。所有安全前置条件纳入 preview guards。服务端生成 hash，客户端不能自报有效性。

### 3.3 委托、桥接命令和历史引用

| 表 | 字段 | 索引/约束 |
|---|---|---|
| `team_commissions` | id, owner_id, team_id, account_id, binding_id, binding_revision, team_version_id, scope_revision, commission_revision, preview_id, plan_json, input_snapshot, member_snapshots, root_budget_task_id, session_id nullable, cycle_id nullable, state, budget_limit_json, budget_limit_revision, last_error_json nullable, requested_by, cancel_requested_at nullable, completed_at nullable | UNIQUE(preview_id)；UNIQUE(session_id) WHERE 非空；team/state/created 索引；初始快照不可编辑；预算收紧另存当前限制和 revision |
| `team_commission_jobs` | id, owner_id, commission_id, kind=`prepare\|start\|project\|cancel\|recover`, command_key, payload_json, state=`pending\|claimed\|done\|blocked\|uncertain`, attempts, lease_owner nullable, lease_until nullable, next_attempt_at, last_error_json | UNIQUE(commission_id,command_key)；pending/next_attempt 索引；不得把模型 retry 放进此表 |
| `team_research_links` | id, owner_id, team_id, commission_id, kind, target_id, target_revision nullable, relation, work_key nullable, attempt_id nullable, metadata_json | UNIQUE(commission_id,kind,target_id,target_revision,relation) 使用 NULLS NOT DISTINCT 或等价表达式；精确指向原记录，不复制正文 |
| `team_decisions` | id, owner_id, team_id, account_id, commission_id nullable, proposal_id, proposal_revision, event, actor_type, actor_id, basis_json, reason, policy_context_json nullable, request_key | UNIQUE(proposal_id,proposal_revision)；append-only；actor_type=`user\|agent\|system`；event 见第 10 节 |
| `team_source_grants` | id, owner_id, team_id, source_kind, source_id, source_revision, state=`active\|revoked`, granted_by, granted_at, revoked_at nullable, reason nullable | 同 team/source 精确版本仅一个 active；撤销同时增加 scope_revision；保留撤销历史 |

links.kind 为 `task|attempt|report_version|thesis_version|strategy_revision|signal|order|trade`；relation 为 `produced|reviewed|used|derived|executed`。跨模块 ID 用原模块真实标识类型，不能对其无条件强制 UUID；新模块自己的 ID 才统一 UUID。指向可删除原记录时保留最小审计标识与可用性状态，不能缓存正文绕过删除。

job 只是数据库事务与现有 Council 执行之间的持久桥梁，不能产生第二套研究任务/attempt/delivery 表。投影任务可重试，因为读取和写入 links 幂等；start 的未知结果不得按普通重试处理。

### 3.4 对现有研究记录的最小扩展

1. `council_sessions` 增加 nullable `team_commission_id`（唯一）及 `team_context` JSON；profileSnapshot 冻结本次成员、计划与 team scope。旧会话为 null，不能推断归属。
2. `council_research_tasks` 增加 nullable `work_key`、`dependency_work_keys`、`task_kind`、`reviewer_member_id`、`assignment_json`。旧任务继续用 key；团队任务以 workKey 为身份，taskKind 是分类而非唯一标识。现有 kinds 之外允许 `specialist`；summary 每次只有一个。
3. 现有 `(session_id,cycle_id,key)` 唯一索引 `council_research_tasks_cycle_key_idx` 改为 `WHERE work_key IS NULL`，**保留原索引名**，防止启动重放旧迁移的 IF NOT EXISTS 恢复全量约束；另建 `(session_id,cycle_id,work_key) WHERE work_key IS NOT NULL` 唯一索引。
4. task identity helper 在 store/workflow/executor/UI 同步识别 workKey；不能只改建表而让重试仍按旧 kind 寻址。attempts、delivery、acceptedAttemptId 保持原结构语义。
5. report/thesis 的原版本快照和策略 policy JSON 可追加 nullable `teamExecutionContext`，新写入带精确引用；不存在时显示“历史记录，未关联团队”，不回填虚构来源。

## 4. TypeScript / JSON 契约

以下代码是文档契约，不是新增应用源码。所有外部 JSON 均经运行时 schema 校验，未知键拒绝；内容大小、枚举、UUID、字符串金额、UTC 时间与递归深度单独校验。

```ts
type UUID = string;
type IsoUtc = string;
type DecimalString = string;
type Money = { amount: DecimalString | null; currency: string };
type TeamExecutor =
  | { executionMode: 'model'; connectionId: string; model: string;
      tier?: string; settings: Record<string, unknown> }
  | { executionMode: 'local'; localAgentId: string;
      settings: Record<string, unknown> };
interface TeamDepartment { id: UUID; parentDepartmentId: UUID | null; purpose: string }
interface TeamRole {
  id: UUID; departmentId: UUID | null;
  participation: 'placeholder' | 'enabled'; // 新岗位默认 placeholder
  responsibility: string; // <=1000 chars，与现有成员 instructions 上限对齐
  expectedOutput: string; executor: TeamExecutor | null;
  allowedToolIds: string[]; sourceGrantIds: UUID[];
}
interface TeamRelation {
  id: UUID; fromRoleId: UUID; toRoleId: UUID;
  kind: 'reports_to' | 'delegates_to' | 'reviews';
  responsibilityScope: string;
}
interface TeamSemanticConfig {
  schemaVersion: 1;
  departments: TeamDepartment[]; roles: TeamRole[]; relations: TeamRelation[];
  defaults: { leadRoleId: UUID | null; parallelism: 1 | 2 };
}
interface TeamDisplay {
  name: string; avatar: string | null;
  departmentLabels: Record<UUID, string>; roleLabels: Record<UUID, string>;
}
interface TeamLayout {
  schemaVersion: 1;
  positions: Record<UUID, { x: number; y: number; width?: number; height?: number }>;
  collapsedDepartmentIds: UUID[]; viewport: { x: number; y: number; zoom: number };
}
interface TeamGuardSet {
  semanticRevision: number; currentVersionId: UUID | null;
  bindingRevision: number; bindingId: UUID | null;
  scopeRevision: number; accountPolicyRevision: number | null;
  accountAssignmentRevision: number | null; capabilityFingerprint: string | null;
  sourceFingerprints: { sourceId: string; revision: string; fingerprint: string }[];
  executorFingerprints: { roleId: UUID; fingerprint: string }[];
}
interface TeamPreview<T> {
  previewId: UUID; previewHash: string; expiresAt: IsoUtc;
  compilerVersion: string; guards: TeamGuardSet;
  result: T; warnings: { code: string; message: string; roleId?: UUID }[];
}
interface ConfirmPreview {
  requestKey: string; previewId: UUID; previewHash: string;
}
interface MemberSnapshot {
  roleId: UUID; memberId: string; teamVersionId: UUID;
  label: string; responsibility: string; expectedOutput: string;
  executor: TeamExecutor; executorConfigRevision: string;
  credentialRef: string; // 仅服务端存引用；不含 token，API 返回时脱敏
  capabilityFingerprint: string; allowedToolIds: string[];
  sourceGrantIds: UUID[]; scopeRevision: number;
}
interface ResearchSourceRef {
  kind: 'report_version' | 'thesis_version' | 'document_version' | 'data_snapshot';
  id: string; revision: string; availability: 'available' | 'revoked' | 'deleted' | 'missing';
}
interface TeamWorkItem {
  workKey: string; roleId: UUID; taskKind: 'financials' | 'business' | 'valuation'
    | 'challenge' | 'summary' | 'specialist';
  objective: string; expectedOutput: string; dependencyWorkKeys: string[];
  reviewerRoleId: UUID; reviewMode: 'independent' | 'self_check';
  inputRefs: ResearchSourceRef[]; requestedByRoleIds: UUID[];
}
interface TeamCommissionPlan {
  schemaVersion: 1; leadRoleId: UUID; participantRoleIds: UUID[];
  objective: string; expectedOutput: string;
  dataCutoffAt: IsoUtc; deadlineAt: IsoUtc;
  supervisorRoleIds: UUID[]; work: TeamWorkItem[]; parallelism: 1 | 2;
  conflictResolutions: { instructionIds: string[]; choice: string; reason: string }[];
  budget: { budgetMode: 'cost_and_calls' | 'calls_only'; ceiling: Money;
    callLimit: number; paidRevisionLimit: number };
}
interface TeamResearchContext {
  audience: 'team'; ownerId: string; teamId: UUID; teamVersionId: UUID;
  commissionId: UUID; accountId: string; bindingId: UUID;
  bindingRevision: number; scopeRevision: number;
  rootBudgetTaskId: string; allowedSourceRefs: ResearchSourceRef[];
}
interface CommissionPreviewInput {
  requestKey: string; teamVersionId: UUID; bindingId: UUID;
  expectedBindingRevision: number; objective: string; expectedOutput: string;
  dataCutoffAt: IsoUtc | null; // null 由本次预览生成时间固定，不在确认时重新取 now
  deadlineAt: IsoUtc;
  leadRoleId: UUID; participantRoleIds: UUID[]; supervisorRoleIds: UUID[];
  work: TeamWorkItem[]; inputRefs: ResearchSourceRef[];
  conflictResolutions: TeamCommissionPlan['conflictResolutions'];
  parallelism: 1 | 2; budget: TeamCommissionPlan['budget'];
}
type TeamCommissionState = 'queued' | 'running' | 'awaiting_review' | 'completed'
  | 'partial' | 'blocked' | 'failed' | 'cancelling' | 'cancelled' | 'uncertain';
interface TeamCostSummary {
  confirmed: Money; reserved: Money; estimatedMaximum: Money;
  externalUsageUnknown: boolean; unknownAttemptIds: string[];
}
interface TeamDecisionBasis {
  teamVersionId: UUID; bindingId: UUID; bindingRevision: number;
  commissionId: UUID; sessionId: string; cycleId: string;
  workKey: string; acceptedAttemptId: string;
  reportVersionId: string | null;
  thesisVersions: { thesisId: string; versionId: string }[];
  sourceRefs: ResearchSourceRef[];
}
interface TeamDecisionRef { proposalId: UUID; proposalRevision: number; decisionId: UUID }
```

显示标签与运行成员快照独立：改名后新预览使用新标签；旧委托仍展示其保存时标签，可另显示“当前名”。memberId 从 roleId 作确定性无连字符映射（32 字符），不按名字生成；两个岗位共用一个 executor 仍是两个职责快照，展示共用连接，禁止称为两个独立模型。一次委托同一岗位/同一工作只派发一次，交付供多个上级引用。

部门可多根、可嵌套且部门树无环；以平铺 ID/parentId 数组存储，不能把 JSON 递归校验层数当成部门层级上限。岗位允许多上级、跨部门汇报；每条汇报线必须填写责任范围。发布校验自汇报、同语义重复线和责任汇报环；协作关系可有环，但只表示关系，不能自动转成无限任务。placeholder 岗位允许 executor=null；enabled 岗位发布时须具备完整职责和执行配置，本次研究只能选择 enabled 且实时能力满足要求的岗位。真正执行的是独立编译的有限 work DAG。一次研究 leadRoleId 必须唯一，所有成员/复核人存在于该版本且被本次选中；多主管指令冲突须由负责人在预览中记录取舍，不自动累加权限、预算或派发次数。dataCutoffAt 不得晚于预览生成时刻，deadlineAt 必须晚于当前时刻；callLimit 为正整数，paidRevisionLimit 为非负整数且默认 0，确认与每次派发都不得超出实时有效预算。

预算字段运行时校验：`cost_and_calls` 的 ceiling.amount 必须为有限非负十进制金额；`calls_only` 仅在当前账户已有授权允许、用户在预览明确选择并知晓外部费用未知时可令 ceiling.amount=null。null 不代表免费或无限调用；两种模式都必须有正整数 callLimit，修订调用同样消耗额度。无法观测或控制原生提供方实际计费时，不能宣称费用硬上限可保证；没有合适授权模式则阻断启动。

## 5. HTTP API

统一前缀 `/api/teams`，沿用仓库 owner 身份来源与 JSON 错误包装，不信任 body 的 ownerId。分页使用 cursor/limit（默认 30、上限 100）。读响应注明当前 revision；写响应返回实体、相关新 revision 和 requestKey。状态 201 表示创建，200 表示修改/幂等重放，202 表示已持久接收异步命令。

列表先按 owner、q、状态与产品筛选过滤，再按 updatedAt DESC、id DESC 稳定排序和分页；不在当前页里搜索而漏掉其他页团队。游标只表达位置，不授予读取权限，非法游标返回 400。所有修改响应的身份以服务端记录为准。

| 方法 / 相对路径 | 输入 | 输出 / 主要行为 |
|---|---|---|
| GET `/` | cursor,limit,status,q,filter=all/published/draft/unbound | items、nextCursor、capabilities(workspaceEnabled,researchEnabled)；卡片含版本、绑定、运行/费用及已有 NAV 口径 |
| POST `/` | requestKey,name,description?,avatar?,copyFromTeamVersionId? | team + 初始草稿；复制配置生成新 ID 映射，不复制账户、授权、历史和运行 |
| GET `/:id` | 无 | display/layout/draft/当前版本/绑定/能力概要；无凭证 |
| PATCH `/:id/display` | requestKey,expectedDisplayRevision,display | displayRevision；标签引用必须属于已知节点 |
| PUT `/:id/layout` | requestKey,expectedLayoutRevision,layout | layoutRevision；不发布语义变更 |
| PUT `/:id/draft` | requestKey,expectedSemanticRevision,config | semanticRevision；只保存草稿 |
| GET `/:id/versions` | cursor | 不可变版本列表 |
| GET `/:id/versions/:vid` | 无 | 精确版本、hash、显示快照 |
| POST `/:id/connection-check` | requestKey,semanticRevision,roleIds | 每岗位 supported/unsupported/unknown/offline、能力及证据时效；仅低成本元数据检查，不发模型任务 |
| POST `/:id/publish-preview` | requestKey,expectedSemanticRevision | TeamPreview：语义差异、警告、后续影响；无账户可发布；不可运行岗位可作为警告保存 |
| POST `/:id/publish` | ConfirmPreview | TeamVersion；只发布，不派发/交易 |
| POST `/:id/binding-preview` | BindingPreviewInput | 新旧责任区间、pending 重核清单、继续/暂停策略与保护单的具体清单 |
| POST `/:id/binding` | ConfirmPreview | 绑定/解除结果及新旧团队 bindingRevision；原子提交交易处理选择 |
| POST `/:id/archive-preview` | requestKey,expectedBindingRevision,expectedCurrentVersionId,executionChoice? | 停止新研究、在途处理、绑定解除、历史保留和策略继续/暂停明细 |
| POST `/:id/archive` | ConfirmPreview | status=archived；事务内解除绑定、停止未派发 work、按确认选择处理规则，不删账户 |
| POST `/:id/commission-preview` | CommissionPreviewInput | 完整分工、唯一负责人、输入/输出、费用已知/未知、授权返工次数、能力/fence |
| POST `/:id/commissions` | ConfirmPreview | 202 commissionId,state,rootBudgetTaskId；生成 prepare outbox，不在 HTTP 事务调用 AI |
| GET `/:id/commissions` | cursor,state | 委托摘要、实际成本/未知、最后动作 |
| GET `/:id/commissions/:cid` | 无 | 快照、现有 task/attempt/delivery 引用、进度、成本、决策；嵌入团队页，无需新研究详情页 |
| POST `/:id/commissions/:cid/cancel` | requestKey,expectedCommissionRevision,reason | 202；取消意图持久化后入 cancel outbox |
| POST `/:id/commissions/:cid/recover` | RecoveryInput | 202；明确动作，复用或重试区分，不能默认付费重发 |
| PATCH `/:id/commissions/:cid/budget-limit` | requestKey,expectedCommissionRevision,ceiling?:Money,callLimit?:number（至少提供一项） | 仅收紧未派发调用的费用或调用次数上限，返回边界及未结算/未知费用；不得切换模式或放宽，V1 不提供快捷放宽 |
| GET `/:id/decisions` | cursor,accountId?,proposalId? | append-only 决策事件与确切来源 |
| POST `/:id/decisions` | DecisionInput | 保存 propose/observe/defer/reject/adopt 等事件；adopt 本身不应用策略 |
| GET `/:id/source-grants` | cursor | 来源精确版本和可用性 |
| POST `/:id/source-grants` | requestKey,expectedScopeRevision,sourceRef | 授权/新 scopeRevision；所有权及源权限复核 |
| POST `/:id/source-grants/:gid/revoke` | requestKey,expectedScopeRevision,reason | 撤销/新 scopeRevision；立即阻止后续使用 |

```ts
interface BindingPreviewInput {
  requestKey: string; action: 'assign' | 'release';
  accountId: string; teamVersionId: UUID;
  expectedBindingRevision: number;
  expectedAccountBindingId: UUID | null;
  executionChoice: 'keep_confirmed_rules' | 'pause_all';
  acknowledgePendingReapproval: true;
}
type RecoveryInput = {
  requestKey: string; expectedCommissionRevision: number;
} & (
  | { action: 'check_existing'; workKey?: string; attemptId?: string }
  | { action: 'reparse_existing'; workKey: string; attemptId: string }
  | { action: 'retry_work' | 'retry_review'; workKey: string; attemptId: string;
      acknowledgePaidRetry: true; reason: string }
);
interface DecisionInput {
  requestKey: string; proposalId?: UUID; expectedProposalRevision: number;
  commissionId: UUID;
  event: 'propose' | 'observe' | 'defer' | 'reject' | 'adopt';
  basis: TeamDecisionBasis; reason: string;
  proposedPolicyDraftId?: string;
}
```

`assign` 可首次绑定或接管账户；`release` 必须命中本团队 active binding。团队跨账户改绑使用显式两步 wizard：先对旧账户生成/确认 release 预览，展示旧账户的 executionChoice 与成功回执；再对新账户生成/确认 assign 预览，展示新账户的独立 executionChoice、guards 与回执。每步独立事务，第二步失败时团队保持未绑定，不能回滚或假装旧账户也切换成功。界面必须显示这一中间状态及重试入口；不得用一个 choice 同时处理两个账户。旧 commission/accountId 永不改写，teams.account_id 只作当前绑定缓存。archive-preview 在有 active binding 时必须明确 executionChoice；无绑定可省略。确认归档必须提交消费预览，不能仅 PATCH status；V1 无物理团队删除。归档不级联删除研究/账本/策略，已派发结果可结算回原历史，但不得继续派发新 work。需要重新开办时复制配置，恢复归档不是本轮隐藏 API。

绑定交接预览必须包含旧队“待审/待应用”提案列表及 `acknowledgePendingReapproval=true`。交接事务写入 `requires_reapproval` 事件，防止只改 binding、却让旧 pending 自动流入新队执行。原已确认策略组合另按 executionChoice 处理；保留时不增加预算/权限，不改原批准来源。

预算收紧不改变冻结计划：budget_limit_json 初始保存预览的 budgetMode、ceiling 和 callLimit，另带 budget_limit_revision。PATCH 至少提交 ceiling/callLimit 一项，调用次数须为正整数且不大于当前上限，金额只能同币种收紧；不允许通过此接口更换模式、升额或用 null 清除原金额限制。calls_only 未指定费用上限时只比较次数，null 不参与金额 min。事务记录 before/after 并递增 commissionRevision；每次派发取原授权、当前 override 与既有 owner/runtime 限制的交集。若新上限低于已用及预留，保留这些事实并阻断新调用，不追溯抹账。已派发成本和 unknown reservation 保留。不能控制外部提供方计费的 native 调用必须显示“外部费用未知/预算仅约束可观测部分”，不得宣称硬成本上限已保证。

错误码按代码判断，不靠中文提示解析：

| HTTP | code | 含义/客户端动作 |
|---|---|---|
| 400 | TEAM_INVALID_INPUT / TEAM_GRAPH_INVALID | 字段或图错误，携带 field/roleId/relationId |
| 404 | TEAM_NOT_FOUND / TEAM_REFERENCE_NOT_FOUND | 不存在或不属于当前 owner，不泄漏其他用户实体 |
| 409 | TEAM_REVISION_CONFLICT | CAS 失败，返回实际 revision；重新加载/合并，不能盲覆盖 |
| 409 | TEAM_REQUEST_KEY_CONFLICT | 同 key 输入摘要不同，客户端生成新意图后才换 key |
| 409 | TEAM_PREVIEW_STALE / TEAM_PREVIEW_CONSUMED | 预览过期/依赖变化/已被另一请求使用；重新预览 |
| 409 | TEAM_BINDING_CONFLICT / TEAM_REAPPROVAL_REQUIRED | 账户被占用、绑定变化或旧提案不能应用 |
| 409 | TEAM_EXECUTION_UNCERTAIN | 已发送但结果未知，只展示检查/恢复入口 |
| 422 | TEAM_CAPABILITY_UNAVAILABLE / TEAM_PLAN_INVALID | 执行能力不足或本次分工不满足约束 |
| 422 | TEAM_SOURCE_UNAVAILABLE / TEAM_SCOPE_REVOKED | 来源撤销/删除/权限变更，停止后续使用 |
| 422 | TEAM_BUDGET_BLOCKED | 预算不足/未知成本尚未处理，不派发 |
| 503 | TEAM_DEPENDENCY_UNAVAILABLE | 数据库或执行连接暂不可用，返回 retryable；不能因此换模型 |

未包含在团队 API 中的原账户/研究入口不能形成后门：既有 session run/recover、策略 apply 和 memory recall 都须检查记录是否带 team_context；带则使用同一 guard，旧无团队记录保持原兼容行为。

## 6. 预览、并发与提交事务

采用服务端规范化 JSON 后 SHA-256。集合型角色/部门/关系/来源先按稳定 ID 排序；依赖 key 排序去重；具有业务顺序的计划保持顺序；空值统一 null、金额统一十进制格式。hash 输入含操作、语义快照、输入/来源版本、绑定与权限 revision、预算/返工限制、executor 配置版本、compilerVersion；不含坐标、缩放、实时 busy 指示和当前时钟。display 标签只有作为本次展示快照的内容才进入对应预览，不作为权限。先持久 JSONB 再按读回表示算 hash，避免序列化差异。

preview guards 必须包含实际依赖的源版本/撤销状态和 executor 配置指纹；类型中的 sourceFingerprints、executorFingerprints 必须存在，仅无此类依赖的操作可为空数组。15 分钟只是最长有效期，期间依赖变化立即失效。能力检查无实时结果时返回 unknown，不能把旧缓存绿色状态当作本次成功。

```text
confirm(owner, operation, routeIdentity, body):
  inputHash = canonicalHash(operation, validated routeIdentity, body without requestKey)
  transaction:
    receipt = lock team_requests(owner, requestKey)
    if receipt exists:
      if receipt.inputHash != inputHash: conflict
      return receipt.result                   // 先幂等，再检查当前 revision
    lock team + draft + preview + involved account/bindings in stable ID order
    assert owner and operation/kind match
    assert previewHash == stored hash and not expired and not consumed
    revalidate guards against current DB state
    validate graph / inputs / capabilities appropriate to this operation
    apply DB state changes with CAS and unique constraints
    mark preview consumed by requestKey
    insert committed result receipt
  return stored result
```

并发首次请求没有 receipt 行可锁时，依赖 UNIQUE(owner_id,request_key) 在同一事务仲裁；冲突事务回滚后重新读取已提交 receipt，比对 hash，再返回原结果。不得先提交业务再单独写 receipt。锁顺序固定为 owner/team IDs/account IDs/preview/commission，控制锁范围；不在持锁期间联网。已有外部依赖验证先取只读快照，提交阶段用 DB revision/fingerprint 复核。

发布事务追加 TeamVersion 并更新 currentVersionId，不更改已运行委托和策略。保存草稿仅 CAS，发布预览仅存快照；拖拽布局保存只增 layoutRevision。实质职责/执行器/权限修改在草稿里生效，下一次发布后仅供新委托选择；已经确认的策略不因研究配置变化自动暂停。权限撤销和预算收紧则是实时安全 fence，不等待重新发布。

## 7. 绑定、换队、旧盘和归档

账户财务身份由现有 paper account 保持。首次绑定可选择已有无团队模拟盘；账户没有策略也可以绑定并研究，但未确认策略前不能交易。旧任务、订单和 NAV 不回填新团队归属；曲线显示绑定起点，旧区间标“绑定前历史”。创建新账户仍调用现有账户创建能力，不从 team 表推算现金。

换队的单一事务：验证双方 owner/账户状态及 preview guards → 锁旧/新 binding 与受影响策略版本 → 结束旧责任区间并建立新 active binding → 递增相关 bindingRevision → 标记旧 pending 提案需重核 → 写已确认组合的继续或暂停结果 → 写事件和 receipt。账户/team active 唯一索引处理竞争；不存在“同时双主责”的中间提交。

- 新建/未派发旧委托：旧绑定失效后 blocked，不自动转交；用户可取消或在新队发起新委托。
- 已派发 work：允许回传和成本结算至旧委托，保留原归属；不得自动启动下一个付费 work、复核、重试或策略应用。
- 原已确认组合选择继续：继续其冻结配置与审批归属，包括仍有效保护单；新队不能借继承更改仓位/权限。若原权限/来源已撤销，执行安全校验仍可阻断。
- 选择暂停：沿用现有全账户暂停语义，明确包含保护单。取消旧 pending 与保留历史仍发生；没有后续隐式自动恢复。
- 仅研究职责/布局/名称改变：不改变账户运行状态；修改执行相关策略仍走已有策略预览/确认。

归档团队先预览，再停止新研究、解除 active binding 并对在途委托执行上述边界。归档不暗中暂停账户；有运行策略时必须明确继续/暂停选择。归档 paper account 仍走原账户归档规则，同时用 shared DB helper 在同事务关闭 active team binding；不能留下列表看似仍管理已归档账户的状态。

## 8. 委托编译、研究桥接与 worker

组织关系不是执行流程。连线方向固定：reports_to 为下属→上级；delegates_to 为委托方→承接方；reviews 为复核方→被复核方。多线汇报仅为职责关系，成员可以在本次不参与。负责人选择和任务范围必须在发起前明确，不能根据“图上最顶端”猜负责人。

编译过程不调用付费 AI：校验当前版本与 active binding → 解析被选岗位 → 检查能力/权限 → 冻结来源和账户事实 → 验证工作 DAG → 生成成员快照 → 汇总预算和人工输入的指令取舍 → 返回可确认计划。workKey 按 commission 内规范化工作摘要确定性产生；摘要包含 roleId、taskKind、objective、expectedOutput、精确 inputRefs 的 kind/id/revision、账户/持仓输入快照身份、dataCutoffAt、依赖工作摘要及影响输出的范围参数。仅 requestedByRoleIds 变化不改变工作身份。相同岗位/问题但财报期、来源版本、依赖或目标范围不同，必须保留不同 work；真正相同工作才合并主管引用。DAG 先做无环校验，再按拓扑顺序生成依赖摘要并检查 workKey 冲突；不能依靠文本相似度合并任务。

最后 summary 唯一由 leadRoleId 承担；多主管参与只作为 supervisorRoleIds/复核人，不共享最终责任。复核人可以按 work 指定；无法独立复核时明确 self_check。预算 `paidRevisionLimit` 默认为 0，只有用户在预览明确批准次数和总预算才允许有界返工；现有自动一次内容返工在团队分支不得作为隐藏默认。现有底层 attempt 总上限继续保留。

```text
create commission transaction:
  consume fresh commission preview via standard request receipt protocol
  assert active binding, exact version, source grants, budget limits
  insert immutable commission plan/input/member snapshots
  create/reuse existing research-core root budget for this commission
  insert prepare job(commandKey = 'prepare:v1')
  return 202

prepare worker transaction:
  claim job by lease + owner fence
  if commission already has sessionId: mark done
  else CouncilService.prepareTeamSessionInTransaction(tx, frozenContext)
    inserts session with team_context BEFORE any memory recall
    stores frozen members/plan and links sessionId on commission atomically
  insert start job(commandKey = 'start:v1')
  mark prepare done

start worker:
  preflight current binding/scope/budget/capability fence
  call CouncilService.runTeamSessionOnce(commandId, frozenSessionId)
  existing runtime owns tasks/attempts/remote calls/usage
  enqueue project on durable changes; project reads original records and UPSERTs links
```

`prepareTeamSessionInTransaction` 是拟新增内部入口，不复用“先创建普通 owner 会话、再补 teamId”的方式。现有 createSession 在创建阶段会 owner memory.recall，补写存在泄漏窗口。团队路径先设置 audience/team scope，再允许 recall。冻结成员 instructions 与本次 assignment 完整进入既有 prompt 编译，不截断职责、不调用额外模型自动总结。

`runTeamSessionOnce` 必须在原 session 状态事务接受唯一 commandId，并留下可恢复的启动记录后才进入现有执行器。任务 claim、attempt、远端 taskId 保存在原 workflow-store；外部调用前写持久“已准备发送”状态，接到句柄立即记录。进程在发送附近崩溃时，不能依据 HTTP 超时重新 start；按第 9 节 unknown 处理。没有外部幂等协议时不能声称网络 exactly-once，目标是本地命令 exactly-once acceptance 加不盲重发。

现有 `council.workflow.ts` 接受 nullable frozenTeamPlan：空时保留旧 planResearchTasks；非空时采用 workKey/dependencyWorkKeys/reviewerMemberId。执行器、交付解析、attempt 记账、技能限制仍沿用现有模块。research-routing 全局 fallback 不参与显式岗位解析。team recovery 不读取最新 owner agentSettings 覆盖冻结 MemberSnapshot；执行器变更需重新预览委托。

worker lease 建议 30 秒、心跳 10 秒，数据库使用 SKIP LOCKED claim。同一个 commission 的 prepare/start/recover 受 DB revision/command fence 串行化。纯 prepare/project 可指数退避；start/cancel/recover 只有确定尚未派发时才可安全重试。长调用不能占用数据库事务；project 丢失可由周期扫描既有 session 修复，不触发研究。服务重启优先恢复关联/投影和查询远端状态，不自动补发未知调用。

### 8.1 原生负责人能力检查

返回 `supported|unsupported|unknown` 及 checkAt/evidence，不把“连接成功”当作“可当负责人”。负责人至少需要本次结构化 summary、必要时结构化 review、结果句柄/恢复语义、输入上限及团队来源隔离能力；专项成员只校验其被分配任务的能力。能力不足时阻止本次运行，允许保存/发布组织；不自动换成内置负责人，也不把所有 native leader 设计性排除。

能力检查使用适配器声明、现有连接状态和已验证协议测试；本轮文档工作不运行真实 AI。未来工程集成测试以 fixture/假服务器验证，真实付费验收需另有明确授权。

## 9. 状态机、取消、恢复与费用

TeamCommission 是既有研究状态的读模型和控制入口，不能绕过原 task/attempt 状态机。queued 表示已接收且尚未派发；running 表示至少有一个已知运行 work；awaiting_review 表示交付待复核/人工处理；completed 需计划要求的 summary 和全部必需 work 已接受；partial 表示已有可用交付但另有必需任务确定失败/取消；blocked 表示权限、能力、预算或绑定阻止继续；failed 表示无可用交付且确定失败；uncertain 表示至少一个外部调用是否执行或完成不确定。未知优先于“失败”展示，不能以超时推断没发生费用。

| 当前状态 | 允许事件 | 结果与限制 |
|---|---|---|
| queued | 准备/启动成功 | running；来源/预算 fence 失败则 blocked，不付费派发 |
| running | 交付提交 | 按现有 delivery schema 入库，待复核则 awaiting_review；直接接受条件仍由原引擎控制 |
| running/awaiting_review | 计划完成或部分失败 | completed/partial/failed；不能凭“有文字”视为结构化验收通过 |
| 任一未终态 | 远端结果未知/重启发现运行中 | uncertain；保留 attempt、remoteTaskId、费用 reservation |
| queued/running/awaiting_review/blocked/uncertain | 用户取消 | cancelling；事务先持久取消意图与 revision，再请求外部取消 |
| cancelling | 已知所有任务未派发/取消成功/已结算 | cancelled；已有交付保留 |
| cancelling | 远端不能确认取消 | uncertain，保留 cancelRequestedAt；不能显示“已取消且无费用” |
| blocked/uncertain/partial/failed | 显式 recover | 仅指定 work/attempt，验证当前权限和授权；原记录/快照不改写 |
| completed/cancelled | 原执行的晚到结果 | 写审计和实际用量，不重新打开委托/自动应用策略 |

`acceptedAttemptId` 指向具体成功 work attempt，不是最后一次 reviewer attempt；复核事件另存 review attempt 引用。结构化解析失败保留原返回与解析错误，允许 `reparse_existing` 不新增模型调用。接受交付不等于用户批准论点，也不等于批准交易。

恢复四类动作严格区分：

- `check_existing`：可在 commission 级检查 prepare/start 命令、session 关联和已有远端句柄，适用于尚未产生 attempt 的未知状态；此时 workKey/attemptId 均省略。指定 workKey/attemptId 时二者必须同时存在且精确关联。查询只读，不能没有句柄就重新创建任务。
- `reparse_existing`：对已保存原始结果重新解析/验证，仍沿原 attempt，不重复收费、不重复记 delivery。
- `retry_work` / `retry_review`：确认为新的外部尝试。需要指定旧 attempt、理由、当前可执行绑定/来源和 acknowledgePaidRetry；只能消耗原预览已经授权且仍剩余的 callLimit、paidRevisionLimit 与预算额度，不能通过 recover 增加授权。额度不足或希望扩展任务时新建委托预览，再由用户确认；不能在旧委托追加 authoriseNewPaidAttempt 绕过冻结计划。创建新 attempt 并关联 supersedes。旧 uncertain 未确认停止且可能仍产生同一效果时，禁止盲重试。
- 适配器无查询/取消能力时显示“结果未知，需核对连接端”，允许记录人工核对证据；人工“确认未执行”也需保存 actor/time/reason，不能静默把未知转为失败或释放费用。

现有 root budget、调用数限制、attempt 总上限与 recovery fence 继续使用。每次 work/review/有偿返工 dispatch 前，统一原子检查并 reservation；检查预算上限、调用数、deadline、scope、binding、cancel fence。deadlineAt 超时停止新派发，已派发可结算；dataCutoffAt 限制输入资料可用时间，不随重试漂移。付费修订默认 0，即使底层曾有一次自动返工也不能在 team 分支隐式继承。

预算模式拟明确为 `budgetMode='cost_and_calls'|'calls_only'`：前者 ceiling.amount 必须为具体非负数值；后者只有当前账户既有授权允许且用户在预览显式选择才可 ceiling.amount=null，并显示仅限制调用次数、外部成本未知。callLimit 必须正整数，模型工作、复核和有偿返工共同计数；null 绝不表示免费或无限授权。收紧预算只影响尚未派发的调用，已经提交/unknown 的消耗及 reservation 仍在账上。增加费用上限或调用次数不属于“恢复”默认权限，必须另行确认。

TeamCostSummary 区分 confirmed、reserved、estimatedMaximum 与 externalUsageUnknown：有已知部分就展示“已知成本 X + 未知 N 次”；完全未知为 null，不转成 0。不能把 native 自报数值未经校验当成真实费用，更不能根据估算推断费用已经结算。比较页若费用不可比，应保留未知提示和覆盖率，不按 0 计算团队排名。

## 10. 决策、论点版本与模拟执行关联

唯一可审计链为：`TeamVersion → Binding → Commission → Session/Cycle → workKey → acceptedAttemptId → ReportVersion/ThesisVersion → DecisionEvent → StrategyAssignment/PolicyRevision → Signal → Order → Trade`。链上某段不存在就明示缺失，不能根据相同 ticker、临近时间或负责人名称拼接。

`team_decisions.event` 使用 `propose|observe|defer|reject|adopt|requires_reapproval|applied|continue_policy`。proposalId 是同一决策提案的稳定标识，proposalRevision 递增；每次事件追加新记录。agent 可提出 propose/observe/defer 建议，user 才能 adopt/reject；系统只写 derived 的 requires_reapproval/applied/continue_policy。HTTP 客户端不能伪造 actor 或提交 applied。所谓 adopt 表示用户接受该提案进入策略确认流程，不直接创建订单。

保存决策时逐项验证：

1. commission、session、cycle、workKey、acceptedAttemptId 确实相互关联且归当前 owner/team；目标 attempt 是对应 task 接受的成功工作尝试。
2. reportVersionId / thesisVersionId 必须来自该交付、明确被本次作为输入使用，或存在可验证引用链；不能只检查“该 owner 有这条论点”。
3. 论点以版本 ID 引用，不用当前最新版替换。沿用原论点草稿/确认/撤回状态；任务验收通过不能自动把论点变为用户确认。决策采纳所要求的论点确认必须由显式操作完成并留证据。
4. 来源仍可用，as-of 不晚于 dataCutoffAt；用户能读旧审计标识不代表可重新向模型提供已删/撤销正文。
5. 新应用决策必须属于当前有效绑定；旧 binding 的 pending 记录只能生成 requires_reapproval，不能直接把 teamId 改成新队。重核后生成新事件/新来源快照并引用旧提案作为背景。

现有账户策略 draft/preview/apply 增加可选 `teamDecisionRefs: TeamDecisionRef[]`。团队来源的拟应用策略必须提供这些引用，并纳入原 preview hash、策略组合/账户 policy 的冻结 JSON。原不带团队来源的历史策略路径保持兼容；不能拿“兼容旧接口”为新团队提案省略决策引用。

策略应用事务内部调用共享验证 helper：校验预览 guards → 校验精确 team decision/binding/sources → 调用已有策略应用逻辑 → 保存 applied 事件与 links → 保存原请求回执，一次提交。禁止先应用策略再异步补出处。执行 Signal/Order/Trade 时继承 frozen policy 中的引用，按实际产生的 ID 写 links；不能按“当前 active team”重新归属。失败/拒绝/取消订单也保存原引用，成交记录不得覆盖原订单理由。

原 `PortfolioWorkspaceService.apply` 取 owner-wide SimpleCouncil reviewMembers 的路径不能继续用于新团队提案。团队策略预览应选定已冻结的负责人/复核岗位，并写入 policy snapshot；同一连接的两个岗位要如实披露，不满足独立模型审查要求时按现有交易规则阻断或要求用户明确人工确认，不能冒充独立复核。

换队后明确选择 continue_policy 的既有策略，执行时可凭原 applied 事件与交接 continuation receipt 继续原授权，不要求把历史 binding 改为 active；这只是继续已确认冻结规则。新建议、调整仓位、扩大预算/工具权限、应用新策略仍必须当前 binding 和新的确认。模型的研究结论不得直接改交易 intent。

## 11. 权限、资料生命周期与团队记忆

owner 认证仍是外层边界，team scope 是其内部执行隔离，二者不能混为一谈。UI 的 owner 可查看多个团队历史，但模型工具、自动摘要和外传上下文必须使用明确 `audience:'team'`。`owner_ui` 与 `team` 是可区分的服务入口/上下文，不能把漏传 teamId 回退为 owner 全库。

### 11.1 来源进入与退出

每个输入源冻结精确版本、可用时间、owner、授权 team、用途和 availability；引用既有 report/thesis/document/data version，不建立平行资料库。团队自有输出在原记录写入事务就带 team audience；共享 owner 资料需要显式 grant，不能因为同一用户可看而默认进入所有团队模型。

授予来源时验证当前用户确实有权限、具体版本可用，记录 grant；撤销/删除/失效时增加 scopeRevision。发布组织不自动授予新资料。创建 preview、创建 session、每次派发、结果写回、记忆写入和决策应用前均检查相关 source/grant fence；变更后旧上下文只能停止或提示重新预览，不继续使用旧缓存里的正文。

上游删除不级联删除财务审计与引用标识，但 UI 显示“来源已删除/不可用”；摘要或派生记忆必须沿 provenance 递归判断可用性。删除标记、旧 audit snapshot、debug log 和原始模型返回不能成为再次提供正文的旁路。既有 `ResearchDocumentsService.assertExecutionSourcesInTransaction` 的可用性/版本/依赖检查应复用，而不是只在 team controller 检查一次。

### 11.2 隔离覆盖面

| 环节 | 必须实现的 team fence |
|---|---|
| createSession/run/recover | 创建前有可信 team_context；不调用 owner recall 后补 teamId；恢复不读最新全局成员替换冻结快照 |
| memory recall / search | owner+team audience+允许 source refs，过滤在排序/截断前发生；显式空 allowlist 表示禁止，不等于无限 |
| report/thesis/memory write | 同事务写团队归属和来源 provenance；投影延迟不能留下 owner-global 可读窗口 |
| embedding/vector index（若已有） | namespace/filter 纳入 owner/team/audience/source version；召回后再次校验授权；不为本功能顺带新建向量基础设施 |
| prompt/结果/检索缓存 | key 含 audience、teamId、scopeRevision、源版本与执行器相关版本；撤销后不能命中旧授权正文；跨队不能只用 ticker 作 key |
| research-tools | tools scope 显式 team 上下文、allowedAccountIds 仅本账户、来源 allowlist；禁止 owner 默认 fallback |
| native/model 外传 | 派发前生成确切允许输入、源权限和账户快照；日志脱敏凭证；工具 token 绑定 session/revision/member/team 且短期有效 |
| 状态投影/前端查询缓存 | owner/team/account 维度分别入 key；切换账户先变 query key 再取数，不能短暂展示前一账户结果 |

Squabble 能强制隔离自己提供的工具、资料、记忆与请求上下文，**不能仅凭 teamId 保证外部原生助手自带工具、历史会话、长期缓存或本地文件都隔离**。可接入团队私有资料流程的 native 执行器须有可验证的独立任务上下文/工作目录、受控工具与记忆行为、清楚的外传边界；适配器显式声明并通过 fixture/集成验证。无法证明隔离的执行器可以展示为连接存在，但不能进入团队私有资料流程，不能把风险伪装为已支持。公共信息任务也须明确能力限制，不得静默扩大输入到私有账户/记忆。

权限快照决定授权上限，当前撤销状态决定是否仍可使用；取二者交集。多主管/跨组关系不叠加 allowedToolIds，不自动传出资料，不增加预算。代理返回“再问另一个成员”等文本只作为建议，不能直接扩展 frozen work DAG。V1.1 的自动研究授权以后单独建模，绝不复用交易开关；本版本只允许用户确认的一次有限委托内按计划推进。

## 12. 页面、账户上下文与可信展示

`/teams` 读取团队列表与现有账户 read model；`/teams/:id` 用组织/分组/关系/分工/发布的子状态，不另占 `/paper`。可以用 URL query 保存编辑面板和 commissionId，刷新恢复上下文；不能用组件内存作为唯一版本来源。页面显示“草稿已保存”和“版本已发布”两个明确状态，保存草稿不会变更运行。

`/holdings?accountId=real|<id>` 是统一入口。无参数按当前产品默认实仓处理；非法/无权账户显示不可用，不静默跳实仓。paper 只读，隐藏导入、编辑实仓和对账入口；后端也拒绝将 paper accountId 填入真实持仓写接口。真实持仓编辑保持现有能力。进入交易账本继承 accountId；研究订单/委托返回保留 accountId；进入工作区级关注列表时明确“关注列表属于工作区”，保留 returnAccountId，不能假称某团队专属关注列表。

首页总资产只统计实仓。团队各自显示模拟净值/收益/曲线，不能把模拟金额加进实仓总额。历史曲线使用已有持久 NAV；当前 mark、收益口径、起止日期、币种、入金/出金和缺失段按原比较服务展示。绑定前历史、未估值、行情过期、费用未知分别注明；不得用 0 填缺口，不给账户上线前造历史。团队比较是观察性比较，初始资本/时长/费用不同不能宣称为同条件实验。

前端拖拽只是编辑草稿/布局：移动坐标保存 layout；拖入部门而改变 departmentId 属于 semantic 修改；连接创建/变更属于 semantic；连接切换弹出相应责任范围/影响提示，不把旧线覆写进已发布版本。两个岗位共享连接展示明确徽标，空缺岗位显示未启用。发布预览列真实语义差异和下一次研究影响；本次研究分工预览列唯一主责、参与/复核、数据截止、期限、预算模式、调用次数、返工上限和未知费用。

CAS 冲突返回服务器 revision 与变更提示，用户可加载最新或手动合并；不能自动覆盖别人改变的组织语义。纯布局并发可以限定到布局层合并，但不得由坐标合并算法改变部门归属。浏览器拖拽/键盘操作/触屏与加载错误需要真实浏览器验收，纯 graph 单元测试不能替代。

## 13. 迁移、发布与回滚

### 13.1 迁移实施步骤

1. 实现前检查当前 `server/common/platform/database.provider.ts` 的 startupMigrations、目录中 SQL 与 `scripts/db/list-startup-migrations.cjs` 输出；确认最新编号和并行分支登记情况，再分配未占用新编号。不在设计阶段写死 61。
2. 新 migration 采用 additive schema：新 teams 表、nullable 旧表字段、必要索引与兼容判断。同步导出 `teams.schema.ts`，更新启动迁移列表、数据库 schema 汇总以及适用的 fixtures；新增迁移路径登记到当次开发文档。
3. 旧 task key unique 改 partial 的迁移须考虑所有 SQL 在启动时重复执行。保留原 index 名的 partial 定义，新增 workKey unique；重复运行检查不会重建全量 index、不会失败或丢数据。涉及索引 DDL 的事务/锁时长按实际 PostgreSQL 环境核验。
4. 不扫描旧研究按 ticker/时间归队，不重算历史交易归属，不更改既有账户余额或 NAV，不生成伪造 TeamVersion。旧 records 的 team 字段维持 null。
5. 验证空库全量迁移、带真实形状旧记录的基线升级、同一迁移重复两次、旧 API 读取/继续运行，和新 team 记录 coexist；不能只测新表插入。

### 13.2 上线与回滚边界

拟设 `TEAM_WORKSPACE_ENABLED`（页面/组织写入）和 `TEAM_RESEARCH_ENABLED`（新团队委托派发）开关；初始关闭，按部署机制配置。GET 列表响应 capabilities 供前端决定入口/按钮状态；关闭开关不删除历史，也不关闭 team scope guards。关闭研究开关停止新派发，但保留远端查询、取消、结算和审计读取；不能把执行中的未知任务当作取消成功。应用上线顺序为 additive schema → 兼容服务端（包括 team scope guards）→ 前端 → 受控启用。

回滚首先关闭新派发，再回滚到理解 team_context/权限 fence 的兼容构建；一旦产生团队记录，直接退到完全不识别 team scope 的老二进制可能走 owner fallback，因此不允许作为无风险回滚。保留新表/nullable 字段/历史事件，禁止用 down migration 删团队审计或把团队资料回填 owner-global。必要时只读降级，等在途执行有明确结局后再处理。

回滚不能退还未知成本、撤销已经产生的模拟交易或重写旧策略历史；财务纠正必须使用原模块的可审计操作，不通过删除 team 链修补。队伍归档/解除绑定/关闭功能开关均不是数据删除。

## 14. 开发验证与审核闸口

文档本轮验证只包括源代码定向阅读、契约/跨文档一致性和本文件检查；未执行应用开发、数据库迁移、真实 AI 调用或部署。以下是后续实现必须完成的验证，不表示本轮已通过：

- 合同与图规则：`teams-contract.spec.ts`、`teams-graph.spec.ts` 覆盖金额/null、版本区分、多线汇报/无环校验、唯一主责、稳定 workKey、同交付多方引用、两个岗位共用执行器、空缺岗位。
- 事务集成：`teams-publication.integration.spec.ts` 覆盖同 key 重放/不同摘要、过期预览、CAS、并发 active binding、交接 pending 重核、保留/暂停保护单、归档不删历史。
- 研究集成：`teams-commission.integration.spec.ts` 覆盖 session 创建前 scope、一次启动、crash 边界、unknown 不付费重发、取消晚回、默认零返工、预算收紧阻止新 work、保留已派发用量、冻结成员不随偏好变更。
- 记忆集成：`teams-memory.integration.spec.ts` 覆盖检索前过滤、来源删除/撤销、写入原子归属、缓存 key、工具外传 scope、native 无隔离能力阻断和真实/UI owner 读取的区分。
- 升级集成：`teams-upgrade.integration.spec.ts` 覆盖旧 schema → 新 schema → 再次启动、partial index 保持、旧史 null、不回填假链、兼容回滚读取。
- 集成测试库统一 `TEAM_TEST_DATABASE_URL`，同时登记 server test glob 与 CI env；不得借用开发/生产数据库。前端纯函数按现有 loader 用 `client/src/utils/team*.test.cjs`，交互另用浏览器验收。
- 运行仓库要求的 lint/typecheck/build、相关架构/上下文检查及有意义的既有回归；引用 `squabble-contributor` 实现时当前规则。无必要不重复全量测试，不把 mock 成功视为 native 能力已实证。

开发开始前仍需审核：预算模式/调用数表单与后端同一含义；既有 local 适配器对 native leader 的实际能力清单；允许进入私有资料流程的可验证隔离能力；多账户切换及交接选择；新来源/决策引用与旧策略预览兼容。无法证实的能力以 unknown/unsupported 呈现，不凭原型推断已接通。
