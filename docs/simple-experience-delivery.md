# Squabble 简化体验交付记录 / Simplified experience delivery

对应审阅稿：产品说明与2026-11-06开发计划。基线8e04fbc，开发分支codex/simple-experience。本记录随最终验收更新，不以设计目标代替实际验证。

## 功能与任务

| 任务 | 已实现内容 | 验收依据 |
| --- | --- | --- |
| 1 基线与契约 | 隔离分支、严格输入、共享类型、所有者与请求幂等 | rules与接口行为测试 |
| 2 增量数据 | 31–33迁移、当前分析、独立投稿、父授权与研究预算 | 新旧数据库对照及重复迁移 |
| 3 今日与当前分析 | 事实先展示、三项重点、按日阅读、生成去重与先后次序 | experience.integration.spec.ts |
| 4 直接提问 | 自动股票/组合/历史决策上下文、搜索、改名、继续讨论 | council.entry.integration.spec.ts |
| 5 真实争论 | 独立初稿屏障、真实来源、私有工具证据、针对性质疑与最多两轮补查 | Council独立投稿、native和重启回归 |
| 6 三个入口 | 今日、投研室、AI投资；移除新流程中的版本和发布管理 | 中英文、390px及宽屏浏览器验收 |
| 7 一次开启 | 真实持仓/明确现金起点、必要补充、独立账户与持续授权 | investment-policy.integration.spec.ts |
| 8 发现与编译 | 有来源的候选、证券核验、两来源复核、组合计划合并 | 真实服务链路的受控模型集成测试 |
| 9 持续运行 | 有租约与身份的研究周期、共享任务额度、已有快慢路由 | autonomous-research.integration.spec.ts |
| 10 总暂停与限制 | 全部自动买卖停止、禁卖包含保护退出、确认/撤销/到期、迟到结果拒绝 | policy、race和最终成交事务测试 |
| 11 AI投资页面 | 当前思路、行动、收益对照、当时依据、实际研究者、暂停恢复 | 客户端行为及交互夹具验收 |
| 12 判断回访 | 已核验观测或明确复查日期、原讨论回访、每日三项且共享预算 | research-followup.integration.spec.ts |
| 13 兼容切换 | 旧运行状态可见、明确接管、保存账本、关闭旧写入绕行 | simple-experience-migration.integration.spec.ts |
| 14 交付 | 全量测试、浏览器检查、双语文档、PR与CI | 最终检查记录见下方；真人试用另列 |

## 运行与切换

服务端`SQUABBLE_SIMPLE_EXPERIENCE=true`开启新入口；默认关闭以控制旧安装升级。仅阅读页面不会开户、接管、扩大权限或恢复自动交易。旧账户需明确确认接管，旧账本和历史报告继续保留。

本地验收实例使用独立空数据库，地址为http://127.0.0.1:3190。它不复制旧实例的资金、持仓、模型凭证或个人研究记录。用户可自行导入持仓及连接AI。付费执行链路测试使用虚构证券、隔离数据库和受控执行器；未使用个人模型会话。

升级验证从8e04fbc的原始基础SQL建立旧库，保留7股虚构持仓和启用中的12345模拟现金账户，再对新旧两种库分别重复应用31–33两次。1081列结构一致；旧持仓、现金和开关状态不变，没有自动生成父授权。

## 最终自动化检查

| 检查 | 实测结果 |
| --- | --- |
| 服务端全量回归（真实隔离PostgreSQL） | 677通过，0失败，0跳过；后续审查修复另跑专项，GitHub CI再次验证最终提交 |
| 最新投资、发现、预算与迁移专项 | 23通过，0失败，0跳过 |
| 客户端回归 | 224通过，0失败，0跳过 |
| 本地Agent完整覆盖，限制测试进程并发 | 167通过，0失败，1项POSIX平台场景在Windows跳过 |
| 开发启动与进程清理 | 8通过，0失败，1项POSIX平台场景在Windows跳过 |
| 研究记忆评估 | passed；99项操作回归通过，0失败、0跳过 |
| Lint、服务端/客户端类型、Stylelint | 通过 |
| Web生产构建 | 通过 |
| 中英文、390px及1440px浏览器 | 通过；真实空工作区只读检查与虚构数据交互测试分别执行 |
| 新旧基础SQL升级及重复迁移 | 1081列一致，旧持仓、运行状态与资金保存，未静默授权 |

审查后专项覆盖旧股票任务迟到、无当前指针的读取回退、首次打开与定时日报共享预算、组合日期上下文、长判断回访、原持仓单来源复核、股友更换、六任务额度下的实际成交以及旧MCP身份。两轮独立审查的重要问题均已修复。

连接恢复专项还覆盖同一市场阶段连接AI后自动继续、较旧完成任务不阻止较新等待恢复、已完成的新任务不复活旧等待。未领取付费任务的连接等待可以复用原身份；已付费或不确定的工作不会重放，独立来源变化使用新的研究身份。

本地Agent的并行运行曾在多套测试同时执行时触发一个CLI发现夹具超时；限制测试进程并发后完整覆盖通过，未放宽生产限制或删减断言。运行日志保存在本地被忽略的logs目录，不含个人模型响应或凭证。合入必须等待GitHub要求的Lint & typecheck、Agent tests、Docker image build全部通过。

## 实际限制与真人验收

- 首版只在原币可用现金内交易，不自动换汇；缺少可验证行情、证券身份、资金或交易单位时等待。
- 普通股票须通过供应商身份和报价核验。ETF还需可靠发行人资料证明普通、非杠杆、非反向属性；当前默认发行人核验覆盖SPY，其他未知ETF会被排除，不能仅凭名称或报价判定。
- 固定供应商本地CLI可以证明实际执行来源；未报告的底层模型名明确保持未知。模型聚合客户端缺少来源映射时不能充当已核实的第二来源。多来源不代表统计独立或正确性保证。
- 服务器离线不补造交易；恢复按当前资料重新评估。收益默认对照相同起点持仓保持不动，缺失边界或公司行动对账时显示未知。
- 五位未参与设计者的真人可用性试用尚未进行。目标为至少四位在10秒找到持仓概况、30秒从股票提问；浏览器自动化与AI审查均不冒充真人通过。

## English verification notes

The three-entry web experience preserves historical ledgers and immutable pre-trade evidence. Daily first-open and scheduled research share a durable task identity and automatic budget. Superseded stock generations cannot replace newer conclusions through either publication or read fallback. Native Codex research disables unrelated MCP servers, apps, plugins and hooks, including text-only tasks.

Autonomous execution remains paper-only and subject to confirmed markets, assets, native-currency cash, risk limits and the final transaction fence. Pausing stops protective exits too. Unknown ETF attributes remain excluded; the default positive issuer adapter currently covers SPY. Automated browser checks used fictional fixtures; the five-person usability study remains pending human validation.
