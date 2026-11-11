# 团队模拟盘 Implementation Plan · 开发实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有首页、股友与模拟仓流程的前提下，交付团队组织画布、统一账户持仓入口，以及可追溯且有权限边界的团队研究闭环。

**Architecture:** 新增 Teams 业务模块管理组织版本、账户绑定、研究委托和关联记录；复用 Council/research-core 的研究执行、现有记忆与模拟盘执行服务。前端以 `/teams` 承载新功能，首页与资产页做局部扩展。发布配置、发起研究、应用策略保持独立事务与授权。

**Tech Stack:** 现有 React 19.2、React Router 7、TanStack Query 5、NestJS 10、Drizzle、PostgreSQL 16、TypeScript 5.9、Vite 8；拟新增 `@xyflow/react@12.12.1` 负责图形交互。

---

日期：2026-11-12。**状态：原型、详细设计与默认值已获批准，用户已授权实现、验证和通过 PR 合入主干。** 原设计基线 `b9f1febea567438afd315d6dcf8000d02a64c53e`；实际开发从更新主干 `3a561b18bacbef8557996d18977e69b1f63380e8` 开始。下列复选框保留批准时的工作分解，实际交付与验证状态统一见 [验证记录](../../team-workspace-validation.md)，不批量勾选未逐条执行的检查。

配套文档：[审核入口](../specs/2026-11-12-team-paper-review.zh-CN.md) · [产品设计 P01–P18](../specs/2026-11-12-team-paper-product-design.zh-CN.md) · [技术设计](../specs/2026-11-12-team-paper-technical-design.zh-CN.md) · [验收矩阵与命令](../specs/2026-11-12-team-paper-acceptance.zh-CN.md)。字段、API、状态枚举以技术设计为唯一契约；本计划代码块是实现边界与测试输入示例，不是已经存在的接口。

## 1. 实施顺序与阶段交付

| 阶段 | 任务 | 可评审交付 | 进入下一阶段的条件 |
|---|---|---|---|
| A：账户入口与契约 | T01–T04 | 原首页保留；实仓和模拟盘进入同一资产页面；团队领域契约、迁移与只读 API | 账户隔离、旧链接兼容、新旧库迁移和字段契约通过 |
| B：组织配置 | T05–T09 | 团队列表、新建/复制、可自由编辑的画布、矩阵关系、草稿、发布和绑定 | 任意合法组织可编辑保存；冲突不覆盖；发布不启动研究或改变交易授权 |
| C：研究闭环 | T10–T14 | 有限分工、冻结输入、手动研究、交付、固定版本判断与决策追溯 | 任务去重、unknown 恢复、记忆隔离、策略应用边界全部通过 |
| D：整体验收 | T15–T16 | 窄屏/键盘体验、现有流程回归、发布包与文档 | P0 全通过，P1 完成，实际验证记录可审阅 |

阶段可以独立提交和检查，但中间状态不得向用户展示尚不可用的“发起研究”成功入口。人员分工可以并行：T03/T04 的账户改造与 T05/T06 的组织规则开发在 T01 契约确定后独立开展；T10/T11 涉及同一 Council/记忆边界，不能由两个执行者同时无协调改写。每个阶段集成后再继续依赖它的任务。

## 2. 文件职责地图

以下“新增”是开发后的目标，不代表当前已有该文件。现有文件在本轮基线核对；执行时重新读取 AGENTS、仓库 skill 与最新提交，行号以实际源码为准。

| 文件或目录 | 动作 | 单一职责 |
|---|---|---|
| `shared/team-workspace.interface.ts` | 新增 | 对外团队、版本、关系、委托、交付关联、预览及错误契约 |
| `server/database/teams.schema.ts` | 新增 | 团队领域 Drizzle 表、索引、约束 |
| `server/database/team-context.ts` | 新增 | 中立的团队 scope/fence 数据库 helper，既有模块不反向依赖 TeamsModule |
| `server/database/schema.ts` | 修改 | 导出新增表；不维护第二份表定义 |
| `scripts/db/01_schema.sql` | 修改 | 空库初始 schema 的等价定义 |
| `scripts/db/<下一空闲序号>_team_workspace.sql` | 新增，执行时确定序号 | 存量迁移；当前已注册至 60，不预占可能被其他工作使用的 61 |
| `server/common/platform/database.provider.ts` | 修改 | 显式注册新增迁移；该仓库并非自动扫描 SQL |
| `server/modules/teams/teams.module.ts` | 新增 | Provider 组合与对外服务导出 |
| `server/modules/teams/teams.controller.ts` | 新增 | `/api/teams` 登录校验、请求解析、身份传递 |
| `server/modules/teams/team-graph.ts` | 新增 | 无副作用的图、分工、能力和状态校验 |
| `server/modules/teams/team-contract.ts` | 新增 | 请求校验、金额/时间约定和规范化 hash |
| `server/modules/teams/team-config.ts`、`.env.example` | 新增前者、修改后者 | 两个发布开关的严格解析和示例；关闭入口不关闭历史权限检查 |
| `server/modules/teams/teams.service.ts` | 新增 | 团队元信息、布局、复制、查询、账户绑定与归档生命周期 |
| `server/modules/teams/team-version.service.ts` | 新增 | 语义草稿 CAS、发布预览与不可变版本 |
| `server/modules/teams/team-commission.service.ts` | 新增 | 委托预览、固定快照、创建/取消/恢复与状态投影 |
| `server/modules/teams/team-runtime-adapter.ts` | 新增 | 将已授权分工交给现有 Council；不创建第二套模型执行器 |
| `server/modules/teams/team-decision.service.ts` | 新增 | 交付验收、判断引用、决策和现有策略入口的关联 |
| `server/modules/teams/team-source-access.service.ts` | 新增 | 团队资料授权策略；向底层传递中立 scope 契约 |
| `server/app.module.ts` | 修改 | 注册 TeamsModule |
| `shared/research-workflow.interface.ts`、`server/database/research-workflow.schema.ts` | 修改 | 支持工作项唯一标识和显式依赖，保留旧 Council 兼容 |
| `server/modules/council/council.workflow*.ts`、`council.service.ts` | 定向修改 | 读取冻结分工、执行岗位映射、历史恢复，不复制模型循环 |
| `server/modules/research-memory/research-memory.service.ts`、`server/modules/research-tools/research-tools.service.ts` | 定向修改 | 团队上下文传递、召回/按 ID 读取/工具访问隔离与撤销检查 |
| `server/modules/paper-trading/portfolio-workspace.service.ts`、`portfolio-workspace.controller.ts` | 定向修改 | 账户只读视图和团队展示关联；资金与策略变更继续走既有规则 |
| `shared/portfolio-workspace.interface.ts` | 修改 | 向统一资产视图提供明确账户类型与可空指标 |
| `client/src/api/teams.ts` | 新增 | 类型化团队 API 客户端 |
| `client/src/features/teams/` | 新增 | 组织领域适配、画布、属性表单、关系表、草稿状态、预览组件 |
| `client/src/pages/Teams/TeamsPage.tsx`、`TeamWorkspacePage.tsx` | 新增 | 列表与详情的页面组合，不放入模型执行或账户授权逻辑 |
| `client/src/features/assets/account-context.ts` | 新增 | URL 账户解析、缓存键、账户类型与安全跳转 |
| `client/src/pages/Holdings/HoldingsPage.tsx`、`client/src/pages/Transactions/TransactionsPage.tsx` | 修改 | 复用页面布局，按账户查询和操作，不在模拟盘调用实仓写接口 |
| `client/src/pages/Import/ImportPage.tsx` | 定向修改 | 直达模拟账户导入参数时显示不支持，显式选择实仓前不进入导入 |
| `client/src/features/portfolio-comparison/PortfolioComparisonPanel.tsx` | 修改 | 我的账户展示团队身份，统一持仓链接，保留曲线口径与颜色 |
| `client/src/pages/Overview/PortfolioOverviewPage.tsx`、`client/src/utils/simple-experience.ts` | 定向修改 | 首页及兼容路径的“资产与账本”硬编码文案与实仓入口；不改首页区块 |
| `client/src/features/navigation/workspace-navigation.ts`、`WorkspaceNavigationBar.tsx` | 修改 | 新导航项、标题、资产子页账户参数与回退上下文 |
| `client/src/app.tsx`、`client/src/i18n/zh-CN.json`、`en.json` | 修改 | 路由、延迟加载、中英文文案 |
| `client/src/utils/team*.test.cjs`、`server/modules/teams/*.spec.ts` | 新增 | 遵循现有测试入口；服务端 glob 必须显式登记 |
| `package.json`、`package-lock.json`、`.github/workflows/ci.yml` | 修改 | 固定图形依赖、注册测试与团队 fixture 数据库变量 |

前端新增模块进一步拆分为：`team-graph.ts`（业务图）、`team-flow-adapter.ts`（React Flow 映射）、`TeamCanvas.tsx`（手势与视图）、`TeamOutline.tsx`（列表等价操作）、`TeamInspector.tsx`（字段）、`TeamRelations.tsx`（关系表）、`use-team-draft.ts`（保存/冲突）、`TeamPublishDialog.tsx`、`TeamCommissionDialog.tsx`、`TeamWorkHistory.tsx`。如果实际代码量很小，可合并纯展示子组件；不把领域规则和网络请求放入节点渲染器。

## 3. 共同实现约束

1. **身份来自服务端。** 所有请求从当前登录上下文取 owner；客户端传 owner 无效。每个 account/team/version/source 引用独立校验；“同一个用户”不意味着两个团队可以互读私有记忆。
2. **数字不猜测。** 金额使用现有 decimal-string 约定，缺行情和无法计算的指标返回 null 及原因，不能 `Number(value || 0)`。实仓资产不包含虚拟资金。
3. **三种图分离。** 部门容纳、责任汇报、协作边分别建模；一次委托另外生成执行依赖 DAG。组织中的协作环不是调度循环。
4. **布局不改变投资配置。** 坐标/缩放使用独立 layout revision；归组、职责、汇报与工具权限改变 semantic revision。发布版本固定组织语义，历史任务固定具体 version。
5. **执行器显式选择。** 不直接拿 owner 全局 research route 自动选择每个岗位；显式 native/API 绑定不可悄悄回退到另一条付费连接。连接 busy、offline、revoked、unsupported 分别展示。
6. **危险状态不猜测。** 远端是否收到请求未知时，不自动重发、不结算为零费用、不宣布完成；恢复只复用已持久化响应或查询现有运行。
7. **低层不反向依赖 Teams。** 在共享契约传入中立 scope/snapshot；research-core、runtime、tooling 不 import Teams 业务模块实现。
8. **测试与真实环境分离。** 模型/provider、行情、持仓全部 fixture；数据库使用可丢弃 PostgreSQL。当前个人实例、真实账号、真实密钥不是测试输入。

## T01. 固定契约、错误码与测试入口

**依赖：** 用户审核通过详细文档。**需求：** P01、P07–P17。**文件：** 新增 shared 契约、team-graph、对应 spec；修改 package.json、CI 的测试变量。

- [ ] 阅读最新仓库规则并检查工作区，按 `codex/` 创建隔离分支；记录实际基线与本设计差异。只将批准范围纳入该分支。
- [ ] 将技术设计的字段、枚举、错误码、preview 与 revision 请求结构落实为 shared 类型；代码导入 shared 单一来源，禁止前后端各写一版相似 DTO。
- [ ] 用固定矩阵图建立首批失败用例：多主管通过，自汇报失败，责任环失败，协作双向通过；至少包括无数据副作用断言。
- [ ] 登记 `server/modules/teams/*.spec.ts` 到 `test:server`；前端测试放入既有 utils glob。CI 与本地同时提供 `TEAM_TEST_DATABASE_URL`，无 fixture 时不得伪称完成集成验收。
- [ ] 完成纯规则后运行聚焦测试与两端类型检查；提交契约与规则的独立变更。

```ts
// 拟新增规则测试输入；函数名在 team-graph.ts 中与技术契约一并实现。
const reporting = [
  { from: 'analyst', to: 'research-lead', scope: '财报核查' },
  { from: 'analyst', to: 'risk-lead', scope: '流动性复核' },
];
// 断言：两个上级合法；不推导两次派发；不自动选本次最终负责人。
```

**验证：** `node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/teams/teams-contract.spec.ts server/modules/teams/teams-graph.spec.ts`。首次可因缺实现失败；完成后全部通过，不能以跳过证明通过。

## T02. 表、迁移与查询模块

**需求：** P05、P11、P12、P15。**文件：** teams.schema、schema 汇总、迁移、01_schema、database.provider、teams module/controller/service、app.module。

- [ ] 依技术设计建团队、草稿、版本、有效绑定、预览、请求回执、委托/桥接作业、研究引用、决策、来源授权表；外键和唯一约束必须覆盖 owner 与业务归属。
- [ ] 先写迁移集成用例：空库、基线60升级、重复执行、并发绑定两团队到一盘；记录旧账本/现金/策略状态前后完全相同。
- [ ] 执行时枚举现有 SQL 文件和显式注册数组，选择下一未使用序号；同一提交增加升级 SQL、初始 schema、Drizzle、注册项与打包检查。不能只加 SQL 文件。
- [ ] 实现 GET/list/detail 和元信息创建；默认未绑定、未发布；创建不调用研究服务，不创建或启动模拟策略。
- [ ] 增加 TEAM_WORKSPACE_ENABLED、TEAM_RESEARCH_ENABLED 开关及只读能力响应；默认关闭。组织写入/新派发分别受控，历史查询、取消、费用结算和 team scope 校验仍保持可用；非法布尔配置明确报错，不用字符串 truthy 判断。
- [ ] 在登录条件下校验 foreign owner 的 ID 返回不泄露资源存在的信息；禁止按裸 teamId 查询后直接返回。
- [ ] 运行 schema catalog 对照、重复迁移和模块装配；提交持久化增量。

**事务边界：** 版本插入、有效绑定切换与幂等回执在数据库事务里完成。关系预检不能替代唯一索引。事务内不等待外部模型网络请求。

## T03. 统一账户上下文与资产只读适配

**需求：** P03、P04。**文件：** account-context、Holdings、Transactions、portfolio-workspace 契约/服务/客户端；对应 utils 测试。

- [ ] 写 ACC-03 晚响应测试和 ACC-05 无效 ID 测试；采用真实 QueryClient 的隔离缓存，不能只测试字符串拼接。
- [ ] 实现 URL 解析：旧 `/holdings` 默认实仓；`accountId=real` 表示实仓；非空其他值必须请求对应账户；无效值显示错误，不回退。
- [ ] 以账户 ID、市场过滤、计价币等为 query key；切换时旧数据离开可操作区域，响应不能进入另一账户缓存。
- [ ] 将既有实仓视图与模拟盘 investment.holdings 分别适配到统一展示；原模拟盘没有现价/浮盈字段时补充真实行情只读来源或明确 null，不能假装已有。
- [ ] 实仓保留录入、编辑、导入；模拟盘显示既有可用的持仓/现金/交易信息及团队研究入口，所有写操作继续走正确的模拟盘业务 API。
- [ ] 资产子页链接继承账户；关注列表明确全局范围并保存返回上下文；模拟盘不出现实仓导入按钮。`/import?accountId=<模拟盘>` 直达显示不支持，只有用户明确改选实仓才进入原导入流程，不忽略参数后默认为实仓。测试刷新、前进后退和失败重试。

```ts
// 拟新增纯 URL 规则示例；网络权限判断仍在服务端。
type AssetAccount = { kind: 'real'; id: 'real' } | { kind: 'paper'; id: string };
function readAssetAccount(search: string): AssetAccount {
  const value = new URLSearchParams(search).get('accountId');
  if (value === null || value === 'real') return { kind: 'real', id: 'real' };
  if (!value.trim()) throw new Error('INVALID_ACCOUNT_CONTEXT');
  return { kind: 'paper', id: value };
}
function holdingsHref(id: string): string {
  return `/holdings?${new URLSearchParams({ accountId: id })}`;
}
```

**验证：** `node --test client/src/utils/team-account-selection.test.cjs`；ACC-01–06；现有 portfolio-workspace 与比较测试回归。

## T04. 首页与导航的最小改动

**需求：** P01、P02、P03。**文件：** PortfolioOverviewPage、PortfolioComparisonPanel、workspace-navigation、WorkspaceNavigationBar、simple-experience 兼容文案、app、双语 JSON。

- [ ] 保留 PortfolioOverviewPage 的区块顺序、标题、CTA；在已有“我的账户”卡中增加团队名、类型和统一资产链接。
- [ ] 保留现有金额/收益率、账户记录/当前持仓回看等曲线口径；保留账户颜色；不重新实现曲线计算。
- [ ] 在“我的股友”之后新增“团队模拟盘”；将“资产与账本”显示名改为“资产与账户”；原 `/paper`、旧模拟仓深链和其他入口继续可用。
- [ ] 检查 desktop/sidebar/mobile/search destination/返回标题一致；不要只改桌面侧栏。
- [ ] 验证 Figma H/A/B/K 四屏及 ACC-07–09；提交首页与导航改动。

**通过标准：** 首页仍能直接完成原有日报、策略讨论与新建模拟仓操作；实仓总资产不叠加模拟资产；点击团队卡到准确账户。

## T05. 团队列表、新建、复制与账户关联入口

**需求：** P05、P06、P12。**文件：** teams API、TeamsPage、TeamWorkspacePage、teams.service、version service。

- [ ] 实现空态、搜索、筛选、错误重试与版本/运行/关联账户三种独立状态展示。
- [ ] 新建仅保存名称、简介、头像及初始组织；支持选择旧模拟盘或进入既有建盘流程，不能新增另一套开户记账。
- [ ] 复制创建新的 teamId 与岗位/关系 ID 映射；复制职责和布局，重新检查连接引用；不复制历史、密钥、运行、策略批准或绩效归属。
- [ ] 账户关联先展示预览：目标账户、当前团队、历史不迁移、进行中任务影响；确认才写有效绑定；foreign/archived/冲突均按技术错误码返回。
- [ ] 一盘一当前团队、一团队一当前盘的约束由 DB 和服务双重保证；旧未绑定盘继续原有操作。
- [ ] 实现团队归档预览和确认：列进行中委托、待审提案、绑定与账户执行状态；确认后拒绝新委托、保留历史/账本，按预览处理尚未完成工作，不级联归档或暂停账户。归档本身不假称远端已停止；首期归档团队只读，可复制配置为新团队，不隐式恢复。

**验证：** ORG-11/15、MIG-02；浏览器确认新建/取消/复制后没有研究请求或模拟执行请求。

## T06. 自由组织图领域规则

**需求：** P07、P08、P14。**文件：** team-graph、team-graph、对应前后端规则测试。

- [ ] 部门容纳与岗位职责独立；一个视觉父部门，多条汇报线；部门/汇报各自禁止循环。
- [ ] 汇报边保存方向与责任范围；同语义重复线、自连、缺端点拒绝；多根、跨组、多主管允许。
- [ ] 协作关系保存委托/复核/协作类型及说明；双向协作可以存在，不直接转执行依赖。
- [ ] 删除岗位/解散部门返回确定的影响列表；解散默认提升子节点，删除内容须明确选择；已发布版本与历史快照不改。
- [ ] 应用已审核容量规则，并验证临界值与超限返回；前端提示与服务端校验使用同一契约。

**验证场景：** 两个研究组共享一个专家；专家分别向两位组长汇报，第三岗位跨组复核。改变视觉归组不会增加工具权限或创建任务。ORG-01–06、12、14。

## T07. 画布、属性与非拖拽等价操作

**需求：** P06–P10、P18。**文件：** TeamCanvas、TeamOutline、TeamInspector、TeamRelations、team-flow-adapter、样式与依赖清单。

- [ ] 安装并固定拟选 React Flow 版本，检查依赖/许可及 lockfile；当前只读核查结果见附录，不在文档阶段安装。
- [ ] 将业务 departmentId 映射为 React Flow `parentId`；节点坐标通过 adapter 读写。岗位 ID、角色、连接 ID 不由画布控件重新生成。
- [ ] 实现选择/多选/框选、缩放、定位、折叠、搜索、拖拽归组预览；拖动经过部门边界不自动改归属，只有命中明确落点并完成动作才提交。
- [ ] 实现连线工具与属性表单；新增关系也可通过起点/终点/类型选择完成；错误定位到节点/边而非仅全局 toast。
- [ ] 一次完整拖拽作为一次 undo；Esc 取消未完成操作；输入文本时 Delete/快捷键不误删节点；撤销发布前草稿变化，不能撤销已经落库的历史版本。
- [ ] 列表视图提供移动到部门、编辑岗位、增加汇报对象、编辑关系、删除/恢复的等价入口；不得依赖高精度鼠标操作。

**验证：** ORG-12、UX-01/02/03/06/07。DOM 静态测试只验证表单与键盘状态；真实拖动、命中区和窄屏滚动必须浏览器验证。

## T08. 草稿保存、布局、离线和并发冲突

**需求：** P11、P16、P17。**文件：** use-team-draft、team graph、teams service、预览状态组件。

- [ ] 分离 layout revision 与 semanticRevision；纯坐标/缩放变更只保存布局；职责/归属/关系/执行器变更创建语义草稿变化。
- [ ] 显示未保存、本地保留、保存中、服务器已保存、保存失败、冲突六类反馈；本地副本不可含密钥或大附件。
- [ ] 保存携带期望 revision；冲突返回服务器 revision；保留本地副本，展示差异，允许重载或人工重应用；不自动最后写入覆盖。
- [ ] 网络断开时可继续编辑且明确本地状态；恢复只同步草稿，不自动重新发布或启动研究。
- [ ] 离开页面时仅对未保存语义变更提醒；恢复弹窗显示本地时间、服务器时间和版本；已归档/失权时停止上传并显示原因。

**验证：** ORG-07/08、UX-05。两个浏览器上下文同时改一个岗位；布局保存不能刷新语义哈希或使运行中任务改用新配置。

## T09. 发布预览、发布事务与交接

**需求：** P12、P16。**文件：** TeamPublishDialog、team-version.service、teams.service、团队预览与回执表。

- [ ] 预览返回新增/修改/删除岗位与关系、影响的能力与绑定、阻断项和警告；无阻断才允许确认。
- [ ] 确认消费对应 preview，检查过期时间、输入 hash、当前 revisions 和实时授权；使用 requestKey 幂等。
- [ ] 同 key 同 payload 返回同回执；同 key 不同 payload 拒绝；事务中版本、关联变化和回执原子写入。
- [ ] 幂等 inputHash 纳入路由中的 teamId/commissionId/grantId；同 owner 在另一资源复用相同 key/body 必须冲突，不能收到别的团队的成功回执。
- [ ] 发布后运行中委托仍引用旧版本；下一次研究使用新版本；发布不默认暂停账户、不重新开盘、不调整策略组合。
- [ ] 仅组织发布/未绑定团队按详细设计显示“未关联，不能发起账户研究”；补齐运行连接与绑定后重新预览能力。
- [ ] 交接请求显式确认每项受影响提案的重新复核安排，以及已应用组合继续或暂停的选择。旧待审/待应用提案不能自动算新团队已批准；从现有账户命令提取可复用事务 helper，将同一账户的绑定变更、提案重核、规则处理及回执同事务提交。暂停明确包含保护单；不能通过顺序调用多个 HTTP 写接口冒充原子交接。
- [ ] 同团队更换账户按技术设计分两步：先 release 旧账户并确认其规则处理，再 assign 新账户并独立确认。第二步失败保留“未绑定”的真实状态及恢复入口，不能把两步伪称一个原子成功；同一账户更换主责团队仍为单事务。

**验证：** ORG-08–11/16、RUN-09。模拟确认请求超时后重试，应显示原发布结果；不能产生重复版本。

## T10. 扩展现有研究工作项与能力检查

**需求：** P09、P13、P14。**文件：** shared research-workflow、Council workflow/store/executor/service、workflow schema、team-runtime-adapter。

- [ ] 保留旧固定角色调用兼容；新增 `workKey` 与 `dependencyWorkKeys` 识别同类不同专项，增加 specialist 工作类型；一次 work 的重试保留 attempt，而不是新造不相关工作。
- [ ] 将组织分工变成冻结执行清单：输入、交付、执行岗位、主责、复核、预算、资料 cutoff、依赖逐项确定；校验依赖缺失与循环。
- [ ] 每次唯一最终负责人；多位主管可以读取/协作，不重复派发同一 work；最多执行岗位和并行度使用批准值。
- [ ] workKey 的规范化摘要必须包含来源 ID/版本、账户输入、截止、依赖及任务范围；同岗位同问题但不同财报期是不同工作，仅主管引用不同才合并。编译先验证 DAG，按拓扑序映射依赖摘要，不依赖用户自报 workKey 授权。
- [ ] 单人模式走同一 workflow 的自检/汇总逻辑并标记非独立复核；不偷补隐藏 Agent。混合团队显式选内置/原生连接，原生主责能力不足时显示具体缺项。
- [ ] 逐岗位检查连接授权、能力、上下文、工具、预算和可用性；busy 可等待，offline/revoked/unsupported 不自动付费换路由。
- [ ] 每次实际派发前重验实时预算上限与可用余额，再按既有预算预留规则原子占用。冻结预算不是绕过后来收紧限制的许可；尚未派发的超限工作阻断，已派发或 unknown 的费用保留，不据此扩大到账户暂停。
- [ ] budget-limit 同时支持只降低 callLimit 和同币种费用上限；calls_only 的 null 不参与金额比较，不能被解释为免费。费用未知的原生连接只能进入当前授权允许且用户明确选择的预算模式。
- [ ] 回归旧 Council 固定任务、恢复、预算测试，证明扩展没有破坏旧会话。

**实现边界：** 现有 `PortfolioResearchRouteService.resolve(owner)` 会使用 owner 全局偏好及回退；团队岗位适配器不得以此覆盖冻结的显式选择。作业表只保证会话准备/启动/投影/恢复可靠，不承担另一套 LLM 调用循环。

## T11. 团队记忆与资料授权贯穿底层

**需求：** P13、P15、P16。**文件：** team-source-access.service、research-memory、research-tools、Council session/run/recover 与相关 shared scope；既有源删除/撤销路径定向扩展。

- [ ] 创建同 owner 不同 team 的 fixture；先验证列表、全文/向量召回、按 ID 读取、历史版本、附件和工具读取都会拒绝越界。
- [ ] 团队会话创建、续跑、恢复与后台投影都带固定 team scope；缺 scope 的团队任务拒绝执行，不能退回 owner 全局检索。
- [ ] 共同公告/行情通过明确来源授权共享；判断、反思和未提交交付默认私有；同一来源版本在证据中去重。
- [ ] source grant 撤销在派发前、读取时、验收前重检；历史保留失效原因和最小审计引用，但正文、下载链接和缓存不能绕过撤销。
- [ ] 资料截止限制独立于读取权限；有权读但晚于 cutoff 的资料不能混入历史研究。
- [ ] lower-layer 用中立 scope 契约依赖，不导入 Teams 实现；运行 architecture 和相关 memory/tool/Council 测试。

**验证：** MEM-01–06、RUN-14。仅给 `/api/teams` controller 加过滤远远不够；必须用真实底层检索 fixture 证明不能串团队。

## T12. 委托预览、创建与可靠桥接

**需求：** P13、P14、P17。**文件：** TeamCommissionDialog、commission service、runtime adapter、commission jobs。

- [ ] 表单显示账户/团队版本、问题、对象、策略与持仓、来源版本、截止、负责人、交付要求、预算、deadline 和重试/修订上限。
- [ ] 预览无付费模型调用；提交固定配置、持仓、策略、来源、预算、权限与执行器快照，并创建一份委托和可恢复桥接作业。
- [ ] 同 key 重复点击返回同 commission；创建事务提交后才派发，不在网络连接中断后盲目重建 Council session。
- [ ] worker 领取有租约与幂等 session 关联；同 work 被多个主管引用仍只执行一次；不同 workKey 允许同岗位分别做不同工作。
- [ ] GET/刷新/轮询只投影状态；首次执行和恢复都核对授权，接口返回委托状态与底层运行引用，不能“查状态即开始运行”。

**验证：** RUN-01–05、ORG-02、MEM-03。在提交成功但 HTTP 响应丢失处注入故障；重试后只有一个委托、一个正确关联的会话。

## T13. 未知、取消、超时与恢复

**需求：** P14、P17。**文件：** commission service、runtime adapter、工作历史状态组件、既有 workflow 恢复路径。

- [ ] 故障注入覆盖派发前失败、远端接收后断线、响应已保存但解析失败、租约过期、provider 迟到响应。
- [ ] unknown 保留派发和预算记录；恢复可查询已有运行或解析已保存响应，不能自动开始第二次模型请求。
- [ ] 取消终止后续未开始工作；尽力通知已有执行器；界面显示取消请求与实际终态差别，费用保留真实已用/未知。
- [ ] 迟到结果只作为迟到记录保存；取消或 settled_unknown 后不自动验收、不重新激活委托、不形成策略或成交。
- [ ] 重新发起是明确新委托，预览新预算和版本；链接原任务并说明可能存在先前费用，不能把“重试”伪装成免费刷新。

**验证：** RUN-06–08、12。断线故障下模型发送计数不增长，状态历史顺序可解释且不会被轮询修改。

## T14. 交付、判断版本、决策与模拟执行关联

**需求：** P15、P16。**文件：** decision service、research links、TeamWorkHistory；现有 Council 报告、论点、strategy mandate/执行读取路径的定向链接扩展。

- [ ] 统一交付包含结论、证据、反证、未知项、来源版本、结果/失败状态；服务验收不等于用户采纳。
- [ ] 按 commission/work/attempt/report/thesis version 保存精确引用；多个读者引用同一交付，真实返工保留独立尝试与版本。
- [ ] 创建“维持/修改/等待/拒绝”等实际判断与决策记录；等待是显式理由，不能从没有成交推测。
- [ ] 采纳只形成既有策略草稿/提案或关联；用户仍走现有账户规则、风险预览和 apply 授权。团队服务不得直接改现金、持仓、订单成交状态。
- [ ] 运行、验收、采纳、策略应用、执行回执、成交分别显示；点击行动沿精确 ID 查当时版本，不能用股票代码或临近时间补配。
- [ ] 旧盘无关联时显示“未记录关联”；换团队后历史仍属原团队版本；撤销来源显示失效占位而非补造证据。

**验证：** DEC-01–05、RUN-10、MEM-05。至少完整演示一次相同新财报使 A/B 得出不同判断，其中一队明确等待，两条曲线继续由既有模拟执行产生。

## T15. 窄屏、键盘、国际化与性能取证

**需求：** P17、P18 及所有页面状态。**文件：** 新 Teams 组件、既有页面改动样式、zh-CN/en、浏览器 fixture 验收记录。

- [ ] 1440px 对照 Figma 页面；390px 完成新建、列表编辑组织、关系属性、预览、保存与返回；模拟盘身份、负责人、预算和错误不因窄屏隐藏。
- [ ] 仅键盘完成添加/移动/关联/删除/撤销；Modal 关闭恢复焦点；关系文字可读；颜色之外使用线型、图标和标签。
- [ ] 深链、未登录、失权、404、归档、离线、保存失败、预览过期、发布冲突分别保留用户输入并给出正确动作。
- [ ] 按批准容量构造虚构矩阵组织，记录浏览器、设备、节点/边数、拖动/搜索/保存耗时；目标与测量分栏，不将未测目标写成已达成。
- [ ] 核对中英文、暗色/其他现有外观模式、减少动画和长名称；不写死新的全站白色主题。

**验证：** UX-01–07；截图和录屏只使用虚构资产与成员；Figma 的预设跳转不能替代实际任意编辑器验收。

## T16. 回归、文档、PR 与发布交付

**需求：** 全部 P01–P18。**文件：** 测试登记、CI、docs/README、docs/architecture、相应用户与维护指南、仓库 contributor skill 知识引用。

- [ ] 依验收附件准备一次性 DB，运行聚焦测试，再运行受影响全量与构建；所有 skip/未运行条件记入结果，不能只写“测试通过”。
- [ ] 更新架构五张维护图及团队/账户/研究边界说明；更新用户导航、API 文档和仓库 skill 的源文件映射。文档中的“待实现”在确实交付后才改成当前能力。
- [ ] 运行 module boundary 与 DI wiring，确认 Teams 只组合既有执行器，无反向业务依赖、未注册 provider 或遗失 SQL 打包。
- [ ] 验证两个发布开关关闭后仍可读取/取消/结算并执行团队权限检查；回滚只使用理解 team context 的兼容构建，保留新表与审计，不回退到能绕过 scope 的旧二进制。覆盖 MIG-04。
- [ ] 提交 reviewer 能复现的证据：基线与 HEAD、测试命令/结果、DB 来源、fixture、截图路径、迁移对照与未覆盖项。
- [ ] 建立 PR，描述最终行为与验证；等待要求的 Lint & typecheck、Agent tests、Docker image build。Web 构建用 `npm run build:web`，不使用默认 Electron 打包作为本功能验收。
- [ ] 应用部署是单独后续动作；在明确部署指令前，不改个人实例端口、环境文件、数据库或运行服务。

## 4. 命令、预期与完成标准

命令从仓库根执行。以下是在未来代码与 fixture 就绪后的检查，不是本轮已运行证明。可丢弃 DB 的具体创建、变量与初始化以[验收附件第 6 节](../specs/2026-11-12-team-paper-acceptance.zh-CN.md#6-开发后的实际验证命令)为准；不能把普通个人实例 URL 填入测试变量。

```powershell
npm run lint
npm run test:architecture
npm run test:context
npm run check:context
npm run test:client
npm run test:server
npm run test:local-agents
npm run test:wiring
npm run build:web
```

预期：类型/lint/边界无错误；前端与服务端新增场景被实际收集；指定数据库测试不因缺变量跳过；wiring 的 provider 全部可解析；Web 产物构建成功。lint 已包含类型检查；局部开发时可单独运行 `npm run type:check`，全量验收不无故重复。Node runner 输出中的 skip 必须列出名称和原因，不能计入已通过场景。

**本功能完成条件：** 批准的 11 个画板与未画出的异常状态可实际操作；P01–P18 都有实现任务及验证证据；全部 P0、主流程 P1 通过；旧账户/策略/历史未被隐式转换；没有真实外部调用作为自动化 fixture；用户可从首页进入正确团队持仓、配置矩阵团队、手动研究，并从一次行动追到当时的判断版本。

## 5. 需求覆盖与实施依赖

| 需求 | 主任务 | 验收组 |
|---|---|---|
| P01 页面与导航 | T04 | ACC-02/09、UX-04 |
| P02 首页与表现 | T04 | ACC-01/07/08 |
| P03 账户上下文 | T03/T04 | ACC-02–06 |
| P04 资产与数值 | T03 | ACC-01/05/06/08 |
| P05 团队列表与创建 | T02/T05 | ORG-01/11/15、MIG-02 |
| P06 画布布局 | T05/T07 | UX-01/03 |
| P07 独立对象配置 | T01/T06/T07 | ORG-01/06/12/14 |
| P08 矩阵关系 | T06/T07 | ORG-02–05 |
| P09 执行器 | T10 | ORG-06、RUN-11/12 |
| P10 画布动作 | T07 | ORG-12、UX-02/06 |
| P11 保存并发 | T08 | ORG-07/08、UX-05 |
| P12 发布绑定 | T09 | ORG-09–11/16、MIG-01 |
| P13 委托表单与输入 | T11/T12 | RUN-01/02、MEM-03 |
| P14 分工与有界运行 | T10/T12/T13 | RUN-03–08/12–15 |
| P15 交付与判断 | T11/T14 | MEM-01–06、DEC-01–05 |
| P16 变更影响 | T08/T09/T10/T11/T14 | RUN-09/15、ORG-15/16、DEC-05、MEM-04 |
| P17 异常恢复 | T08/T13/T15 | RUN-06–08、UX-05 |
| P18 移动/可达/规模 | T07/T15 | UX-01–07 |

以下情况须回到具体条款修订方案，而不能在代码中静默降级：原生负责人无法满足必需工具契约；现有记忆检索无法带 team scope；新增 workKey 与旧 workflow 去重约束冲突；图形依赖不满足既有构建/许可条件；测得容量目标明显不可达。允许先完成不依赖这些问题的阶段，不以不确定能力展示“已完成”。

## 6. 图形依赖选择依据

2026-11-12 只读查询 `npm view @xyflow/react version peerDependencies license --json` 返回 12.12.1、MIT、React/ReactDOM 与 types >=17；与当前 React19.2 的声明范围相容。**相容范围不等于已经通过本项目验证。** 审核后开发时固定依赖并跑构建与交互验收；若版本发生变化，不无记录升级。

React Flow 提供节点/边交互及键盘辅助能力，业务的岗位权限、多线汇报校验和研究编排由 Squabble 自己实现。[官方无障碍文档](https://reactflow.dev/learn/advanced-use/accessibility)、[节点属性与 parentId](https://reactflow.dev/api-reference/types/node)说明可用基础。部分高级示例在 Pro 中，本计划不依赖购买或复制付费示例；通过公开 API 实现所需归组和撤销逻辑。[官方 Pro 示例范围](https://reactflow.dev/examples/pro-examples)

本文审查重点是功能范围、实现依赖、边界和验收是否足够。审核确认后，按上述阶段开始开发；不会因原型通过就提前执行本计划。
