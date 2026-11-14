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
