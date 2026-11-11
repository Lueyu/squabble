# 团队模拟盘：验收用例与验证实施说明

日期：2026-11-12。状态：验收设计已批准，用户已授权实现、验证与合并。本文列出目标场景，不作为通过报告；实际命令、证据与限制见 [验证记录](../../team-workspace-validation.md)。

本文件配合 [产品设计](2026-11-12-team-paper-product-design.zh-CN.md)、[技术设计](2026-11-12-team-paper-technical-design.zh-CN.md) 阅读。已确认的产品前提是：保留现有首页和资产入口，新增团队模拟盘；允许自由组织架构、跨组协作、多线汇报；每次研究必须有且仅有一个最终负责人。Figma 原型已获用户认可，不代表下述新增 API、状态、数据库约束已经实现。

核对基线为 `b9f1febea567438afd315d6dcf8000d02a64c53e`，启动迁移清单截至 `60_local_compute.sql`。本文列出的新文件、fixture、团队专用数据库变量与契约测试均为拟新增；实际开发开始前应重新核对当前 HEAD 和下一个可用迁移序号。

## 1. 验收结果怎样判断

1. 每个用例必须留下结果：通过、失败、未执行或有明确原因的阻塞。数据库用例被跳过，不计作通过。
2. 发布团队、绑定账户、创建研究、采纳判断、应用策略、产生模拟成交分别验收，不能用其中一个成功代替整个链路成功。
3. 重点验证可观察行为与数据库不变量，不为了截图好看而接受账户串数据、重复付费派发、历史关联漂移。
4. 财务或行情样例均使用虚构数据、明确资料截止时间和固定时钟。API、MCP、原生 Agent 使用可计数的 fixture transport 或虚构可执行文件；不使用个人账户、真实模型会话或实盘操作。
5. 页面验收包含真实浏览器操作。静态 HTML 渲染测试可以检查按钮和文案，不能证明画布拖拽、焦点顺序、缩放命中或移动端可用。

建议把测试结果记录为：`用例 ID / commit / 环境 / 命令或操作 / 实际结果 / 证据路径 / 问题链接`。截图和日志应使用虚构账户名，不输出密钥、内部执行令牌、加密输入原文。

### 1.1 优先级与测试类型

| 标记 | 含义 | 交付标准 |
|---|---|---|
| P0 | 账户、权限、资金、重复执行、版本历史错误 | 全部自动化通过，阻断发布 |
| P1 | 主流程、兼容性、组织编辑、主要异常处理 | 自动化覆盖核心契约，并完成浏览器验收 |
| P2 | 大画布操作、细节、观测性 | 有确定结果；未完成项必须明确范围和影响 |
| U | `node:test` 单元或纯契约测试 | 不连接真实外部服务 |
| I | PostgreSQL 集成测试 | 独立测试库、随机 schema，验证真实事务/约束 |
| C | JSDOM/React 客户端行为测试 | 验证路由、请求、缓存、交互状态 |
| B | 浏览器操作验收或浏览器自动化 | 验证布局、键盘、拖拽和端到端用户行为 |

## 2. 可复用的当前测试设施

以下是实际存在的基线设施，开发时应扩展它们，而不是引入第二套研究执行引擎或测试框架。

| 位置 | 已有能力 | 本次使用方式 |
|---|---|---|
| `client/src/utils/simple-test-loader.cjs` | TS/TSX 转译、别名解析、HTTP 请求记录、查询 fixture、MemoryRouter | 首页、资产账户、团队列表、草稿编辑的轻量客户端测试 |
| `client/src/utils/channel-account-selection.test.cjs` | JSDOM、React `act`、真实 QueryClient、延迟请求和账户切换 | 复用“先选 A 后选 B，A 晚返回”的账户隔离测试模式 |
| `server/modules/paper-trading/portfolio-workspace.integration.spec.ts` | 随机 schema、多 owner、多账户、preview/CAS、幂等回执、重启 | 团队发布、账户绑定、组合策略及旧账户兼容 |
| `server/modules/research-runtime/runtime-journal.integration.spec.ts` | 付费派发前落账、租约争抢、输入哈希、unknown、取消与迟到结果 | 团队任务映射到现有 runtime 后验证同一约束 |
| `server/modules/research-runtime/runtime-recovery.spec.ts` | 状态查询不恢复、不发模型；unknown 结算不把费用当已知 | 团队详情轮询和恢复操作的回归依据 |
| `server/modules/council/council-report-resume.integration.spec.ts` | 已保存响应恢复，避免再次调用 provider | 重解析/恢复不能变成重复研究 |
| `server/modules/research-memory/research-memory.integration.spec.ts` | owner 隔离、CAS、删除来源后跨版本不可再检索 | 增加同 owner 不同 team 的隔离及撤销测试 |
| `server/modules/experience/assets-upgrade.integration.spec.ts` | 新装与升级 catalog 比对、迁移重复执行、旧账保留 | 把团队相关新表、索引与旧数据不变量加入覆盖 |
| `server/modules/experience/migration-packaging.spec.ts` | 启动清单中的迁移存在且被 Docker 包含 | 确认新增 SQL 能实际随部署到达服务器 |
| `scripts/module-boundaries.spec.cjs`、`eslint.config.js` | 对真实 ESLint import/export/import type 规则做测试 | 增加 teams 与共享底层的依赖方向限制 |
| `scripts/check-module-wiring.cjs` | 编译后 Nest provider 解析与唯一归属，不调用 `init/listen` | 将团队关键 provider 纳入检查；仍要求测试 DB |

### 2.1 新测试的注册点

| 修改点 | 必须做什么 | 漏掉的后果 |
|---|---|---|
| `package.json` → `test:server` | 加入 `server/modules/teams/*.spec.ts`；若使用子目录，明确加入对应 glob | 现有脚本显式列出模块，新团队测试不会被自动发现 |
| `package.json` → `test:client` | 建议测试置于已覆盖的 `client/src/utils/team*.test.cjs`；若放 feature 目录须新增 glob | 测试文件存在但 CI 未执行 |
| `.github/workflows/ci.yml` → server tests env | 新增 `TEAM_TEST_DATABASE_URL`，指向现有 CI 临时 PostgreSQL；此变量为拟新增契约 | 新团队 DB 测试缺库或跳过 |
| `server/database/schema.ts` | 导出拟新增的 `teams.schema.ts` | Drizzle 类型、统一 schema 和实际表可能不一致 |
| `server/common/platform/database.provider.ts` | 在显式启动注册表追加实际迁移文件名 | 仅把 SQL 放到目录不会执行 |
| `scripts/db/01_schema.sql` | 同步新装结构；新增顺序迁移覆盖已有安装 | 新装与升级出现不同 schema |
| `server/app.module.ts`、`teams.module.ts` | 注册 TeamsModule，依赖既有导出的 routing/runtime/memory 服务 | 编译通过但启动无法解析或重复实例化 |
| `scripts/check-module-wiring.cjs` | 纳入团队关键 provider，并检查唯一归属；不得通过启动生命周期来“顺便测试” | 重复服务实例或隐藏后台任务 |
| `eslint.config.js`、`scripts/module-boundaries.spec.cjs` | shared 不依赖 app；底层 core/routing/runtime/tooling 不反向依赖 teams | 新模块把底层变成业务循环依赖 |
| 当前架构文档、contributor references | 同步真实实现后的页面/API/数据/依赖/工作流五类图与职责 | 后续维护继续按旧结构开发 |

拟新增文件建议：`teams-contract.spec.ts`、`teams-graph.spec.ts`、`teams-publication.integration.spec.ts`、`teams-commission.integration.spec.ts`、`teams-memory.integration.spec.ts`、`teams-upgrade.integration.spec.ts`；前端为 `team-account-selection.test.cjs`、`team-overview.test.cjs`、`team-canvas.test.cjs`、`team-status.test.cjs`。这些文件名是实施安排，当前并不存在。

## 3. Fixture 与数据库隔离

### 3.1 固定样本

| 样本 | 构造 | 要验证的差异 |
|---|---|---|
| 用户甲/乙 | 两个不同 owner | 所有读取、修改、回执、文件、记忆 owner 隔离 |
| 实仓 R | 虚构 100,000 基准资产，无团队绑定 | 首页实仓总资产不得包含模拟资产 |
| 模拟盘 A/B | 同 owner，不同初始资金、持仓、策略组合和日期 | 账户选择、图表口径、缓存、研究输入不串盘 |
| 团队甲/乙 | 同 owner，不同成员/记忆/公开交付 | 同一个 owner 不等于允许团队互读未授权判断 |
| 旧模拟盘 L | 有账本、交易、策略和头像，但无团队配置 | 保留运行与历史，不自动虚构团队或观点来源 |
| 矩阵团队 M | 一名专家同时向负责人 P/Q 汇报，两个部门；另有跨组复核关系 | 图结构不等于执行流程；每次任务只有一个最终负责人 |
| 版本 v1/v2 | v1 已发布并创建任务，v2 改成员、权限、策略关联 | 旧任务快照稳定，新任务采用新版本 |
| 共享事实 F | 一份公告的一个不可变版本，被两人引用 | 来源去重，不计两份独立证据 |
| 私有判断 J | 团队甲的未发布反思与论点版本 | 团队乙无法搜索、列举、直接通过 ID 读取 |
| 执行器 E | 可配置为成功、拒绝、超时、迟到、未知费用、保存响应后中断 | 明确测量派发次数，不调用真实模型 |

### 3.2 数据库要求

团队集成测试建议以拟新增 `TEAM_TEST_DATABASE_URL` 为唯一入口；要求 URL 指向专用可丢弃数据库，数据库名明确含 `test`。不回退到 `DATABASE_URL`。相关回归测试沿用现有 `STRATEGY_TEST_DATABASE_URL`、`RESEARCH_TEST_DATABASE_URL`、`MEMORY_TEST_DATABASE_URL` 等变量，不改已有语义。

每例创建 `teams_<随机 UUID 无连字符>` schema，测试连接显式设 `search_path`，使用独立连接池；fixture 内创建 schema、种入虚构 owner、加载需要的 schema/迁移，然后构造带假依赖的真实 service。只有本例生成的 schema 可以清理。`finally` 必须结束池并清理该 schema，失败路径也不能遗留后台 worker。

事务约束和并发验证必须使用两个实际连接/事务，不能只对单个 mock 对象并发调用。使用屏障或 deferred Promise 控制相遇点，避免依赖随机睡眠。数据库时间通过显式设置 `lease_until`、`expires_at` 构造过期；Node 的 mock time 不会改变 PostgreSQL 的 `CURRENT_TIMESTAMP`。

测试日志只记录虚构标识。断言权限拒绝时同时检查：数据没变、没有新 job、没有新增 dispatch receipt、没有研究费用预留、没有策略或交易副作用。

## 4. 场景验收矩阵

### 4.1 首页、账户路由与持仓

| ID/级别 | 场景与操作步骤 | 预期结果 | 类型/依赖 |
|---|---|---|---|
| ACC-01/P0 | 准备 R/A/B；打开首页 | 实仓总资产仅由 R 构成；账户卡分别标识实仓/团队模拟盘；团队未配置显示明确空态 | C+B；固定资产 fixture |
| ACC-02/P1 | 从 R/A/B 卡片依次进入资产与账户 | 到达 `/holdings?accountId=real` 或精确模拟账户 ID；标题、持仓、现金、交易入口对应同一账户 | C+B；路由 fixture |
| ACC-03/P0 | A 请求延迟，选 B，B 返回后再释放 A | 当前仍展示 B；query key 包含账户；A 缓存只进入 A；不因切换触发研究或交易 | C；真实 QueryClient+deferred |
| ACC-04/P1 | 选择 B 后切换资产子页、刷新、后退/前进 | URL 与账户一致，选择可恢复；跳到全局关注列表时明确全局范围并保留返回上下文 | C+B |
| ACC-05/P0 | 访问不存在、已归档无权限、乙拥有的 accountId；再篡改 API accountId | 显示不可用/无权限，不回退到实仓，不泄露是否存在和数据，不执行操作 | C+I |
| ACC-06/P0 | 在 B 打开交易、持仓详情、研究入口；直达 `/import?accountId=B` 并尝试实仓导入 | 所有允许操作携带 B；模拟盘隐藏导入；直达显示不支持，必须明确改选实仓才进入导入；服务端拒绝错误账户类型 | C+I+B |
| ACC-07/P1 | 首页切换折线范围、勾选 R/A/B、点击图例和账户入口 | 图例与账户颜色稳定；原币/基准币、收益率或资产值、数据截止时间清楚；无数据不补成零收益 | C+B |
| ACC-08/P1 | A/B 起点不同、有入金、手续费、非交易日和缺行情 | 图表保持真实区间、单位与现有收益口径；未统一条件时不显示“模型胜率”；同点对比明确可比性 | U+I+B；历史点 fixture |
| ACC-09/P1 | 进入现有 `/paper` 与已有账户深链接 | 原入口继续工作或按已约定规则导向相同账户；历史交易与策略不丢失 | C+I+B |

### 4.2 团队组织画布与发布

| ID/级别 | 场景与操作步骤 | 预期结果 | 类型/依赖 |
|---|---|---|---|
| ORG-01/P1 | 新建空白团队，添加单负责人；再增加部门、成员、嵌套部门 | 没有固定人数或三角色模板限制；部门容纳结构与成员职责分别保存 | U+C+B |
| ORG-02/P0 | 将专家同时连向 P/Q，选择关系职责；为一次研究指定 P 为最终负责人 | 多线汇报有效；研究最终负责人唯一；Q 保留其委托/复核身份，不能重复形成最终结论 | U+I+B |
| ORG-03/P1 | 建立汇报、委托、复核等关系；修改范围后保存再载入 | 线型/标签/方向可区分；关系范围持久化；连线本身不自动开始任务 | U+C+I+B |
| ORG-04/P0 | 添加自连、同义重复边、汇报 A→B→A、部门嵌套循环 | 本地提示并定位；服务端仍拒绝非法图；无部分版本或绑定写入 | U+I+C |
| ORG-05/P1 | 添加跨组双向协作、多根组织、未分组成员 | 合法结构可保存；协作循环不当成自动执行循环；发布/研究校验指出真实缺项 | U+C+B |
| ORG-06/P1 | 修改角色保留执行器，再替换执行器保留职责 | 两种维度独立；不因换执行器重建账户或抹去成员历史；能力不足明确阻断相应发布/任务 | U+I+B |
| ORG-07/P0 | 编辑 v2 草稿时已有 v1 任务运行；只移动节点或更改缩放 | 草稿不覆盖 v1；布局保存不改变语义版本、任务哈希或触发研究；刷新可恢复布局 | I+C+B |
| ORG-08/P0 | 两窗口读同一 revision，分别保存/发布 | 首次成功；陈旧 revision 明确冲突，不能最后写入覆盖；用户可重载并重新预览 | I+C |
| ORG-09/P0 | 发布 preview 后改草稿、改绑定或使授权失效，再确认原 preview | preview 失效或权限拒绝；不发布陈旧内容；事务中无半成品 | I |
| ORG-10/P0 | 同 requestKey 同 payload 并发发布；随后同 key 换 payload；同 owner 跨 team/commission 复用同 key/body | 同资源同内容返回同回执和版本；内容或路由资源身份变化拒绝冲突；不能重放其他团队回执 | I |
| ORG-11/P0 | 并发将团队甲/乙绑定同一个账户；或把同一 active team 绑定第二账户 | 满足第一版唯一有效主责绑定规则；只有一个成功，不创建共享多账户调度语义 | I |
| ORG-12/P1 | 删掉被关系引用的成员/部门；撤销；发布 | 明确展示影响并清理或阻断悬空引用；撤销可恢复；历史版本仍可读；运行中任务不被改写 | U+C+I+B |
| ORG-13/P1 | 保存未完成草稿、离开、回来；未绑定账户发布组织；启用岗位缺职责/执行器；研究未选负责人或选择多个 | 草稿允许不完整；合法组织可未绑定发布但不能研究；展示用空缺岗位不参与运行；启用岗位发布缺项与研究主责唯一分别校验，不偷偷补负责人或调用外部 Agent | U+C+I+B |
| ORG-14/P1 | 达到配置岗位数上限，再增加一项；复制配置；导入或直接提交超限图 | 建议首期最多30个岗位，超限在表单与服务端同时提示，不能截断保存；此数值是待审默认值，修改后统一调整 UI、契约和测试 | U+C+I |
| ORG-15/P0 | 团队有进行中委托、待审提案和正在执行的关联账户；预览并确认归档 | 列明影响，禁止后续新委托；既有任务按明确选择处理，远端取消未确认仍保留状态；不删除历史、账本或自动归档/暂停账户 | I+C+B |
| ORG-16/P0 | 更换主责团队，旧团队有待审/待应用提案；选择组合继续或暂停；同团队跨账户改绑第二步失败；响应丢失后重试 | 提案明确重新复核；继续不暗停，暂停说明包含保护单且走原命令；跨账户先解除旧绑定再独立关联新盘，第二步失败明确未绑定，各账户选择及回执独立，重试不重复应用 | I+C+B |

### 4.3 研究委托、快照、执行与恢复

| ID/级别 | 场景与操作步骤 | 预期结果 | 类型/依赖 |
|---|---|---|---|
| RUN-01/P0 | 创建委托前预览，确认后立即修改当前团队/策略/账户持仓/资料版本 | 委托持有精确不可变 snapshot：账户、团队版本、策略版本、主责人、持仓输入、资料截止、权限与预算边界；后改仅影响后续任务 | I |
| RUN-02/P0 | 创建委托同 key 重复/并发；同 key 改问题/输入 | 只产生一份委托及同一回执；不同内容拒绝；创建预览、GET、轮询不派发模型 | I+C |
| RUN-03/P0 | 两主管要求同专家做同专项；两个 worker 同时领取；另加同问题但不同财报期/版本输入的任务 | workKey 区分来源/版本/范围，真正同工作仅派发一次、多方引用；不同输入不得误合并，不按固定角色 taskKey 覆盖不同专项 | U+I |
| RUN-04/P0 | 一名成员有多条汇报线和不同预算/工具授权 | 有效权限按本次任务明确授权约束；不自动合并主管权限和额度；最终负责人解决冲突并记录原因 | U+I |
| RUN-05/P0 | 下游 `dependencyWorkKeys` 缺失、循环、未完成或失败 | 缺失/执行依赖循环被拒绝；依赖未满足不执行下游；图上的协作环不自动转成任务依赖环 | U+I |
| RUN-06/P0 | provider 收到请求后连接断开；租约过期；刷新/轮询/自动恢复 | 进入与底层一致的 unknown 状态，保持 dispatch/预算记录；不会自动再派发；费用未知不显示 0 或已退款 | I+C+B |
| RUN-07/P0 | 响应已持久化，解析前进程中断；点击恢复 | 使用已保存响应重解析/验收；同一 work 的模型发送次数不增加；记录新的解析状态 | I |
| RUN-08/P0 | 取消后 provider 迟到返回；unknown 已结清后迟到返回 | 保留迟到记录但不自动验收、形成决策或执行策略；取消/settled_unknown 不复活 | I+C |
| RUN-09/P0 | 停止新研究后触发既有模拟仓保护规则；另选“停止全部模拟执行” | 两种操作范围明确：停止新研究不扩大为停保护规则；只有明确全部停止才暂停相应模拟执行 | I+C+B |
| RUN-10/P0 | 内置/原生混合团队，专家交付包含未知项、反证、证据与文件 | 按同一交付契约验收；任务完成、可验收、被采纳、策略已应用、成交分别呈现；外部 Agent 无法绕过服务层直接写账本 | U+I+B |
| RUN-11/P1 | 选择尚未支持的 A2A 执行方式/不具所需能力的连接 | 显示未来能力或不可选说明；不显示伪运行成功，不自动改用另一个付费执行器 | U+C |
| RUN-12/P0 | 预算耗尽、连接撤销、执行器离线、节点 deadline 超时 | 明确阻断/失败/unknown 由事实决定；禁止把超时统称成功或把未知当可安全重试；保留下一步可执行操作 | U+I+C |
| RUN-13/P1 | 单人团队、6个执行岗位、7个执行岗位，分别尝试研究；并行设为1/2/非法值 | 待审默认单次最多6个执行岗位、并行1或2；超限显式拒绝；单人可以自检/汇总，界面不宣称“独立复核已完成” | U+I+C |
| RUN-14/P0 | 构造团队委托的底层 council ID，分别调用创建、历史、run、recover 或 research-tools 记忆工具；省略 team scope | 团队 scope 穿透现有入口；不能因缺 teamId 回退 owner 全局检索/恢复；团队乙和同 owner 的旧入口不能绕过隔离 | U+I |
| RUN-15/P0 | 委托启动后分别收紧费用与 callLimit；覆盖 calls_only 模式、已派发、unknown 和尚未派发工作 | 未派发工作重验实时上限并阻断超限；calls_only 不对 null 做金额 min；已用/unknown预留保留，不能凭旧快照、多主管额度继续超额；不暂停账户保护单 | I+C |

### 4.4 来源、团队记忆与决策关联

| ID/级别 | 场景与操作步骤 | 预期结果 | 类型/依赖 |
|---|---|---|---|
| MEM-01/P0 | 团队乙列举/搜索/按 ID 读团队甲未提交判断、反思、artifact | 列表和向量/文本检索均隔离；直接 ID 同样拒绝；owner 相同不构成跨团队授权 | I |
| MEM-02/P1 | 甲乙分别引用共享事实 F；两成员引用相同 F | 两队可使用已授权事实；不共享私有解释；交付证据按来源/版本去重 | U+I |
| MEM-03/P0 | preview 后撤销 source grant，再启动；运行中撤销后提交/验收 | 派发前与接收/验收前重检实时权限；快照不越过撤销；结果不可据此进入后续判断/策略 | I |
| MEM-04/P0 | 来源被撤销/删除，旧记忆仍含 source ID；执行搜索、版本查看、文件下载 | 不再暴露受限内容；保留必要审计占位及失效原因；旧正文/附件链接不能绕过过滤 | I+C |
| MEM-05/P0 | 构造乙 owner 或乙 team 的交付/论点 ID，提交到甲委托 | 所有引用链检查 owner/team/account及授权范围；失败不创建决策/记忆写入 | I |
| MEM-06/P0 | 团队执行调用 `research-tools.get_research_memory`，分别传本队、另一队、空 team scope；读取经 council 保存的历史 | 本队检索仍受 source grant 过滤；另一队拒绝；团队任务缺 scope 明确失败，不能默认为 owner 全部记忆；非团队旧流程的兼容语义单独测试 | U+I |
| DEC-01/P0 | 验收交付但不采纳；再采纳但未应用策略；最后应用后未成交 | 三个阶段均可准确显示；无自动隐式交易；“等待”有单独决策且可追溯 | I+C+B |
| DEC-02/P0 | 交付 D→论点 T:v3→决策 X→策略版本 S→执行回执 E→模拟成交 F；更新 T:v4 | 点击任何行动显示原 T:v3 与当时团队版本；不改为最新观点；链条精确而非按股票/时间猜测 | I+C+B |
| DEC-03/P1 | 同一新财报进入 A/B，A 维持、B 削弱观点并选择等待 | 对比展示各自依据、发现时间和动作；不自动宣称哪队正确；无法确认状态可保留 | U+I+B |
| DEC-04/P0 | 旧成交无精确观点关联；引用已删除资料；某个执行未成交 | 显示“未记录关联/来源不可用/未成交”等事实，不补造追溯、不把建议当成交 | I+C |
| DEC-05/P0 | 更换账户团队后查看更换前后的历史，并重复采纳相同交付 | 旧记录归原团队配置版本；新记录归新团队；幂等采纳不重复生成策略动作 | I+C |

### 4.5 升级、边界和浏览器操作

| ID/级别 | 场景与操作步骤 | 预期结果 | 类型/依赖 |
|---|---|---|---|
| MIG-01/P0 | 新装 schema 与基线60旧库分别升级，再重复运行新增迁移 | columns/constraints/indexes 等 catalog 等价；重复升级幂等；不修改旧账本、余额、策略状态 | I |
| MIG-02/P0 | L 无团队数据，升级并重复 `createDatabase` | 不生成虚构团队、主责人或历史判断；不自动研究/开盘/换策略；旧盘可继续使用 | I |
| MIG-03/P1 | 执行迁移清单/打包检查，编译后 provider wiring | SQL 注册且随镜像打包；团队 provider 唯一可解析；不启动生命周期任务 | U+I |
| MIG-04/P0 | 产生团队记录后关闭组织/研究开关，使用兼容构建回退并查看在途任务 | 停止相应新写入/派发，保留查询、取消、结算和team scope隔离；不运行无scope的旧二进制读取新记录，不删除审计或将unknown视为取消 | U+I+C |
| ARC-01/P0 | 向 shared、core、routing/runtime/tooling 试注入 teams 实现依赖 | ESLint 边界测试拒绝反向依赖；teams 复用共享执行器，不复制模型或工具运行循环 | U+静态检查 |
| UX-01/P1 | 1440px 桌面创建团队，拖入部门/成员，连线，修改属性，保存并重载 | 与批准原型一致；画布和属性面板不遮挡关键按钮；节点/线可定位，无全页意外横滚 | B |
| UX-02/P1 | 仅键盘添加成员、选择源/目标和关系、编辑、保存、删除、撤销 | 所有业务动作有键盘路径；可用表单选择起终点代替精确拖线；焦点可见，Esc退出临时连线，不误删页面内容 | C+B |
| UX-03/P1 | 390px 窄屏完成同一配置；打开属性抽屉、切换成员、返回 | 使用列表/关系编辑及画布查看等已设计适配；不要求精准手机拖线才能完成；保存/返回可达、焦点正确恢复 | B |
| UX-04/P1 | 打开团队详情深链、任务深链、来源页再返回；页面重载 | 不丢账户和团队上下文；未知/删除资源明确提示；长页面锚点和滚动不被误重置 | C+B |
| UX-05/P1 | 保存失败/断网后恢复、preview过期、发布冲突、空团队/无资产/无曲线 | 错误留在对应操作处；保留可恢复草稿；按钮不会显示假成功或重复提交；空态有明确下一步 | C+B |
| UX-06/P2 | 使用大规模虚构矩阵图反复缩放、框选、拖动、自动布局、撤销 | 位置保存稳定，长名称不破坏命中；语义版本不被布局操作改变；记录实际规模和交互耗时供确定性能目标 | B |
| UX-07/P1 | 中英文切换、颜色辨识受限、读屏读取成员和关系 | 标签完整；状态不只依赖颜色；关系可通过文字/列表理解；请求状态可被辅助技术识别 | C+B |

## 5. 八个拟新增测试契约示例

下列是给开发者的测试伪代码，沿用项目 `node:test` / `assert/strict` 风格。`teamFixture`、`uiFixture`、`api`、屏障、SQL 检查等均为**待实现的测试辅助契约**，不是现有 API，也不应原样复制后声称已通过。错误码以技术设计最终的共享契约为准；这里用语义名表达必须区分的错误。

### 示例 1：账户切换的晚响应不污染当前账户（ACC-03）

```ts
test('late account A response cannot replace selected account B', async () => {
  const f = await uiFixture({ route: '/holdings?accountId=A', realQuery: true });
  const lateA = f.deferAccount('A');
  f.replyAccount('B', { cash: 200, positions: [{ ticker: 'FICT-B' }] });
  await f.selectAccount('B');
  await f.waitForText('FICT-B');
  lateA.resolve({ cash: 100, positions: [{ ticker: 'FICT-A' }] });
  await f.flushReact();
  assert.equal(f.selectedAccountId(), 'B');
  assert.match(f.location(), /accountId=B/);
  assert.equal(f.visiblePosition(), 'FICT-B');
  assert.equal(f.accountCache('A').cash, 100);
  assert.equal(f.accountCache('B').cash, 200);
  assert.equal(f.mutationRequests.length, 0);
});
```

### 示例 2：多线组织合法，但每次研究最终负责人唯一（ORG-02、RUN-04）

```ts
test('matrix reporting preserves one accountable lead without permission union', async () => {
  await teamFixture(async f => {
    const version = await f.publish({ members: ['P', 'Q', 'Expert'],
      reporting: [['Expert', 'P'], ['Expert', 'Q']] });
    await assert.rejects(f.previewCommission({ version, accountable: [] }),
      f.errorIs('ACCOUNTABLE_REQUIRED'));
    await assert.rejects(f.previewCommission({ version, accountable: ['P', 'Q'] }),
      f.errorIs('ACCOUNTABLE_NOT_UNIQUE'));
    const job = await f.createCommission({ version, accountable: ['P'],
      participants: ['Q'], expertTools: ['facts.read'] });
    assert.deepEqual(job.snapshot.accountableMemberIds, ['P']);
    assert.deepEqual(job.snapshot.expertTools, ['facts.read']);
    assert.equal(job.snapshot.expertTools.includes('Q.private.write'), false);
    assert.equal(f.dispatches.length, 0); // 创建不等于 worker 已经派发
  });
});
```

### 示例 3：发布幂等、摘要冲突及并发 CAS（ORG-08～10）

```ts
test('publish replays only identical request and rejects stale revision', async () => {
  await teamFixture(async f => {
    const a = await f.previewPublish({ draftRevision: 7 });
    const request = { previewId: a.id, expectedRevision: 7, requestKey: 'publish-once' };
    const [r1, r2] = await Promise.all([f.publish(request), f.publish(request)]);
    assert.deepEqual(r1, r2);
    assert.equal(await f.countPublishedVersions(), 1);
    await assert.rejects(f.publish({ ...request, previewId: 'different-preview' }),
      f.errorIs('REQUEST_CONTENT_CONFLICT'));
    const draft = await f.readDraft();
    await f.saveDraft({ expectedRevision: draft.revision, members: ['first-editor'] });
    await assert.rejects(f.saveDraft({ expectedRevision: draft.revision, members: ['second-editor'] }),
      f.errorIs('REVISION_CONFLICT'));
    assert.equal(await f.countPartialBindings(), 0);
    assert.equal(f.dispatches.length, 0);
  });
});
```

实际用例应以技术设计规定的 draft revision 变化时机制作陈旧写入；示例先成功保存一次，再测试第二个编辑者使用旧 revision。不能假定所有“发布”动作必然把 draft revision 加一。

### 示例 4：任务快照稳定，动态撤销仍是验收边界（RUN-01、MEM-03）

```ts
test('frozen commission cannot inherit later draft or bypass revocation', async () => {
  await teamFixture(async f => {
    const c = await f.createCommission({ teamVersion: 'v1', sourceVersion: 'F:v1' });
    const snapshot = await f.readSnapshot(c.id);
    await f.publishVersion('v2');
    await f.updateHoldings({ ticker: 'FICT', shares: 99 });
    assert.deepEqual(await f.readSnapshot(c.id), snapshot);
    await f.workerDispatch(c.id); // fixture provider，仅一次
    await f.revokeGrant({ teamId: c.teamId, sourceId: 'F' });
    await f.receiveSavedDelivery(c.id, { sourceVersion: 'F:v1' });
    await assert.rejects(f.acceptDelivery(c.id), f.errorIs('SOURCE_ACCESS_REVOKED'));
    assert.equal(await f.countDecisions(c.id), 0);
    assert.equal(await f.countStrategyApplications(c.id), 0);
    assert.equal(f.dispatches.length, 1);
  });
});
```

### 示例 5：unknown 不重新付费派发，迟到结果不复活（RUN-06、08）

团队业务层可以把底层未知状态投影为 `uncertain`；断言同时检查底层 `provider_unknown`/`settled_unknown` 和业务投影，不用“已完成”覆盖底层事实。桥接 job 的 `prepare/start/project/cancel/recover` 是工作分发/状态投影动作，不构成第二套模型执行循环。

```ts
test('unknown recovery never redispatches paid work or accepts late output', async () => {
  await teamFixture(async f => {
    const c = await f.createCommission();
    await f.workerDispatchAndLoseConnection(c.id);
    await f.expireLeaseInDatabase(c.id); // 显式 SQL，不只 mock Date
    await f.recover(c.id);
    for (let i = 0; i < 3; i += 1) await f.status(c.id);
    assert.equal((await f.status(c.id)).runtimeState, 'provider_unknown');
    assert.equal(f.dispatches.length, 1);
    assert.equal((await f.status(c.id)).usageKnown, false);
    assert.equal(await f.countDispatchReceipts(c.id), 1);
    await f.closeUnknown(c.id); // 映射现有 runtime settleUnknown 语义
    await f.receiveLateProviderResult(c.id);
    assert.equal((await f.status(c.id)).runtimeState, 'settled_unknown');
    assert.equal(await f.countDecisions(c.id), 0);
    assert.equal(f.dispatches.length, 1);
  });
});
```

### 示例 6：同 owner 的团队仍不能串记忆，撤销穿透历史版本（MEM-01、04）

```ts
test('team scope applies to search, direct reads and old source versions', async () => {
  await teamFixture(async f => {
    const note = await f.seedPrivateMemory({ owner: 'owner-A', team: 'team-A',
      sourceVersion: 'F:v1', text: 'fictional private thesis' });
    assert.deepEqual(await f.searchMemory({ owner: 'owner-A', team: 'team-B' }), []);
    await assert.rejects(f.readMemory({ owner: 'owner-A', team: 'team-B', id: note.id }),
      f.errorIs('NOT_FOUND_OR_FORBIDDEN'));
    await f.revokeGrant({ teamId: 'team-A', sourceId: 'F' });
    const visible = await f.searchMemory({ owner: 'owner-A', team: 'team-A' });
    assert.equal(JSON.stringify(visible).includes('fictional private thesis'), false);
    await assert.rejects(f.downloadOldSource('team-A', 'F:v1'),
      f.errorIs('SOURCE_ACCESS_REVOKED'));
  });
});
```

### 示例 7：决策关联固定版本，并区分验收、应用与成交（DEC-01、02）

```ts
test('decision provenance remains on the adopted thesis revision', async () => {
  await teamFixture(async f => {
    const delivery = await f.acceptFixtureDelivery({ thesis: 'T:v3', teamVersion: 'v1' });
    assert.equal(await f.countStrategyApplications(delivery.id), 0);
    const decision = await f.adoptDelivery(delivery.id, { action: 'hold', reason: 'fixture reason' });
    await f.reviseThesis('T', 'v4');
    const detail = await f.readDecision(decision.id);
    assert.equal(detail.thesisVersion, 'T:v3');
    assert.equal(detail.teamVersion, 'v1');
    assert.equal(detail.action, 'hold');
    assert.equal(detail.executionReceipt, null);
    assert.deepEqual(detail.fills, []);
    assert.deepEqual(await f.readDecisionFromAccount(decision.accountId, decision.id), detail);
    await assert.rejects(f.readDecisionFromAccount('another-account', decision.id),
      f.errorIs('NOT_FOUND_OR_FORBIDDEN'));
  });
});
```

### 示例 8：新装/升级一致且旧盘不被自动转换（MIG-01、02）

```ts
test('team upgrade is repeatable and preserves unconfigured legacy accounts', async () => {
  await migrationFixture(async f => {
    await f.createFreshSchemaFromCurrentBase();
    await f.createUpgradeSchemaThroughBaseline60();
    const before = await f.seedAndReadLegacyLedger();
    await f.applyRegisteredMigrationsAfter60();
    await f.applyRegisteredMigrationsAfter60();
    assert.deepEqual(await f.readLegacyLedger(), before);
    assert.deepEqual(await f.normalizedFreshCatalog(), await f.normalizedUpgradeCatalog());
    assert.equal(await f.countTeams(), 0);
    assert.equal(await f.countActiveTeamBindings(), 0);
    assert.equal(await f.countCommissionJobs(), 0);
    assert.equal(await f.countInventedDecisionLinks(), 0);
  });
});
```

迁移 fixture 必须把升级 schema 固定在真正的基线60结构，不能用已含新表的当前 `01_schema.sql` 冒充旧版。可保存基线 fixture 或按明确迁移标记切出旧结构；两种方式都应有断言证明新团队表尚不存在。

## 6. 开发后的实际验证命令

下列命令已与当前 `package.json`、启动迁移注册与 CI 核对；这是待执行说明，本次文档阶段没有执行这些验证。从仓库根目录运行。Node 至少22、npm至少10；CI 当前使用 Node24、PostgreSQL16。锁定安装缺失或 lockfile 改动时使用 `npm ci`。若本地跑完整浏览器 collector 测试，应先按仓库文档安装 Chromium；不需要为纯团队 graph unit test 启动浏览器服务。

### 6.1 不连接 DB 的检查

```powershell
npm run lint
npm run test:architecture
npm run test:context
npm run check:context
npm run test:client
npm run build:web
```

`lint` 已包含 ESLint、TypeScript、Stylelint，不需要无原因重复所有子命令。`build:web` 编译服务端与网页；本阶段无需 Electron/desktop 构建。仅文档改动时按 CONTRIBUTING 检查 Markdown、链接和命令即可，不声称完成应用验收。

新增团队纯逻辑测试存在之后，可定向运行：

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/teams/teams-contract.spec.ts server/modules/teams/teams-graph.spec.ts
node --test --test-concurrency=1 client/src/utils/team-account-selection.test.cjs client/src/utils/team-canvas.test.cjs
```

上述是设计时的测试分组。实际测试按领域拆分在 `server/modules/teams/*.spec.ts`、`shared/team-templates.spec.ts` 和 `client/src/utils/team-*.test.cjs`，并已加入 `package.json` 收集范围；最终运行证据见验证记录。

### 6.2 准备可丢弃数据库与迁移

先单独准备 PostgreSQL16 测试实例和空数据库，例如 `squabble_team_test`，使用仅供该实例的凭据。下面脚本**假设**当前 shell 已设置 `TEAM_TEST_DATABASE_URL` 指向该数据库；它不读取生产 `DATABASE_URL`，也不负责创建/清空现有库。若数据库非空，应改用新建测试库，而不是直接执行基表初始化。

```powershell
if (-not $env:TEAM_TEST_DATABASE_URL) { throw 'Set TEAM_TEST_DATABASE_URL to a disposable PostgreSQL database first.' }
$teamTestUri = [Uri]$env:TEAM_TEST_DATABASE_URL
if ($teamTestUri.AbsolutePath -ne '/squabble_team_test') { throw 'Expected the explicitly named disposable database squabble_team_test.' }
psql $env:TEAM_TEST_DATABASE_URL -v ON_ERROR_STOP=1 -f scripts/db/01_schema.sql
if ($LASTEXITCODE -ne 0) { throw 'Base schema initialization failed.' }
$teamStartupMigrations = @(node scripts/db/list-startup-migrations.cjs)
if ($LASTEXITCODE -ne 0) { throw 'Migration registry could not be read.' }
foreach ($teamMigration in $teamStartupMigrations) {
  psql $env:TEAM_TEST_DATABASE_URL -v ON_ERROR_STOP=1 -f (Join-Path 'scripts/db' $teamMigration)
  if ($LASTEXITCODE -ne 0) { throw "Migration failed: $teamMigration" }
}
```

`list-startup-migrations.cjs` 从 `database.provider.ts` 显式注册读取清单，并验证文件存在。迁移文件名不能只写进文档而漏掉注册。新装 `01_schema.sql` 后再次执行增量迁移是当前 CI 路径，新增迁移必须支持这种重复执行。

团队 fixture 自建随机 schema 时也必须加载自身依赖的基表与迁移；不能误以为测试库 `public` 已初始化就能在隔离 schema 里直接工作。

### 6.3 集成与模块装配

在同一专用测试实例上运行完整 server 回归时，现有 CI 注入以下变量。可在已核实 `TEAM_TEST_DATABASE_URL` 后使用该专用库统一设置；每个测试仍应自己隔离 schema/owner：

```powershell
$teamTestVariables = @(
  'TELEMETRY_TEST_DATABASE_URL', 'BUDGET_TEST_DATABASE_URL',
  'COUNCIL_TEST_DATABASE_URL', 'AUTH_TEST_DATABASE_URL',
  'STRATEGY_TEST_DATABASE_URL', 'MEMORY_TEST_DATABASE_URL',
  'RESEARCH_TEST_DATABASE_URL', 'EXPERIENCE_TEST_DATABASE_URL',
  'HISTORY_TEST_DATABASE_URL', 'TOOL_CONNECTIONS_TEST_DATABASE_URL',
  'CHANNEL_TEST_DATABASE_URL', 'DATA_LIBRARY_TEST_DATABASE_URL',
  'WIRING_TEST_DATABASE_URL'
)
foreach ($teamTestVariable in $teamTestVariables) {
  [Environment]::SetEnvironmentVariable($teamTestVariable, $env:TEAM_TEST_DATABASE_URL, 'Process')
}
npm run test:server
if ($LASTEXITCODE -ne 0) { throw 'Server tests failed.' }
npm run test:wiring
if ($LASTEXITCODE -ne 0) { throw 'Module wiring failed.' }
npm run test:local-agents
if ($LASTEXITCODE -ne 0) { throw 'Local agent fixtures failed.' }
```

完整 server suite 不是离线纯单测：一些 DB 用例缺环境变量直接失败，另一些明确 skip。必须检查输出统计。`test:wiring` 自己先编译，再连接 `WIRING_TEST_DATABASE_URL` 并应用注册迁移；它不 `init/listen`，不调度后台任务，但仍会写入测试库。

定向团队 DB 测试（新增文件之后）：

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test --test-concurrency=1 server/modules/teams/teams-publication.integration.spec.ts server/modules/teams/teams-commission.integration.spec.ts server/modules/teams/teams-memory.integration.spec.ts server/modules/teams/teams-upgrade.integration.spec.ts
```

涉及记忆检索时再运行 `npm run test:memory-eval`，并检查虚构记忆评估结果；涉及本地启动脚本时运行 `npm run test:dev`。原生 Agent 验证只使用测试可执行文件和临时任务目录。不要用个人登录会话探测连通性来替代 fixture；真实 provider 测试会改变费用与外部状态，不属于本验收默认步骤。

### 6.4 浏览器验收与发布门槛

应用功能实现后，才按仓库 development guide 准备独立 DB、独立前后端端口、独立 `LOCAL_APP_ORIGINS` 和虚构数据实例。`npm run dev` 会处理端口监听进程，服务端启动会执行迁移并启动后台服务；它不是只读检查，不应在用户现有个人实例上随手运行。

浏览器主路径至少覆盖：

1. 首页实仓/团队账户卡与折线 → 资产账户切换 → 返回原账户上下文。
2. 创建空白团队 → 增加部门和矩阵成员 → 连线/键盘建立关系 → 保存草稿 → 预览 → 发布 → 绑定已有模拟盘。
3. 创建研究 → 明确最终负责人和输入 → fixture 交付 → 查看未知项/反证 → 采纳判断或选择等待 → 查看精确来源链。
4. 正在研究时修改草稿、刷新浏览器、模拟网络失败、provider unknown、撤销来源；确认没有重复研究或假完成。
5. 1440px 桌面与390px窄屏各跑一次；仅键盘完成组织编辑主流程，并核对空态、错误态、冲突态和历史版本只读态。

PR 仍受当前仓库三个必需 CI 检查约束：**Lint & typecheck**、**Agent tests**、**Docker image build**。本地定向通过不能代替这些检查。对本轮文档交付，只记录“命令与基线核对完成”；不能标记实现验收通过。

## 7. 用户审核时可以直接判断的标准

- 首页是否只在现有布局里增加团队账户和曲线；实仓资产合计、团队模拟盘和资产账户入口是否足够明确。
- 自由组织架构是否包含所需的部门、单人团队、多线汇报和跨组关系；每次研究的最终负责人是否可理解。
- 保存草稿、发布配置、绑定账户、启动研究是否分别有清楚的作用与反馈；布局调整是否保持轻量。
- 一次研究无法确认、被取消、来源被撤销时，界面是否如实说明；恢复是否避免再次付费执行。
- 从一次模拟行动能否找到当时的团队、交付、论点版本、策略版本和执行结果；旧记录缺关联时是否诚实展示。
- 现有模拟盘、策略、我的股友和其他主入口能否继续使用；手机与键盘是否可完成核心操作。

本附件给出验收范围和实施路径，不自动开启代码开发。用户审核设计和开发文档后，开发阶段逐项实现并记录实际验证结果。
