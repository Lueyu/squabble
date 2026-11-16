# 团队组织整改实施进度（2026-11-14 开发文档交付轮）

本文记录本轮开发计划（docs/superpowers/plans/2026-11-14-team-organization-redesign.md）的实际执行证据：
基线/分支、已完成任务 ID、改动文件、真实命令 exit code 与 pass/fail/skip 计数、未通过原因、下一任务、未结算请求及原 key。
不记录密钥、个人持仓、提示词正文或真实模型回答。

## 基线与仓库状态

- 基线 commit：`e0112086ee60a6e945efe0a528812a18f1b6aad9`（`fix: open simulated baselines from recorded prices when live quotes are unavailable (#106)`，即 PR106 合并点）。
- 分支：`codex/team-organization-redesign`（从基线新建，工作树干净；用户无脏文件需保留）。
- 环境：Node v24.16.0（引擎要求 >=22）；Docker 29.9.2（专用 PG16 fixture 可用）；npm 脚本见 package.json。
- 文档核对：docs/team-organization-redesign/* 与交接包 manifest.json SHA256 全部一致（01=ee55c537…、02=647d92e4…、03=a6e7bb24…、04=7ea4d412…、05=eab68bed…、README=ad98d071…、reference-team-editor.png=746ab5c6…、plan=4df627e4…）。
- 授权状态：本轮仅开发文档与代码实现；无部署授权，不启动/改动个人 3192 服务，不用个人持仓作测试数据。

## 虚构验收场景（T01，05 文档第 1 节）

所有场景在专用 fixture 服务与测试数据库（Docker `squabble-team-redesign-pg`，端口 55479，库 `squabble_team_redesign_test`）上运行，使用不同 owner UUID 验证跨用户边界，不调用真实模型。

| 编号 | 固定输入 | 用于哪类验证 | 对应验收项 |
|---|---|---|---|
| F0 | 无股友、无连接、无持仓 | 可选 classic 并创建 4 岗 2 部门占位组织；缺员明确；不强迫授权运行；创建不发布/不绑定/不启动 | AC03, AC04, UI-03, UI-06 |
| F1 | 12 专业各一位可用股友 | classic 匹配 4 个不同身份；三栏画布正确显示动物身份；配员按专长去重 | AC04, AC05, AC16, A07 |
| F2 | 只有一位财报股友 | 尽调模板口径/现金流两岗不复用同一身份；另一岗保持待安排；不自动创建第二位 | AC18, AC02, A08, A09 |
| F3 | 5 位全是财报专长 | 补齐入口仍显示其余 11 种专业缺口；按专业集合而非总人数判断 | AC17, A05, A20 |
| F4 | 旧团队无 blueprint、有已发布版本和已确认 run 协议 | 历史解释保持 legacy；新版另存草稿、发布并重新确认协议；不静默改写旧协议 | AC29, AC41, AC46, UI-22, UI-26 |
| F5 | classic 已发布，假模型按脚本交付/拒绝/超时 | 真实 Council 任务依赖、reviewer、summary 与结构预览一致；上游未验收时下游不提前执行；C 可在自己 challenge 前复核 F | AC42, AC43, AC13, T13 执行一致性 |
| F6 | schema67 旧数据、旧不可变版本/accepted attempt | 新代码可读写新配置（JSONB 兼容）；原记录 hash/归因不变；无蓝图旧协议下一周期仍旧分工 | AC46, AC44, A11, T12 |
| F7 | 已发送创建请求、客户端未收到成功 | 刷新后沿确切 key/payload 查询或续做；无重复团队/股友；未知结果不换 key 重建 | AC25, AC26, UI-23, UI-25 |

## 任务进度

### T01 基线与可复现虚构场景 ✅ 完成

证据（2026-11-15 00:50–00:57 本地时间，HEAD e011208，分支 codex/team-organization-redesign）：

- `git status --short` → 空（工作树干净）；`git rev-parse HEAD` → e0112086…；`node --version` → v24.16.0。
- 读取并核对：package.json（脚本：test:server/test:client/lint/type:check/build:web/ui:density/ui:probe 等）、.ui/README.md（fixture 只读、无 baseline.json、route-matrix 112 场景）、scripts/ui-probe/fixture-server.cjs（151 行；仅 GET + 一个 POST 预览；未知 API 404 记录到 /__fixture__/state；agents 由 agent-templates.json 生成 22222222-…/33333333-… UUID）。
- 当前“选组合生成空部门/空关系”行为证据（基线测试真实通过）：
  - `node --test client/src/utils/guided-team.test.cjs client/src/utils/guided-team-presets.test.cjs` → 7 pass / 0 fail。其中 guided-team.test.cjs 断言 `rosterTeamConfig` 返回 `{ departments: [], relations: [] }` 且 leadRoleId 取 moderator（无 moderator 取末位）、expectedOutput 为通用英文句 `'Evidence, judgment, uncertainty and a reasoned next step'`；guided-team-presets.test.cjs 断言 4 个 presets 顺序 `recommended,valuation,defensive,full` 且推荐组合 `financials,bear,moderator`、resolve 取首位可用股友跳过缺失专长。
  - shared/team-templates.ts 现状：10 个模板全部经同一 `build()` 生成两部门结构（研究+复核），relations 仅 reports_to 链+最后一位 reviews 负责人，无 delegates_to、无 blueprint、无 staffing——与 04 要求的 11 模板各异拓扑冲突，需 T06/T07 替换。
- 五/八类虚构场景与验证用途：见上表 F0–F7。

下一任务：**T02 扩展专业 ID 与完整双语目录**（shared/agent-roster.interface.ts + 新增 shared/agent-specialty-catalog.ts + server agent-roster.rules.ts 及 spec）。

### T02 扩展专业 ID 与完整双语目录 ✅ 完成

证据（2026-11-15 01:00–01:06 本地时间，HEAD e011208 + 本任务未提交改动，分支 codex/team-organization-redesign）：

- 改动文件：
  - shared/agent-roster.interface.ts：`AGENT_TEMPLATE_IDS`（12 个，旧 5 在前）与 `LEGACY_AGENT_TEMPLATE_IDS`（原 5 个）、`AgentTemplateId` 由常量推导、新增 `AgentTemplateGuide`（strengths/requiredInputs/workflow/outputSections/counterchecks/unknownHandling/exampleTasks/recommendedSeats 均为 string[]）、`AgentTemplate` 增加必填 `guide`/`guideEn`。
  - 新增 shared/agent-specialty-catalog.ts（唯一静态目录，无 DB/凭证/模型副作用）：12 条完整双语目录，instructions/instructionsEn = 02 文档 §4.2/4.3 通用约束逐字 + §5.x 专业指令逐字 + 按专业标准交付句；guide/guideEn 8 个数组与 02 §5.x 的擅长/输入/步骤/交付/反证/未知/示例/推荐岗位对应且中英数组长度一致；默认工具上限严格按 02 §6 映射（仅 registry 实存只读 ID，compute 工具 run_statistics/run_backtest 不默认）；12 专业复用 7 个既有动物外观。
  - server/modules/agent-roster/agent-roster.rules.ts：`templateId = z.enum(AGENT_TEMPLATE_IDS)`；recommendedSchema 上限 12 且去重；删除 rules 内重复的工具/头像/英文指令映射，`AGENT_TEMPLATES` 直接引用目录（单一来源防漂移）；保留 prepareAgent/snapshotMember/defaultRole/canonicalAgentToolId/assertCeiling 契约不变。
  - server/modules/agent-roster/agent-roster.service.ts：旧客户端省略 templateIds 时改用 `LEGACY_AGENT_TEMPLATE_IDS`（原 5 类），不再默认创建全部模板。
  - server/modules/agent-roster/agent-roster.rules.spec.ts：重写为 9 个用例（12 ID 顺序、新 ID 解析/未知拒绝、legacy 集合、推荐 1–12 去重边界、目录完整性=中英 guide 非空且长度对应/双语通用约束前缀/工具均在 RESEARCH_TOOLS 且无 compute/avatar 合法/名称中英规范、§6 工具映射逐项断言）。
- 实际命令与结果：
  - `node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test server/modules/agent-roster/agent-roster.rules.spec.ts` → **9 pass / 0 fail / 0 skip**（duration 1383.9ms，exit 0）。
  - `npm run type:check` → server 与 client 均 exit 0（AgentTemplate 新增必填 guide 字段未破坏任何消费方）。
- 兼容性：无数据库迁移；既有 profile/能力版本 JSON 不重写不回填；目录更新只影响之后主动创建/选择预设。现有 integration spec 对省略 templateIds 的 `items.length === 5` 断言与新 legacy 行为一致（真实 PG 用例在 G1 阶段执行；12 个显式 ID 的库级覆盖随 T05/G1 集成用例补充）。
- 遗留（按计划留到后续任务）：scripts/ui-probe/agent-templates.json 仍是旧 5 模板，T13 扩展 fixture；AgentRosterWorkspace/Editor UI 的 12 专业浏览与补齐属 T03/T11。

下一任务：**T03 股友库浏览/补齐/岗位匹配**（AgentRosterWorkspace.tsx、AgentRosterCard.tsx、AgentEditorDialog.tsx、新增 team-staffing.ts + 客户端测试）。

### T03 股友库浏览/补齐/岗位匹配 ✅ 完成

证据（2026-11-15 01:04–01:10 本地时间，HEAD e011208 + 本任务未提交改动，分支 codex/team-organization-redesign）：

- 改动文件：
  - 新增 client/src/features/teams/team-staffing.ts（纯函数，无 React/无副作用）：`ownedSpecialtyIds(agents)` 只计 `status==='active' && availability==='configured'`；`missingSpecialtyIds(agents)` 按专长集合求差；`matchStaffing(slots, agents)` 按岗位顺序过滤合格候选（专长匹配 + 未被消费），返回 assignments/open/candidates，绝不创建身份或发请求。
  - 新增 client/src/utils/team-staffing.test.cjs（经 simple-test-loader 加载 TS）：6 个用例覆盖 F3（5 位财报仍缺 11 种）、缺 bear、F2（单一财报不能填两个独立财报岗）、archived/unavailable 不自动配、跨专业按顺序消费不同身份、空名册不伪造。
  - client/src/features/agent-roster/AgentRosterWorkspace.tsx：推荐补齐改为按缺失专业（`missingSpecialtyIds`），名单分页未读完（nextCursor）或查询失败时不计算缺口；新增可浏览的 12 专业目录（`<details>`：中英名称/专长/标准交付/工作步骤前 3 条/已有数量/“添加此专业”）；卡片传模板、编辑器传 `initialTemplateId`（新建预选专业）。
  - client/src/features/agent-roster/AgentRosterCard.tsx：props 增加 `template?: AgentTemplate`；显示典型交付；新增“工作方式与专业说明”折叠块（工作步骤/反证核查/典型任务/推荐岗位，按语言取 guide/guideEn），并注明预设说明不代表已授权工具/资料/交易权限。
  - client/src/features/agent-roster/AgentEditorDialog.tsx：props 增加可选 `initialTemplateId`；新增所选专业的 guide 展示块（擅长/输入/步骤/交付/反证与未知/示例/推荐岗位，中英）；切换专业时：工作指令未自定义（未编辑过）→跟随新专业默认；已自定义→保留内容并显示“采用新专业默认指令 / 保留我的指令与工具”显式选择（A12：切换后取消不丢自定义内容，确认保存才产生一次能力版本变更）；工具上限仅在用户未钉住自己工具时跟随新建议上限。
- 实际命令与结果：
  - `node --test client/src/utils/team-staffing.test.cjs client/src/utils/guided-team.test.cjs client/src/utils/guided-team-presets.test.cjs` → **13 pass / 0 fail / 0 skip**（staffing 6 + guided 7，duration 689.3ms，exit 0）。
  - `npm run type:check` → server 与 client 均 exit 0。
- 兼容性：不改服务端契约；配员建议是纯前端推荐，不授来源/工具权限；组织岗位缺口建议入口（按组织缺员推荐）按计划在 T11 TeamRosterBinding 落地。

下一任务：**T04 blueprint 类型/schema/纯编译器**（新增 shared/team-work-blueprint.interface.ts、server/modules/teams/team-work-blueprint.ts、teams-work-blueprint.spec.ts；改 shared/team-workspace.interface.ts、server/client team-graph.ts 与草稿规范化）。

### T04 blueprint 类型/schema/纯编译器 ✅ 完成

证据（2026-11-15 01:13–01:18 本地时间，HEAD e011208 + 本任务未提交改动，分支 codex/team-organization-redesign）：

- 改动文件：
  - 新增 shared/team-work-blueprint.interface.ts（wire 类型）：`TeamBlueprintTaskKind`（financials/business/valuation/challenge/specialist）、`TeamBlueprintReviewMode`（independent/self_check）、`TeamBlueprintWork`、`TeamWorkBlueprint{schemaVersion:1, works, summary}`、`TeamWorkPlanMode`（blueprint_v1/manual_custom/legacy_run_v1）、`TeamWorkPlanProof{mode, compilerVersion, semanticHash, blueprintHash}`、`BlueprintDiagnostic`、`CompiledBlueprintWork`（含 summary taskKind 与 inputRefs/requestedByRoleIds）、`CompiledBlueprint`（participantRoleIds/leadRoleId/work/minimumCallCount/unusedReviewRelationIds/nonParticipatingRoleIds/blueprintHash）。
  - shared/team-workspace.interface.ts：`TeamSemanticConfig.workBlueprint?`（可选，schemaVersion 保持 1，旧 JSON 无字段仍可读）；`TeamCommissionPlan.workPlanProof?`（注释：仅服务端生成，不接受客户端 body）。
  - shared/team-run.interface.ts：`TeamRunConfiguration.workPlanProof?`（同注释）。
  - server/modules/teams/team-graph.ts：新增 strict blueprint/work/summary Zod schema（workId `^[a-z][a-z0-9_-]{0,63}$`、objective/expectedOutput trim 1..1000、dependencyWorkIds ≤5 同正则、works ≤5）；`semanticSchema` 增加可选 `workBlueprint`；`normalizeSemanticConfig` 按 workId 排序 works、按字典序排序 dependencyWorkIds（缺字段保持缺失，不正规化为空蓝图）；`compileTeamPlan` 的 workKey hash 增加 `reviewerRoleId+reviewMode`（同内容不同复核者不再被去重合并；新 hash 仅用于新预览/新工作，已落库 commission 的 workKey 不重算）。
  - 新增 server/modules/teams/team-work-blueprint.ts（纯编译器，无 DB/HTTP/LLM/React import）：`TEAM_WORK_BLUEPRINT_COMPILER_VERSION='team-work-blueprint-v1'`、`SUMMARY_WORK_ID='summary'`；`diagnoseWorkBlueprint`（BLUEPRINT_MISSING/LEAD_REQUIRED/INVALID_WORK_ID/RESERVED_WORK_ID/DUPLICATE_WORK_ID/UNKNOWN_ROLE/LEAD_WORK_NOT_ALLOWED/UNKNOWN_REVIEWER/DUPLICATE_WORK_ROLE/TOO_MANY_WORKS/SELF_DEPENDENCY/UNKNOWN_DEPENDENCY/WORK_CYCLE/REVIEW_MODE_MISMATCH/REVIEW_RELATION_REQUIRED/INDEPENDENT_REVIEW_SAME_FRIEND/TOO_MANY_PARTICIPANTS/REVIEW_RELATION_UNUSED/ROLE_NOT_READY，issues 上限 24，后两者为 warning）；`compileWorkBlueprint(config, context)`：validateTeamGraph→诊断→阻塞项 teamError('TEAM_PLAN_INVALID', first.message, {field, issues≤5})→Kahn 拓扑（tie 按 workId，数组顺序不影响计划）→每普通 work（workKey=workId、objective=context+岗位职责+work 目标 join、deps 排序、requestedBy=delegates_to 去重或 [lead]）→summary（deps=全部普通 work）→participantRoleIds≤6→minimumCallCount=(普通 work 数+1)*2→blueprintHash=canonicalHash({blueprint 归一化, leadRoleId, requestedBy, reviews 排序})。
  - 新增 server/modules/teams/teams-work-blueprint.spec.ts（16 个用例，05 文档第 3 节 fixture 原样落地）：classic 精确 4 行 work 映射与 8 次调用下限、participantRoleIds=4 身份、summary 交付拼接、依赖成环阻断、删复核边阻断、未用复核边仅警告不增 work、数组反转计划与 hash 不变、只复核岗不造第二研究、单人自检诚实、legacy 无 blueprint 保持可读且不补空、semanticHash 覆盖 blueprint 且忽略顺序、blueprintHash 随复核者变化、同 agentId 假独立复核阻断、reviewMode 不匹配、>6 参与者阻断、JSON round trip hash 稳定、ROLE_NOT_READY 是草稿 warning（纯编译器仍成功，仅正式 commission preview 阻断）。
- 实际命令与结果：
  - 首轮 `node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test server/modules/teams/teams-work-blueprint.spec.ts server/modules/teams/teams-graph.spec.ts` → 14 pass / 6 fail。失败根因与修复：① teamError 的 `{code, message, ...details}` 展开把 details.code 覆盖了顶层 code → compileWorkBlueprint 不再把诊断 code 塞进 details（顶层保持 TEAM_PLAN_INVALID，诊断 code 在 issues 内）；② compileTeamPlan 输出的 workKey 是最终 hash 而非别名 → 测试改用 taskKind 过滤；③ TOO_MANY_WORKS 用例经典模板已有 3 项 work，只加 1 项不足 6；④ placeholder 按规格是 draft warning，纯编译器应成功（原断言错）。
  - 修复后 → **20 pass / 0 fail / 0 skip**（duration 752.1ms，exit 0）。
  - `npm run type:check` → server 与 client 均 exit 0。
- 决策记录：blueprint Zod schema 放 team-graph.ts（避免编译器↔graph 循环 import）；client team-graph.ts 本轮不改（duplicate/delete 经 config 展开天然保留 workBlueprint，整队重映射属 T06；删除被 blueprint 引用岗位→草稿可存、预览报 UNKNOWN_ROLE，UI 警告在 T11）；team-contract.ts 全局 COMPILER_VERSION 升级（'team-plan-v3-work-blueprint'）随 T05 work-plan-preview 一起。
- 兼容性：无数据库迁移（JSONB 仅加可选字段）；旧配置缺字段保持旧语义与旧 hash 兼容；已落库 commission 不重算 workKey。

下一任务：**T05 结构预览/正式委托/自动运行共用编译器**（新增 team-work-plan-preview.service.ts；改 teams.controller.ts、teams.module.ts、team-commission.service.ts、team-run.rules.ts、team-run.service.ts、team-contract.ts；新增 teams-work-blueprint.integration.spec.ts；扩展 team-run.integration.spec.ts）。

### T05 结构预览/正式委托/自动运行共用编译器 ✅ 完成

证据（2026-11-15 01:25–01:40 本地时间，HEAD e011208 + 本任务未提交改动，分支 codex/team-organization-redesign；测试库 `squabble-team-redesign-pg` @ 127.0.0.1:55479，库 `squabble_team_redesign_test`，仅导入 01_schema.sql 不导 demo seed）：

- 改动文件：
  - shared/team-workspace.interface.ts：新增 `BlueprintCommissionPreviewInput`（planMode:'blueprint'、objective、dataCutoffAt、deadlineAt、inputRefs、budget、可选 summaryRequirement）、`TeamWorkPlanPreviewInput`（requestKey/expectedSemanticRevision/config）、`TeamWorkPlanPreviewResult`（mode blueprint_v1|legacy_v1、baseSemanticRevision、semanticHash、blueprintHash、compilerVersion、structurallyValid、dispatchable:false、leadRoleId、participantRoleIds、work、minimumCallCount、nonParticipatingRoleIds、unusedReviewRelationIds、issues、warnings、requestKey）。
  - server/modules/teams/team-contract.ts：`COMPILER_VERSION` 升级为 `'team-plan-v3-work-blueprint'`（TeamStore.consume 的编译版本比对随预览/协议一同升级）。
  - server/modules/teams/team-work-blueprint.ts：`WARNING_CODES` 改为导出（ROLE_NOT_READY/REVIEW_RELATION_UNUSED）。
  - 新增 server/modules/teams/team-work-plan-preview.service.ts：POST /api/teams/:id/work-plan-preview 结构预览；校验 owner（TEAM_NOT_FOUND）、草稿存在（TEAM_REFERENCE_NOT_FOUND）、草稿语义修订（TEAM_REVISION_CONFLICT）；legacy_v1（无 blueprint → BLUEPRINT_MISSING 警告、participantRoleIds=启用岗位、work:[]）；blueprint_v1（diagnose → warnings/blocking，blocking 空时用同一纯编译器 compileWorkBlueprint 生成 work/minimumCallCount/blueprintHash）；零写入 team_requests/team_previews/commissions/jobs、无可消费 previewId、不调用模型。
  - server/modules/teams/teams.controller.ts / teams.module.ts：注册 `TeamWorkPlanPreviewService` 与路由（@HttpCode(200)）。
  - server/modules/teams/team-commission.service.ts：preview 请求改 discriminated union（blueprint 分支严格拒绝 work/leadRoleId/proof 混入）；`buildBlueprintPlan` 从精确 teamVersionId 读已发布 config → compileWorkBlueprint → 校验参与岗 enabled+executor+交付（TEAM_PLAN_INVALID）→ callLimit≥minimumCallCount（否则 TEAM_BUDGET_BLOCKED，details 带 required/allowed）→ 构建 rawPlan 含 `workPlanProof{mode:'blueprint_v1',compilerVersion, semanticHash, blueprintHash}`；legacy 分支补 `workPlanProof{mode:'manual_custom'|'legacy_run_v1', ...}`；其余冻结/权限/预算/来源路径复用。
  - server/modules/team-runs/team-run.rules.ts：导出 `EXECUTION_STRATEGY_REQUIREMENT` 常量（legacy summary 交付句复用）；compileRunCommission 在 config.workBlueprint 存在时返回 blueprint 请求分支，否则维持原固定规则。
  - server/modules/team-runs/team-run.service.ts / team-run.scheduler.ts：自动运行 preview 调用传 `{proofMode:'legacy_run_v1'}`；run 服务把 commission 返回的 workPlanProof 合入 TeamRunConfiguration（协议确认/修订持久化）。
- 新增 server/modules/teams/teams-work-blueprint.integration.spec.ts（真实 PG，7 个用例）：①结构预览零写入（requests/previews/commissions/jobs/council tasks 计数不变；4 行 work 精确断言；minimumCallCount 8；换 key 重放一致仍零写入）；②stranger→TEAM_NOT_FOUND、revision+1→TEAM_REVISION_CONFLICT；③正式 blueprint preview proof.mode=blueprint_v1、role 顺序 F/B/C/L、create 后落库 work keys 与冻结预览一致；④callLimit 4 → TEAM_BUDGET_BLOCKED required 8/allowed 4；⑤financials 占位（placeholder/executor null）可发布但正式 preview 阻断（TEAM_PLAN_INVALID），结构预览仍 4 work 且 ROLE_NOT_READY 警告；⑥legacy 结构预览 legacy_v1+BLUEPRINT_MISSING、手动 commission proof mode=manual_custom/blueprintHash null；⑦自动运行 proof：legacy 单岗团队 mode=legacy_run_v1、classic+4 股友团队 mode=blueprint_v1 且 blueprintHash 64 位。
- 实际命令与结果：
  - 测试库准备：`docker run --name squabble-team-redesign-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=redesign-fixture-only -e POSTGRES_DB=squabble_team_redesign_test -p 127.0.0.1:55479:5432 -d postgres:16-alpine`（exit 0）；pg_isready 通过；`docker cp scripts/db/01_schema.sql squabble-team-redesign-pg:/tmp/team-redesign-schema.sql` + `psql -v ON_ERROR_STOP=1 -f` → 187 张 public 表。注：MSYS2 bash 会把 `/tmp/...` 转成 Windows 路径，需 `MSYS_NO_PATHCONV=1` 前缀。
  - `node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/teams/teams-work-blueprint.integration.spec.ts server/modules/team-runs/team-run.rules.spec.ts server/modules/team-runs/team-run.integration.spec.ts`（TEAM_TEST_DATABASE_URL 等 15 个测试 URL 指向 55479）→ **19 pass / 0 fail / 0 skip**（duration 66482ms，exit 0）。
  - `npm run type:check` → server 与 client 均 exit 0。
- 调试教训：仓库 tsconfig.node.json `strict:false` 下 zod 4 `.nullable()` 推断键为 Optional，赋必填接口字段触发 TS2345 → union 真分支加 `as BlueprintCommissionPreviewInput`（运行时 union 保证键存在或为 null）；spec 文件被 tsconfig.node.json 排除，type:check 不覆盖 spec（T14 用临时 tsconfig 校验）。
- 兼容性：旧 team version/旧 run 协议 JSONB 不加列；无 blueprint 配置读取保持 legacy 语义；已落库 commission 不重算 workKey；发布新版本触发既有 authority-change 重确认路径（team-run.integration 既有用例覆盖）。

下一任务：**T06 完整模板实例化与 UUID 映射**（新增 client/src/features/teams/team-template-instantiation.ts + 测试；改 shared/team-templates.ts 到 11 模板 + team-quick-start.ts 实例化入口）。

### T06 完整模板实例化与 UUID 映射 ✅ 完成

证据（2026-11-15 01:33–01:47 本地时间，HEAD e011208 + 本任务未提交改动，分支 codex/team-organization-redesign）：

- 改动文件：
  - 新增 shared/team-template-instantiation.ts：纯函数 `instantiateOrganization(config, display, layout, {staffing?, generate?})` 一次生成 departments∪roles∪relations 全节点新 UUID 并重映射 config（部门父/岗位部门/关系端点/defaults.leadRoleId/sourceGrantIds 清空/workBlueprint 的 roleId+reviewerRoleId）与 display/layout 字典键（未知键丢弃）；`instantiateTemplate(template, generate?)` 同一入口；workId/dependencyWorkIds 保留为实例内稳定任务键。
  - 新增 client/src/features/teams/team-template-instantiation.ts：re-export 共享实现（服务端 create 与客户端流程同一重映射）。
  - shared/team-templates.ts：TeamTemplate 增加可选 `templateVersion?: 2`、`staffing?: TeamTemplateStaffingSlot[]`；新增 `TeamTemplateStaffingSlot{roleId; recommendedTemplateId: AgentTemplateId; required: boolean}`（旧 10 模板不填也合法）。
  - server/modules/teams/teams.service.ts：删除本地 copyConfig，create 的 copyFrom/template 两条路径改用共享 instantiateOrganization/instantiateTemplate。
- 测试（红测先行）：新增 client/src/utils/team-template-instantiation.test.cjs 3 用例（纯函数不变性+全引用重映射+workId 任务键保留+staffing 重映射；两次实例化无共享 UUID；10 个真实模板实例化无悬挂引用）。红测：模块未创建 → ENOENT。绿测：`node --test client/src/utils/team-template-instantiation.test.cjs` → **3 pass / 0 fail**（exit 0）。
- 回归：`node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test shared/team-templates.spec.ts` → 2 pass；`npm run type:check` → server 与 client 均 exit 0。
- 调试教训：①simple-test-loader.cjs 的 transpileModule 未传 fileName，`.ts` 里的泛型箭头 `const f = <T>(...) => ...` 被当 JSX 解析导致导出丢失 → 改为 function 声明；②loader 顶层 `f.load('@shared/...')` 不映射别名（仅沙箱 requireModule 映射）→ 测试用相对路径 `../../shared/team-templates.ts`。
- 兼容性：无数据库迁移；旧 10 模板实例化行为与旧 copyConfig 一致（多了 blueprint/staffing 重映射能力）；team-quick-start.ts 不改（templateId 已走服务端统一 create=共享实例化入口，无第二套实例化）。

### T07 11 种组织模板落内容与实际拓扑 ✅ 完成

证据（2026-11-15 01:42–01:49 本地时间，分支 codex/team-organization-redesign）：

- 改动文件：
  - shared/team-templates.ts：重写为 11 个模板（原 10 个稳定 ID + 新增 `classic`），统一 `buildTemplate(index, id, category, zh, en, description, enDesc, depts, seats, relations, works, summaryReviewer, sources)` 显式构造。每个模板有独立部门/岗位/汇报线/委托线/复核线、`templateVersion: 2`、每岗一条 `staffing`（recommendedTemplateId 取 12 专业目录 ID）和 `config.workBlueprint`（1–5 项 work，workId 为实例内稳定任务键，依赖按 workId 引用，复核者显式，summary 复核者显式）。classic 按 04：4 岗（投资负责人/基本面研究员/财报专家/反方研究员）、2 部门（投资研究部/风险检查部）、财报专家双线汇报、反方研究员独立复核、最低授权额度 8 次调用；其余 10 个模板保留原名称/描述/论文来源/分类，拓扑按 04 表逐项落实（多空投委会 6 岗 12 次、判断复盘 6 岗 12 次、多视角组合 5 岗 10 次、细粒度尽调 6 岗 12 次、竞争假设 5 岗 10 次、矩阵专家 5 岗 10 次、4 个趣味模板 5–6 岗 10–12 次）。
  - shared/team-templates.spec.ts：断言 11 个模板、原 10 个稳定 ID 保留、templateVersion===2、staffing 每岗一条且专业 ID 属于 12 项目录、blueprint 1–5 项 work/workId 唯一/依赖可解析/角色与复核者存在于 config、professional 非 classic 必须带 arxiv 论文来源；保留 matrix 多汇报线与 4 个 playful 模板的实质复核断言。
  - 新增 server/modules/teams/teams-templates-blueprint.spec.ts：对 11 个模板逐个 `instantiateTemplate` → `validateTeamGraph` → 生产 `compileWorkBlueprint` 编译，断言 minimumCallCount 与 04 表一致（经典 8、6 岗模板 12、5 岗模板 10）、participantRoleIds 恰为执行∪复核∪负责人、blueprintHash 为 64 位十六进制、实例不残留模板局部 UUID；classic 专项断言 4 行 work（financials/business/challenge/summary）的依赖与复核者精确值。
- 测试：`node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test shared/team-templates.spec.ts server/modules/teams/teams-templates-blueprint.spec.ts` → **4 pass / 0 fail / 0 skip**（662ms，exit 0）。
- `npm run type:check` → server 与 client 均 exit 0。
- 兼容性：TeamTemplate 的 templateVersion/staffing 变为必填字段，唯一构造点是 shared/team-templates.ts；TeamsService/TeamsPage/quick-start 只读消费，无数据库迁移；48 小时内旧客户端拿到的模板目录仍含原 10 个稳定 ID（新增 classic 属于追加）。

### T08 确定性初始布局与自动布局 ✅ 完成

证据（2026-11-15 01:51–01:57 本地时间，分支 codex/team-organization-redesign）：

- 改动文件：
  - 新增 client/src/features/teams/team-auto-layout.ts：`LAYOUT_METRICS`（岗位卡 216×128、部门 padding 24/标题 48、节点 gap 24、根层 gap 40、折叠部门 280×72、空部门 ≥280×180、内容起点 x=24/y=72）；`autoLayout(config, layout)` 全量确定性重排（只改 positions，保留 viewport/collapsedDepartmentIds；部门自底向上量外壳、根层负责人 (24,24)、其余根层岗 40px 下每行最多 2、部门内相对坐标起点 (24,72) 每行最多 2、嵌套部门保持归属、折叠部门保留子节点已算位置、确定性=同输入同输出）；`ensureVisiblePositions(config, layout)` 只读回退（已有位置原样保留，缺失节点按同网格在所属容器现有包围盒后追加，不写服务器）。两个函数均不改 config。
  - 新增 client/src/utils/team-auto-layout.test.cjs 7 用例（确定性+viewport/collapsed 保留；根层 lead (24,24)+根层部门不重叠+最小尺寸；部门内岗位不越界不重叠；部门负责人优先第一行；嵌套部门在父内且独立内容坐标；空部门 280×180/折叠 280×72；ensureVisiblePositions 保留存量坐标+只追加缺失+两次幂等稳定）。红测：模块未创建 ENOENT。绿测：7 pass / 0 fail。
  - team-flow-adapter.ts / client team-graph.ts 本轮无需改动（adapter 已按 layout.positions 渲染，缺失位置回退与自动布局按钮接入画布 UI 属 T10/T11）。
- 回归：`node --test client/src/utils/team-auto-layout.test.cjs client/src/utils/team-editor.test.cjs client/src/utils/team-draft.test.cjs` → **22 pass / 0 fail**（6735ms，exit 0）；`npm run type:check` → server 与 client 均 exit 0。
- 调试教训：画布 position 存储约定是“相对语义父容器”（见 team-graph.ts absolutePosition 注释），autoLayout 的部门内岗位坐标必须存相对值，否则嵌套部门下绝对坐标错位（首次实现存了绝对坐标导致 2 个用例失败，改为相对 (24,72) 起点后全绿）。

下一任务：**T09 统一新建入口与旧引导恢复**（新增 TeamCreateDialog.tsx；改 TeamsPage.tsx、TeamsEntryPage.tsx、GuidedTeamCreate.tsx、guided-team-storage.ts、guided-team-create.ts；新增 client/src/utils/team-organization-create.test.cjs；三类恢复用例都不重复造团队；?guided=1 有旧进度显示“继续原创建”；账户 key 规则沿用 guided-request-keys）。

### T09 统一新建入口与旧引导恢复 ✅ 完成

证据（2026-11-15 02:02–02:12 本地时间，分支 codex/team-organization-redesign）：

- 改动文件：
  - 新增 client/src/features/teams/team-create-intent.ts（纯函数）：`TEAM_CREATE_KEY_PATTERN=/^[a-zA-Z0-9_-]{8,128}$/`、`teamCreateDigest(input)`（对象 key 排序稳定 JSON）、`nextTeamCreateIntent(input, previous, outcome)`（confirmed→null；pending 同 digest→复用原 key；pending 改 digest→新 crypto.randomUUID()）。未确认前重试同一 requestKey 与 payload，网络失败不会创建第二个团队。
  - 新增 client/src/utils/team-organization-create.test.cjs 5 用例（pending 重试同 key/改表单新 key/confirmed 清 intent 后全新 key/key 严格落在账户友好的字母表/同 digest 复用不同 digest 新 key）。红测 ENOENT → 绿 5 pass / 0 fail。
  - 新增 client/src/features/teams/TeamCreateDialog.tsx：统一模板选择器（mode 默认 template，空白组织/复制现有配置并列；11 模板卡显示名称/分类/岗位·部门数/缺专业股友数（由 ownedSpecialtyIds(roster.items) 与模板 staffing 求差）/描述/论文来源链接；名称/说明/头像字段；复制模式从已发布版本选择）；创建 mutation 用 nextTeamCreateIntent 复用未确认 key → teamsApi.create；成功清 intent 与 sessionStorage 草稿 → onCreated(id) → 导航 `/teams/:id?panel=organization`；只保存草稿，不发布/不关联账户/不启动/不调模型；表单写入 sessionStorage 'squabble.team-create' 供恢复。
  - 改 client/src/pages/Teams/TeamsPage.tsx：顶部“新建团队”与空态按钮从 `navigate('/teams?guided=1')` 改为打开 TeamCreateDialog（保留 advanced=1&create=1 初始 creating）；删除旧内联 Dialog 的快速开始/seed/连接/ack 死代码；useTeamQuickStart 仅保留为旧快速开始恢复横幅与 QuickStartPanel 弹窗；复制团队按钮打开复制模式并预填名称“副本”。
  - 改 client/src/pages/Teams/TeamsEntryPage.tsx：`?guided=1` 且有 hasLegacyGuidedProgress() → 仍走 GuidedTeamCreate（旧引导/旧进度恢复）；无旧进度 → `<Navigate to="/teams?advanced=1&create=1" replace />` 打开统一模板弹窗。
- 测试：`node --test client/src/utils/team-organization-create.test.cjs client/src/utils/guided-team-resume.test.cjs client/src/utils/guided-request-keys.test.cjs client/src/utils/team-quick-start-flow.test.cjs` → **43 pass / 0 fail**（exit 0）。
- `npm run type:check` → server 与 client 均 exit 0。
- 兼容性：sessionStorage 恢复键不变（'squabble.team-create'）；旧 3 步引导未删（GuidedTeamCreate 原样保留作旧进度恢复）；账户 key 规则沿用 guided-request-keys.ts 的 `--` 拼接（账户接口只接受 ^[a-zA-Z0-9_-]{8,128}$，team 创建 key 用 UUID 天然合规）。

下一任务：**T10 截图式三栏画布与工具栏**（新增 TeamEditorSidebar.tsx/TeamEditorToolbar.tsx；改 TeamWorkspacePage.tsx、TeamCanvas.tsx、TeamOutline.tsx、teams.css；新增 client/src/utils/team-organization-ui.test.cjs；“配置团队”URL 固定 ?panel=organization、运行概览保留 ?panel=overview；左栏 我的股友/添加岗位部门/模板/组织目录，中间 ReactFlow，右栏属性；宽度断点按 01；工具栏 mode select|reports_to|collaboration 连线后明确选委托/复核类型）。

## T10 截图式三栏画布与工具栏（完成 2026-11-15 02:02）

- 新增 client/src/features/teams/TeamEditorToolbar.tsx：`type CanvasMode='select'|'relation'`、`type RelationKind=TeamRelation['kind']`；`TeamEditorToolbar({mode,kind,setMode,setKind,view,setView,canUndo,canRedo,readOnly,zh,onUndo,onRedo,onAutoLayout,onFit,onZoomIn,onZoomOut,fitting})`——[选择][汇报线][协作线]+协作时[委托][复核]、[自动布局][适应画布][缩小][放大][撤销][重做][列表视图][画布视图]，aria 标注齐全。
- 新增 client/src/features/teams/TeamEditorSidebar.tsx：`.team-editor-sidebar` 四节——添加到画布（岗位/部门）、我的股友（搜索+可拖拽 dataTransfer 'application/x-squabble-agent'）、团队模板（11 模板卡+替换影响预览+确认应用）、组织目录（TeamOutline）。
- TeamCanvas.tsx：新增 `export interface CanvasControls{fit;zoomIn;zoomOut}` 与 `registerControls` prop（fitView/zoomIn/zoomOut 暴露给工具栏）。
- TeamWorkspacePage.tsx：organization 面板改 `.team-editor-three` 三栏（侧栏 144px | 主区 | 属性 264px，≥1440 时 176/300，≤959 单列）；工具栏由 TeamEditorToolbar 渲染；连线默认按工具栏模式（canvasMode==='relation' 用 relationKind）；自动布局按钮 edit({...state,layout:autoLayout(...)})+notify（只改布局可撤销）；header 增加“保存草稿”“发布团队版本”按钮（panel!=='overview' 时，禁用条件含 readOnly/offline/save pending/conflict/recovery）；面板文案：运行概览 / 配置团队。
- client/src/features/teams/team-template-instantiation.ts：新增纯函数 `draftWithTemplate(state,template,generate?)`（保留 display.name/avatar，整体替换 config/标签/布局），TeamEditorSidebar 模板应用改用之。
- teams.css：新增 .team-editor-three 三栏网格、.team-editor-sidebar/.team-sidebar-section/.team-sidebar-friends/.team-toolbar-modes/.team-toolbar-kinds 及 1440/1150/959/760 媒体查询（960 以下隐藏侧栏单列，760 单列画布 510px）。
- 测试：`node --test client/src/utils/team-organization-ui.test.cjs` → **3 pass / 0 fail**（draftWithTemplate 保留名称头像/引用一致无悬挂/纯函数确定性/连续应用可回退）；回归 `node --test client/src/utils/team-auto-layout.test.cjs team-graph.test.cjs team-editor.test.cjs team-organization-ui.test.cjs` → **20 pass / 0 fail / exit 0**；`npm run type:check` → server 与 client 均 exit 0。
- 兼容性：?panel=organization 直达三栏画布、?panel=overview 运行概览（TeamCard 入口 T09 已改）；旧 organization/relations 共用 toolbar 移除；Save/发布迁到 header；快开始/引导/版本/来源/运行面板不受影响。
- 视觉核对与 1440/1280/1024/390 宽度截图在 T13 浏览器探针统一执行。

下一任务：**T11 岗位属性/分工编辑/发布检查**（TeamWorkPlanPreview.tsx + TeamInspector 改造 + TeamPublicationChanges.tsx 发布 diff 含 blueprint + api/teams.ts work-plan-preview + team-work-blueprint.test.cjs；右栏分岗位职责与股友全局能力；“预览研究分工”携当前本地 config 请求结构预览不强制先保存，响应匹配语义修订/hash，过期响应不覆盖新输入）。

## T11 岗位属性 / 分工编辑 / 发布检查（2026-11-15 02:01–02:14）

- 新增 `client/src/features/teams/team-work-blueprint.ts`（纯函数，无 React）：`workBlueprintOf`；`withBlueprintWork`（workId upsert、上限 5）；`removeBlueprintWork`（summary 不可删、剔除兄弟依赖）；`patchBlueprintWork` / `patchBlueprintSummary`；`blueprintStructuralIssues`（镜像服务端诊断子集，上限 24：BLUEPRINT_MISSING/INVALID_WORK_ID/RESERVED_WORK_ID/DUPLICATE_WORK_ID/UNKNOWN_ROLE/LEAD_WORK_NOT_ALLOWED/UNKNOWN_REVIEWER/DUPLICATE_WORK_ROLE/TOO_MANY_WORKS/SELF_DEPENDENCY/UNKNOWN_DEPENDENCY/WORK_CYCLE/REVIEW_MODE_MISMATCH/REVIEW_RELATION_REQUIRED/INDEPENDENT_REVIEW_SAME_FRIEND/TOO_MANY_PARTICIPANTS）；`blueprintDiff`（added/removed/changed 字段 + summary 变化）；`suggestBlueprintFromOrganization`（旧团队显式建立标准分工，workId slug 以 ^[a-z] 开头，taskKind 依工具范围推导，summary 默认负责人自检）。
- 新增 `client/src/utils/team-work-blueprint.test.cjs`：7 用例（读取/缺失、upsert 封顶、删依赖、结构诊断 8 类、参与者超限、diff 增删改+summary、旧组织建议唯一性与正则）→ 7 pass。
- `client/src/api/teams.ts`：新增 `workPlanPreview(id,{requestKey,expectedSemanticRevision,config})` → `TeamWorkPlanPreviewResult`（POST /api/teams/:id/work-plan-preview）。
- 新增 `client/src/features/teams/TeamWorkPlanPreview.tsx` + `team-workplan.css`：organization 面板画布下方可折叠“预览研究分工（结构）”。可编辑每项工作的执行岗位/类型/目标/交付/依赖（复选框）/复核岗位/复核方式（独立|自检），负责人汇总不可删除、改复核岗位为负责人时自动切自检；无蓝图时提供“根据当前组织建立标准研究分工”。请求携当前本地 config 与草稿语义修订，`seq` 防慢响应覆盖，签名变化提示“预览已过期”；结果展示 mode/structurallyValid/最低授权调用额度/work 表/服务端 issues/warnings/未参与岗位/未采用复核线；明确“不保存、不调用模型、不启动研究”。
- `client/src/features/teams/TeamPublicationChanges.tsx`：`teamPublicationDiff` 增加工作蓝图块（每项 work 的执行岗位/类型/目标/交付/依赖/复核/方式，及负责人汇总的复核岗位/方式/交付要求），发布预览可见分工变化（AC28）。
- `client/src/pages/Teams/TeamWorkspacePage.tsx`：organization 面板 `.team-editor-main` 内接入 `TeamWorkPlanPreview`（outline 列表视图隐藏）。
- 测试：`node --test client/src/utils/team-work-blueprint.test.cjs team-organization-ui.test.cjs team-auto-layout.test.cjs team-graph.test.cjs team-editor.test.cjs` → **27 pass / 0 fail / 818ms / exit 0**；`npm run type:check` → server 与 client 均 exit 0。
- 覆盖说明：AC28 发布 diff 含 blueprint；AC31 未保存草稿可预览（expectedSemanticRevision 校验）；AC33 多余复核边在服务端预览标“本次未采用”；AC36 独立复核/自检在预览与诊断中区分；AC37 最低授权调用额度随草稿显示。服务端结构预览与实际执行的同一性证据留 T13（浏览器 fixture 探针 + 执行集成测试）。
- 下一任务：**T12 旧团队与运行协议兼容整改**（team-run.service.ts / TeamRunPanel / 版本复制恢复路径；扩展 teams-publication/teams-upgrade/team-run 集成测试；无 blueprint 旧发布版本显示“旧版分工”）。

## T05 服务端编译证明集成验证（2026-11-15 02:05–02:10，真实 PG）

测试专用 PostgreSQL 已就绪：容器 `squabble-team-redesign-pg`（postgres:16-alpine，127.0.0.1:55479，库 squabble_team_redesign_test，01_schema.sql 已导入，187 张表；不导 demo seed）。`TEAM_TEST_DATABASE_URL=postgres://postgres:redesign-fixture-only@127.0.0.1:55479/squabble_team_redesign_test`。
- `node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/teams/teams-work-blueprint.integration.spec.ts` → **8 pass / 0 fail**（结构预览零写入且重放一致、owner/修订边界、正式蓝图 preview 冻结 proof、预算缺口 required 8/allowed 4、占位岗正式阻断但结构可预览+ROLE_NOT_READY、legacy 保持 manual_custom proof、自动运行 legacy_run_v1 与 blueprint_v1 proof、发布蓝图新版本后旧协议需重确认）。
- `node ... server/modules/team-runs/team-run.integration.spec.ts` → **8 pass / 0 fail**（既有自动运行全套行为在新 proof 管线下无回归）。
- `node ... server/modules/team-runs/team-run.rules.spec.ts` → 4 pass；`teams-publication.integration.spec.ts` + `teams-upgrade.integration.spec.ts` → 2 pass（fresh/upgrade/replay、legacy 账本保留）。

## T12 旧团队与运行协议兼容整改（2026-11-15 02:14–02:22）

- `client/src/features/teams/TeamRunPanel.tsx`：运行概览增加“研究分工”卡片——`agreement.configuration.workPlanProof.mode` 显示“工作蓝图 v1 · 已发布组织分工 / 仅本次自定义分工 / 旧版分工：独立研究 + 负责人汇总”，并注明“协议固定此分工；发布新团队版本后需重新确认运行规则”。
- `server/modules/teams/teams-work-blueprint.integration.spec.ts` 新增用例：legacy 自动协议（legacy_run_v1 proof）→ 发布含 classic 蓝图的新版本 → 旧协议 `control('start')` 拒绝（TEAM_REAPPROVAL_REQUIRED）→ 新 preview 携带 blueprint_v1 proof + 64 位 blueprintHash；旧发布版本与新版本并存且旧存储计划不被重编译（AC41）。
- 验证：`teams-work-blueprint.integration.spec.ts` → **8 pass / 0 fail**；`team-run.integration.spec.ts` → 8 pass；type:check server/client exit 0。
- 说明：旧协议/queued/uncertain 任务沿保存的 plan/member/inputSnapshot/receipt 恢复（既有 team-run.integration 'unknown commission survives restart' 用例通过）；无 blueprint 旧发布版本的结构预览显示 legacy_v1 + BLUEPRINT_MISSING（T11 TeamWorkPlanPreview legacy 说明 + “根据当前组织建立标准研究分工”入口）；版本复制恢复路径沿用 restoreTeamVersion（整体替换 config，不注入空白蓝图）。
- 下一任务：**T13 完整浏览器与执行一致性证明**（新增 scripts/ui-probe/team-organization-browser.cjs；扩展 fixture 到 12 专业模板；1440×1080/1440×900/1366×768/390×844 中英浅深截图；执行一致性 teams-work-blueprint.execution.integration.spec.ts：虚构 provider 按脚本交付/拒绝/超时，真实成员/复核/依赖与 preview 一致）。

## T13 完整浏览器与执行一致性证明（2026-11-15 02:22–02:32）

### 浏览器 fixture 与探针
- `scripts/ui-probe/agent-templates.json` 已从 shared/agent-specialty-catalog 重新生成 12 条（financials,valuation,bear,risk,moderator,business,industry,growth,macro,events,quantitative,portfolio；含中英 name/specialty/description/delivery/instructions/avatar/allowedToolIds）。
- `scripts/ui-probe/fixture-server.cjs` 扩展：虚构 classic 团队 `aaaaaa00-0000-4000-8000-000000000001`（4 岗 lead/financials/business/bear、2 部门、11 关系、3 work blueprint + summary 复核 bear、roleLabels 中文）；新增路由 GET /api/teams、GET /api/teams/:id、PUT/PATCH /api/teams/:id/(draft|display|layout)、POST /api/teams/:id/work-plan-preview（伪造 blueprint_v1 4 works / minimumCallCount 8 / structurallyValid true）、POST publish-preview/publish、GET source-grants/decisions/commissions/versions → 空、GET /api/team-runs/:id → 无协议；405 守卫放行团队编辑类非 GET。只访问本地 fixture，无真实上游、不触个人实例。
- `npm run build:client` → exit 0（4.43s）。
- 新增 `scripts/ui-probe/team-organization-browser.cjs`：7 视口（1440×1080 浅色、1440×1080 深色 emulateMedia、1440×900、1366×768、1280×800、1024×768、390×844）打开 `?panel=organization`，断言：无横向溢出（scrollWidth≤innerWidth+1）；≥960 三栏（sidebar+inspector+toolbar+canvas 节点≥3）；<960 移动端为列表/组织目录形态（不要求 sidebar/inspector/canvas）；保存草稿与发布团队版本入口存在（中英文文案均接受）；工具栏含 选择/汇报线/协作线。截图与报告写入 docs/team-organization-redesign/evidence/team-org-<label>.png / team-organization-browser.json。
- 首轮失败与修复（证据链）：①“保存草稿”写死中文文本未命中（fixture 默认英文 UI，按钮为 'Save draft'）→ 探针接受 /保存草稿|Save draft/；②390×844 下 sidebar/inspector 隐藏与 canvas 0 节点属 <960 响应式列表优先设计 → 断言按宽度分支；③探针放 /tmp 时 require('playwright') 按脚本目录解析失败 → 必须放仓库内 scripts/ui-probe/。
- 最终运行 `node scripts/ui-probe/team-organization-browser.cjs` → **7/7 视口无 problems，exit 0**。

### 执行一致性（真实 PG + 虚构 provider）
- 新增 `server/modules/teams/teams-work-blueprint.execution.integration.spec.ts`：blueprint commission preview（objective 'Fictional portfolio review'、cost_and_calls ceiling '8' callLimit 8）→ create → TeamCommissionWorker prepare+start → CouncilWorkflowStore.initialize 铺任务。
- 关键事实（供后续维护者）：compileTeamPlan 把蓝图别名 workKey 重算为 64 位 canonicalHash，councilResearchTasks.workKey/dependencyWorkKeys 是 hash 而非 'financials' 等别名；deps 比较前须 sort；memberId = roleId.replaceAll('-','')；fixture runtime 不自动置 session running，须显式 update councilSessions.status='running'。
- 2 个测试全绿：①prepared council tasks carry the exact compiled member, reviewer and dependency identity（financials→member fin/reviewer bear；business→bus/reviewer lead 依赖 financials；challenge→bear/reviewer lead 依赖 business+financials；summary→lead/reviewer bear 依赖全部；tasks.workKey 序列 === previewPlan.workKey 序列；commission.plan.workPlanProof.mode 'blueprint_v1' 且 blueprintHash 与 preview 相同）→ 结构预览/正式 preview/冻结 commission/Council 任务全程一致（AC34/AC42）；②a friend can independently review a deliverable before executing their own dependent work（bear 复核 financials 的同时自己执行 challenge，非自审、依赖链正确、challenge reviewer 为 lead）→ AC43。
- 运行：`TEAM_TEST_DATABASE_URL=… node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/teams/teams-work-blueprint.execution.integration.spec.ts` → **2 pass / 0 fail / 0 skip（约 8.1s）**。
- 说明：截图通过≠执行一致性、backend 测试通过≠截图布局验收——本任务两者都提供（截图 7 视口 + 真库执行任务断言），且均只用虚构 fixture。

下一任务：**T14 完整门禁/文档更新/交接**（lint/type:check、test:context/check:context、test:architecture、test:server（15 个测试 URL 指向专用 PG）、test:client、build:web；新 spec 类型检查；docs/architecture.md、docs/README.md、独立股友文档更新；T14 验收记录与最终反馈）。


## T14 完整门禁 / 文档更新 / 交接（2026-11-15 02:58–04:25）

### 文档更新
- `docs/architecture.md`：新增 “## 6. Team organization, work blueprints and preview compilation”——组织画布三栏配置、工作蓝图纯编译器（plan modes blueprint_v1 / manual_custom / legacy_run_v1）、结构预览（TeamWorkPlanPreviewService 只读零写入）与正式 commission preview 冻结的分层、workPlanProof 随协议/修订持久化与 TEAM_REAPPROVAL_REQUIRED、11 模板与 instantiation UUID 重映射、旧配置无蓝图保持 legacy 语义。
- `docs/README.md`：“Team workspace · 团队模拟盘”新增 team-organization-redesign 交接入口条目（含进度/验收链接）。
- `docs/independent-agents.md` / `docs/independent-agents.zh-CN.md`：12 专业目录、统一模板选择器三步入口（模板 → 画布配置与预览研究分工 → 发布/账户/运行分离）、?guided=1 旧引导续接、无蓝图团队保持 legacy 分工。

### 门禁结果（全部在分支 codex/team-organization-redesign 工作树执行）
- `npm run lint`（eslint + type:check:server/client + stylelint）→ **exit 0**（修复：team-workplan.css 单行声明与 teams.css 新增块展开为仓库风格，28 个 stylelint “maximum 1 declaration” 错误清零）。
- `npm run test:context` → **15 pass / 0 fail**；`npm run check:context` → exit 0（freshness review-required 提示为既有警告）。
- `npm run test:architecture` → **10 pass / 0 fail**。
- 新 spec 类型检查：临时 `tsconfig.spec-check.json`（extends tsconfig.node.json，noEmit，include 本轮新增 spec + server/shared 源码，exclude 其余 spec）→ `node node_modules/typescript/bin/tsc -p tsconfig.spec-check.json` → **exit 0**；临时文件已删除。（全量 spec 检查会命中大量既有历史类型债，仓库设计即排除 spec；仅检查本轮新增。）
- `npm run test:client` → **693 pass / 0 fail**（首轮 5 fail 修复：AgentEditorDialog/AgentRosterWorkspace 对无 guide 字段模板的解引用加守卫；workspace 推荐按钮文案与 agent-animal-identity.test.cjs:91 同步改为 'Add missing specialties'）。
- `npm run test:server`（15 个 *_TEST_DATABASE_URL 指向专用虚构库 postgres://postgres:redesign-fixture-only@127.0.0.1:55479/squabble_team_redesign_test2，01_schema.sql 187 表，不导 demo seed）→ **1476 pass / 21 fail / 6 skipped（1503 tests）**。
  - 首轮失败 1 处为本轮引入：teams-commission.integration.spec.ts 把含 workPlanProof 的冻结 plan 直接 spread 进 preview 请求，strict 请求 schema 拒绝（客户端不得发送 proof，符合 03 契约）→ 测试改为 `const {schemaVersion, workPlanProof, ...plan}=row.plan` 后通过。
  - 其余 21 fail 全部为 `server/modules/data-library/browser/*`（browser-research-session 等）Chromium 启动失败：单独运行同一 spec 复现 **10/10 BROWSER_UNAVAILABLE/BROWSER_TIMEOUT**（证据 /tmp/browser-isolation.log）；模块与本分支改动无关（git status 无 data-library 变更）；本沙箱 Windows 环境无法以 chromiumSandbox:true 启动 Chromium（CI 在 Linux runner 通过）。属环境受限，非本分支回归。
  - 附带说明：先前一次全量运行曾出现 tool-connections 瞬时失败，因复用同一测试库的残留 schema 状态；换全新库后通过（16/16 隔离运行亦通过）。
- `npm run test:wiring` → **exit 0**（"Module wiring passed: compiled providers resolve with one owner"）。
- `npm run test:memory-eval` → **exit 0**（memory-evaluation 完成）。
- `npm run test:dev` → **exit 0**（1 skipped）；`npm run test:local-agents` → **exit 0**（1 skipped）。
- `npm run build:web` → **exit 0**（build:server + build:client；仅 chunk 体积警告）。
- `npm run ui:density` → **18/18 scenarios passed**。
- 浏览器探针（build 后复跑）`node scripts/ui-probe/team-organization-browser.cjs` → **7/7 视口无 problems、exit 0**（截图/报告已更新于 docs/team-organization-redesign/evidence/）。

### 未执行/受限项
- PR 创建、合并、本地部署：无本轮授权，未执行（Git 提交仅 T01–T05 阶段门禁 commit 13775a1 已存在，后续任务改动保留在工作树供审查）。
- 21 个 browser-research 测试与整轮环境（Windows 沙箱 Chromium 启动）受限，详见上。
- 视觉细节（1440 三栏/390 单列的精确像素对照）已由探针断言与截图覆盖；最终人工视觉比对需在有可用桌面的环境复核。

### 验收对照（AC 抽样）
AC02/AC04/AC21–AC23（11 模板/classic 拓扑/实例化无悬挂）由 teams-templates-blueprint.spec + team-template-instantiation.test 覆盖；AC05/AC06/AC07/AC08 由探针 7 视口断言覆盖；AC14–AC16（12 专业/双语/完整指令）由 agent-roster.rules.spec 9 用例覆盖；AC28–AC41（蓝图 diff/结构预览零写入/legacy 兼容/proof 服务端生成/预算下限/重确认）由 teams-work-blueprint.spec + integration + execution spec 覆盖；AC42–AC44 由 execution spec 覆盖；AC46/AC47（越权拒绝/历史保留/CI 状态）由既有集成回归 + 本记录覆盖。全量测试计数与受限项见上。
