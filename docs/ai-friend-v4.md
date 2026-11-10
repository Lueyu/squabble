# AI 股友工作区 · AI companion workspace

This guide describes the V4 source implementation, not a deployment certificate. The approved visual reference is [Squabble V4 in Figma](https://www.figma.com/design/0dw4pcW4fkotFzqL7RxHLG?node-id=84-1221). The [implementation plan](superpowers/plans/2026-11-10-ai-friend-v4.md) records verification separately.

## 去哪里做什么

| 菜单 | 用途 | 地址 |
|---|---|---|
| 投资总览 | 大图查看实仓与多个模拟仓；选择时间、金额或收益率 | `/` |
| 我的股友 | 独立账户、动物股友、策略组合、持仓和成交 | `/paper` |
| 投资日报 | 同一天的个人账本、各股友成交与未执行情况、保存的研究 | `/daily` |
| 研究室 | 明确发起问题、继续频道讨论、读取研究记录 | `/research` |
| 资产与账本 | 实仓持仓、现金、交易、关注列表、导入 | `/holdings` |
| 数据中心 | 数据配置、导入批次与真实处理记录 | `/data` |
| 记忆 | 来源、论点、版本、确认与排除、实际提交记录 | `/memory` |
| 模型与设置 | 模型、本地 Agent、预算、通知渠道、MCP 等 | `/settings` |

详情页顶部提供返回；应用内进入时回到实际来源，直接打开详情时回到所属页面。返回会恢复筛选和滚动位置。带锚点的报告链接定位到相应段落。策略问答中的返回和保存退出固定在顶部；帮助与证据采用可关闭的阅读层。功能搜索支持 Ctrl/Cmd K。

## 从一句话到可核对策略

1. 从股友账户进入“一起聊出策略”，固定这次对话的目标账户。
2. 先保存想法，再逐步问清标的与方向、价格条件、数量或总仓位、频率和有效期。不要求一次说完。
3. 原话保留。助手提出的理解只有明确点击确认后才成为已确认条件；修改会保留历史并作废旧预览。
4. 核对规则和边界例子。例子用于检查阈值、重复执行和缺失信息，不是回测或收益预测。恢复草稿读取当时保存的预览，不会把观察项变成执行规则。
5. 加入该账户的组合草稿，新版本默认关闭。继续分配预算、核对组合并确认应用；这一步之前运行中的策略不变。

当前问答使用保守的本地解析，可确认股票代码、价格阈值、明确数量／总仓位、一次／每交易日最多一次和有效期。复杂估值判断、模糊简称或不完整条件会继续提问或留作观察；没有伪装成任意自然语言自动交易。策略原有模型整理仍是独立的明确操作。严格“小于”和“小于或等于”使用不同规则，最终下单也重新校验。旧规则缺少频率时仍只执行一次。

已发送对话保存在服务器；未发送文字暂存在当前浏览器会话。网络结果不明确时保留原请求身份，避免重试重复提交。规则、账户政策或组合发生变化时需要重新核对。

## 独立模拟实验

动物形象保留原有 SVG；价值、成长、趋势、风险、事件、宏观和多元思考是可选择的理念入口。形象独立于执行授权，选择形象不会自行安装策略或改变账户风控。

四种起点均需先预览再创建：模拟现金、复制真实持仓、复制已有模拟仓、自定义持仓。复制的是确认的冻结起点，源账户之后的交易不会自动同步。自定义成本是参考资料；当前可用行情和汇率用于建立新起点，不把参考成本冒充市场价格，也不假装历史回测。资料不完整时显示缺口。

各仓独立资金和运行状态；一个账户内的策略共享账本，预算是敞口上限，不自动再平衡。总览保留不同起点，缺失估值断线；没有足够连续可信观察时不生成收益率。实仓和模拟仓资金不相加。

## 日报、数据与记忆

日报区分当前保存账本的只读投影与已封存的研究版本。成交以真实成交记录归日，委托未执行以其保存状态解释。估值、币种、费用和日界存在缺口时显示未知；没有把未产生委托的观察伪装成成交失败。详见[日报和记忆契约](v4-daily-and-memory-workspace.md)。

在日报点击“生成总体总结”，才会使用配置好的研究成员，依次独立分析、反向核查并封存总结。输入包括所有独立模拟仓当日结果、失败和缺口、个人账本，以及最多五份可追溯的历史持仓输入。历史资料不足会明确说明，不用今天持仓冒充过去。总体报告与原个人日报分开保存；生成不会自动启用任何交易策略，模型不可用或额度不足会保留失败状态。

记忆可以看到出处、当前版本、确认和排除状态，并查看实际任务中提交了哪些记录。“已提交给模型”不等同于模型实际采纳。旧频道偏好仍按原接口只读显示；可编辑与排除的是研究论点及其版本。数据中心展示实际配置与批次，不把已配置等同于联网健康。

## English usage notes

The eight destinations separate overview, companions, daily reports, research, recorded assets, data, memory and settings. Details retain their originating route and scroll position; direct links have a stable parent fallback. Strategy conversations keep save/return controls visible and store accepted answers with their original wording.

Clarification is conservative and explicit: security/side, price condition, position or quantity, frequency and effective dates. Unsupported intent remains a question or observation. Saved rule examples are boundary checks, not backtests. Editing an answer invalidates its prior review; restoring a saved observation never silently upgrades it to executable authority. A reviewed strategy is staged disabled in the selected account's draft and still needs combination review and explicit application.

Simulation starting points can use virtual cash, recorded real holdings, an owned simulation or custom positions. Confirmed previews freeze inputs; later source changes do not synchronize. Persona changes are presentation preferences, not trading permissions. Real and simulated assets remain separate, and missing valuations remain unknown. Daily ledger facts and archived research keep distinct timestamps and meanings. Memory displays source/version and submitted inventories without claiming unmeasured model adoption.

An explicit overall-daily generation action freezes all companion results plus personal saved facts and up to five historical portfolio inputs. It reuses independent research, reverse checking and immutable publication, preserving errors, differing start points and missing history. Browsing the report triggers no model work, and overall publication neither installs a strategy nor executes an order.
