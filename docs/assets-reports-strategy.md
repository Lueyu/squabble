# Assets, reports and investor strategies

This guide covers the current web experience, enabled by default unless explicitly disabled. The overview is `/`, research is `/analysis`, and independent simulations are `/paper`. Retained advanced pages remain available outside that mode.

## 总览：比较真实资产与多个模拟仓

在持仓页点击“复制到模拟盘”，当前模拟盘页面会自动打开实盘持仓与现金的复制预览，并显示正在读取、失败原因或重试入口。先核对新起点并为账户命名，确认后建立独立副本；已有账户继续保留和运行，预览或取消不会切换执行状态。复制后的真实交易不自动同步，行情或汇率缺项保持未知，不会补造估值。

Choose **Copy to simulation** from Holdings to open the starting-point preview in the current simulation page. Loading, errors and retry are visible. The confirmed action creates a named independent simulation while existing accounts keep their ledgers and execution state. Previewing or cancelling does not switch accounts; later real trades do not sync, and missing quotes or FX remain unknown.

总资产由持仓市值与已确认现金组成。卖出股票会减少股数、增加对应币种现金；入金与出金单独计入外部资金流。今日盈亏按市场上一交易日收盘价以及已记录的当日买卖、费用计算，与相对历史买入成本的浮盈分开。

各币种现金余额须经明确核对，确实没有现金时记录零。持仓截图只证明仓位，不会被猜成卖出成交或现金流水。缺少可信行情、汇率或现金确认时，总览保留估值与收益缺口，不将未知数填成零。资产曲线从实际记录开始，不补造导入前的历史。

日常可快速记录买卖、入出金与费用，也可以在导入页选择成交或资金流水，上传 CSV、Excel 或截图。先核对证券、币种、数量、价格、费用、日期及重复项，再确认入账。旧于期初快照的成交需要对账，不能直接叠加到当前仓位。

总览曲线只读取已保存估值，可比较净资产或收益，并选择账户与期间。缺失日期断开曲线，不补造导入前或停机期间的数据。收益需要至少两次可信观测；实际资金流、现金或持仓基线变化会使之后的收益未知，净资产记录仍可查看。不同账户显示各自的实际观测起点，不能把不同起点当作同一完整期间。当前收益方法不等于资金流调整后的时间加权收益率。

The overview uses saved observations only. Missing dates break the line, and returns require two trusted observations with unchanged cash-flow and baseline identity. Each account exposes its own return origin. This is not a cash-flow-adjusted time-weighted return, and allocation budgets do not establish independent per-strategy performance.

## 报告：初版与讨论都留着

研究报告页展示最新完整报告，初版分析与较早讨论结论保留在历史入口，按日期、主题和来源打开；继续讨论会引用当时的具体报告。每轮完整讨论也在原会话留下一张报告卡，下一轮失败不会删除上一轮结果。

持仓研究使用当时封存的全部持仓、各币种现金、已确认风险上限和记录时间，零现金与未知余额分别保留。资料过大而无法完整发送时会明确停止，不会把截断的组合当作完整输入。日报应逐项说明持仓判断、依据和下一步核验点，并单列现金、组合集中度及真实资料缺口；账面价格不等于最新行情。

会话展示 AI 实际回传的公开研究步骤、工具活动和来源。研究中展开当前步骤，完成后收为摘要，用户手动展开的部分保持展开。没有回传的内部思考不会被编造为进度。

已知的围栏 JSON、嵌套 `response` 等旧输出会转换为自然语言阅读内容，原始材料保留。无法辨认的输出显示内容整理待核对；本地重整不会重跑付费研究。历史档案与研究报告页选取互相独立，讨论不能覆盖初版档案。

内容待整理时，研究报告页仍提供已保存报告的阅读入口，不再显示“研究尚未完成”。每日团队研究与旧组合分析都可本地重新整理；可识别的旧失败记录会自动恢复。模拟复盘将历史快照中的收益、费用、执行限制和资料缺口显示为正文，缺失数字保持未知；原始快照仍可展开核对。

研究步骤失败且原任务已确定结束时，可选择“继续完成已有日报”。会先在本地核对已经返回但尚未通过校验的结果；只有需要新的完整资料补核验或汇总时才调用 AI，已有独立研究继续保留。“重新整理已有结果”仍只使用已保存资料，不调用 AI。原任务仍在运行或结束状态不确定时不能续发。若早期研究实际只收到部分持仓，报告会保留“输入补充与覆盖说明”，说明后续核验收到全量资料，早期研究仍不改称完整独立研究。

报告历史默认查看“每日研究”，也可切换“单股研究”“模拟盘账本复盘”或全部类型。模拟盘复盘说明账户估值和执行情况；持仓判断、事件与后续关注请看每日研究。零成交或净值未变不表示投资判断已被验证。

## 策略：每仓独立组合，草稿随时改

每仓策略组合可复用策略库中的多个策略，也可手写或从报告选择确切来源加入草稿。报告导入先选择目标账户，新增配置默认停用，尚未授予交易权限。按股票填写条目和各自期限，保留对应来源。保存草稿不改变正在运行的策略；查看已确认策略时，修改后保存为新草稿，再核对并应用。

加入报告时，只能选择真实可读正文或已通过校验的执行策略；“缺少执行策略”等占位说明和内部元数据不会成为可选策略。较长的研究正文会优先按段落拆成多条观察事项，保留原文及同一来源，不额外调用 AI，也不自动生成买卖指令。预览与保存使用相同的容量限制；如果来源或条目已满，界面会说明原因，可改选较小章节或另一份草稿。已验证的执行策略继续保留其提议期限、风险边界和待核对事项。

应用前整理并审阅执行说明：证券、触发条件、买卖动作、数量或交易后目标总仓位、期限、时区与资金上限。没有明确数量或额度的“适量加仓”等意见仍为观察事项；语义条件需要明确授权。目标仓位表示交易后的总持仓占比，不是每次追加该百分比。

在账户组合中设定启用状态与预算，核对预览后明确应用。启用预算总计不超过 100%；预算是现金保留额之外的归属风险上限，不是自动调仓指令。相同证券的重叠方向或目标冲突会阻止应用。当前仅该账户组合整体切换，保留不可变策略和组合修订；仅该仓旧候选和预留资金失效，迟到的 AI 结果不能使用旧授权成交。单条到期只停止该条，不自动清仓。草稿、确认历史和原始报告来源均可回看。

## AI 投资：复制起点，按确认策略运行

一键复制真实盘全部持仓与已记录现金，按币种核对一次；可以另加虚拟现金，只影响模拟盘。复制后两份账本独立，真实交易不会自动改动模拟盘。再次复制会保留旧账户与成交记录。

缺少可信行情也能建立观察账本，但不能交易或显示完整模拟收益率。首次可信估值形成独立的不可变起点；原始复制快照与历史买入成本作为参考保留。模拟收益从该起点计算，复制前的浮盈不算模拟业绩。

初始化估值与同一时刻的快照只算一次观测，此时期间收益与回撤保持未知。之后出现真实的估值时点，即使净值相同，也可计算已观测区间的零变化；这不能证明覆盖完整自然日。缺少估值时点、期初期末数据或策略切换时的估值，相关收益仍未知。旧复盘保留原始数值，并提示无法确认的时间覆盖范围。“模型与数据说明”集中展示一般限制，具体缺行情、汇率或监控区间另列为资料缺口。

确认策略后，明确条件直接检查执行；不确定条件交 AI 补判；大仓位或高风险交研讨室。新证券仍需两个不同的、已核验的实际执行来源，配置别名不能充当两个来源。全部路径经过行情、市场日历、现金、持仓、风险与当前策略授权校验。策略外机会只形成讨论或草稿，确认纳入前不能交易。

账户详情提供净资产、今日净资产变化、策略组合、持仓、订单和风险边界；曲线收益按实际观测区间显示。暂停只停止选定账户的全部自动买卖，包括保护性退出；其他账户继续运行。调度启用时，暂停仓仍尝试更新估值。恢复时核对当前条件，不补执行错过的订单。频道的规则和成交保留账户、原策略与条目身份。

## Upgrade and data behavior

- Back up the current database before upgrading. Startup applies the current ordered migration list in [`server/common/platform/database.provider.ts`](../server/common/platform/database.provider.ts); fresh installations include the same schema. The Docker runtime ships the entire migration directory.
- Duplicate cash rows are archived before enforcing one owner/currency row. Conflicting nonzero duplicates require reconciliation and are never summed blindly. Opening positions are checkpointed once; restarting does not checkpoint new trades or promote new unconfirmed cash.
- Existing holdings, transactions, completed trades, raw research and report archives remain available. Known legacy report sources are linked to their original discussion without replacing valid references.
- Legacy managed automatic accounts without an explicitly confirmed investor strategy pause on upgrade. In-flight candidates and reservations are cancelled; completed records remain. Review and apply a strategy before resuming.
- Saving an account combination draft never switches execution. Applying checks account/policy revision, the saved combination hash, source revisions and availability atomically. Receipts scope retries to the account and full payload. Confirmed strategy history cannot be deleted.
- Migration `45_portfolio_workspace.sql` adds account assignments and combination history, scopes profiles and preserves existing live authority. Historical migrations rerun at startup: migration 42 recognizes portfolio authority, and old index names retain scoped definitions so another restart cannot recreate owner singletons. Archived accounts do not reactivate. Legacy unscoped writes reject multiple accounts; managed-account guards remain.
- Free market data can be delayed or unavailable. Missing trustworthy inputs cause an explanation and waiting, rather than fabricated returns or an unsafe simulated fill. Local-agent and provider availability still depend on the user's configured connection.

## English usage summary

The daily path is **Portfolio overview → Research reports → Choose a simulation → Review and apply its combination → Account-labelled channel updates**. Report import saves a disabled account draft; it does not start execution. Create additional accounts without stopping existing ones, and pause each account independently. Confirmed strategy and combination history remain available. Changes only to reviewed periods or limits can reuse instructions without another AI extraction call. Partial/full paper fills stay distinct from suggestions and signals.

日常流程是“投资总览 → 研究报告 → 选择模拟仓 → 核对并应用组合 → 频道看该仓动态”。报告导入保存默认停用的账户草稿，不自动交易。新建仓不停止已有仓，暂停按仓独立生效，已确认策略与组合历史保留。仅修改已审阅期限或限额可复用条件，不额外调用 AI 抽取。部分与完整模拟成交须与建议、信号区分。

新日报若未能产生有效 AI 策略，会明确保留失败原因和系统观察计划，不编造买卖条件。已有历史报告保持原样。草稿删除使用增量迁移 `44_strategy_draft_deletion.sql`；已有安装启动时应用，真实持仓、现金和报告不因此修改。

The recorded-asset ledger combines marked positions and confirmed cash, separating daily investment P&L from external funding. Review imported trades and cash flows before posting; holdings snapshots alone never imply cash movements. Initial analysis, each discussion report and their pinned sources remain readable in history.

Saved reports keep a reading link while formatting is pending. Daily team reports and legacy portfolio analyses can be reformatted locally without another model request; recognizable formatting failures recover automatically. Simulation reviews display archived returns, fees, execution constraints and data gaps as readable text, keeping missing figures unknown and preserving the original snapshot. This reading fix requires no database migration.

Research receives the complete frozen holdings, every recorded cash currency, confirmed investor limits and capture times; zero and unknown balances stay distinct. Oversized context stops explicitly instead of sending a partial portfolio. Daily research accounts for each holding, cash, concentration, supporting evidence, next checks and the effect of real information gaps. Stored marks do not establish fresh market prices.

After a daily step has ended, **Complete saved daily report** first validates a returned result that has not yet been accepted. It uses AI only when a new full-context check or summary is needed, preserving the independent work. Running or uncertain upstream tasks cannot be replayed. Earlier partial-input findings remain labelled as such in the report's input-supplementation and coverage explanation. **Reformat saved result** remains a separate local operation without a model call.

Report history defaults to daily research and distinguishes stock research from simulation ledger reviews. A ledger review records valuations and execution, while daily research provides holdings findings and next checks. An opening baseline and its same-instant snapshot are one observation, so initialization alone leaves period returns and drawdown unknown. Equal NAV at a later observed timestamp can establish a zero change for that interval; it does not establish full-day coverage or validate an investment judgment. Missing timestamps or strategy-boundary valuations remain explicit unknowns. General model/data notes appear once, separately from actual period gaps, and older archives retain their original figures with a coverage warning.

Write or import findings into the reusable strategy library and stage them in a selected account combination. Save drafts freely, then review execution, budgets and conflicts and explicitly apply that account combination. A paper account copies real positions and recorded cash once, optionally adding virtual cash. It observes until a trustworthy valuation exists and trades only within the confirmed strategy. Deterministic, AI and council paths share the same final execution guards. Strategy changes invalidate old work; expired entries stop without forcing a sale.

Report import offers readable research and validated execution plans, excluding missing-plan placeholders and internal metadata. Long research is split into observation entries, preferring paragraph boundaries while preserving its text and source. Import makes no additional AI call and does not infer trading instructions. Preview and save share the same source/entry capacity limits; an explanation lets you choose a smaller section or another draft when needed. Validated plans retain their proposed periods, risk limits and review requirements.
