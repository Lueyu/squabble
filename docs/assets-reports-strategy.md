# Assets, reports and investor strategies

This guide covers the opt-in simplified web experience (`SQUABBLE_SIMPLE_EXPERIENCE=true`). Existing advanced pages remain available outside that mode.

## 今日：先看资产，再看研究

总资产由持仓市值与已确认现金组成。卖出股票会减少股数、增加对应币种现金；入金与出金单独计入外部资金流。今日盈亏按市场上一交易日收盘价以及已记录的当日买卖、费用计算，与相对历史买入成本的浮盈分开。

首次使用时，在“核对现金”中确认各币种余额，确实没有现金可以明确填零。持仓截图只证明仓位，不会被猜成卖出成交或现金流水。缺少行情、昨收、汇率或现金确认时，首页显示已知资产与具体缺项，不将未知数填成零。展开“行情和汇率依据”可以分别看行情实际时间、读取时间、交易日和汇率日期。资产曲线从实际记录开始，不补造导入前的历史。

日常可快速记录买卖、入出金与费用，也可以在导入页选择成交或资金流水，上传 CSV、Excel 或截图。先核对证券、币种、数量、价格、费用、日期及重复项，再确认入账。旧于期初快照的成交需要对账，不能直接叠加到当前仓位。

## 报告：初版与讨论都留着

今日并列展示初版分析与最新完整讨论结论。历史入口按日期、主题和来源打开完整报告；继续讨论会引用当时的具体报告。每轮完整讨论也在原会话留下一张报告卡，下一轮失败不会删除上一轮结果。

持仓研究使用当时封存的全部持仓、各币种现金、已确认风险上限和记录时间，零现金与未知余额分别保留。资料过大而无法完整发送时会明确停止，不会把截断的组合当作完整输入。日报应逐项说明持仓判断、依据和下一步核验点，并单列现金、组合集中度及真实资料缺口；账面价格不等于最新行情。

会话展示 AI 实际回传的公开研究步骤、工具活动和来源。研究中展开当前步骤，完成后收为摘要，用户手动展开的部分保持展开。没有回传的内部思考不会被编造为进度。

已知的围栏 JSON、嵌套 `response` 等旧输出会转换为自然语言阅读内容，原始材料保留。无法辨认的输出显示内容整理待核对；本地重整不会重跑付费研究。历史档案与首页选取互相独立，讨论不能覆盖初版档案。

内容待整理时，首页仍提供已保存报告的阅读入口，不再显示“研究尚未完成”。每日团队研究与旧组合分析都可本地重新整理；可识别的旧失败记录会自动恢复。模拟复盘将历史快照中的收益、费用、执行限制和资料缺口显示为正文，缺失数字保持未知；原始快照仍可展开核对。

研究步骤失败且原任务已确定结束时，可选择“继续完成已有日报”。会先在本地核对已经返回但尚未通过校验的结果；只有需要新的完整资料补核验或汇总时才调用 AI，已有独立研究继续保留。“重新整理已有结果”仍只使用已保存资料，不调用 AI。原任务仍在运行或结束状态不确定时不能续发。若早期研究实际只收到部分持仓，报告会保留“输入补充与覆盖说明”，说明后续核验收到全量资料，早期研究仍不改称完整独立研究。

报告历史默认查看“每日研究”，也可切换“单股研究”“模拟盘账本复盘”或全部类型。模拟盘复盘说明账户估值和执行情况；持仓判断、事件与后续关注请看每日研究。零成交或净值未变不表示投资判断已被验证。

## 策略：一份当前总策略，草稿随时改

今日的“投资策略”可直接手写，也可从报告或投研室选择内容加入草稿。按股票填写条目和各自期限，保留对应来源。保存草稿不改变正在运行的策略；查看已确认策略时，先“复制为草稿”再修改。

加入报告时，只能选择真实可读正文或已通过校验的执行策略；“缺少执行策略”等占位说明和内部元数据不会成为可选策略。较长的研究正文会优先按段落拆成多条观察事项，保留原文及同一来源，不额外调用 AI，也不自动生成买卖指令。预览与保存使用相同的容量限制；如果来源或条目已满，界面会说明原因，可改选较小章节或另一份草稿。已验证的执行策略继续保留其提议期限、风险边界和待核对事项。

应用前整理并审阅执行说明：证券、触发条件、买卖动作、数量或交易后目标总仓位、期限、时区与资金上限。没有明确数量或额度的“适量加仓”等意见仍为观察事项；语义条件需要明确授权。目标仓位表示交易后的总持仓占比，不是每次追加该百分比。

点击“应用到模拟盘”后，正文和执行说明作为一个确认快照整体切换。旧候选和预留资金失效，迟到的 AI 结果不能使用旧授权成交。单条到期只停止该条，不自动清仓。草稿、确认历史和原始报告来源均可回看。

## AI 投资：复制起点，按确认策略运行

一键复制真实盘全部持仓与已记录现金，按币种核对一次；可以另加虚拟现金，只影响模拟盘。复制后两份账本独立，真实交易不会自动改动模拟盘。再次复制会保留旧账户与成交记录。

缺少可信行情也能建立观察账本，但不能交易或显示完整模拟收益率。首次可信估值形成独立的不可变起点；原始复制快照与历史买入成本作为参考保留。模拟收益从该起点计算，复制前的浮盈不算模拟业绩。

初始化估值与同一时刻的快照只算一次观测，此时期间收益与回撤保持未知。之后出现真实的估值时点，即使净值相同，也可计算已观测区间的零变化；这不能证明覆盖完整自然日。缺少估值时点、期初期末数据或策略切换时的估值，相关收益仍未知。旧复盘保留原始数值，并提示无法确认的时间覆盖范围。“模型与数据说明”集中展示一般限制，具体缺行情、汇率或监控区间另列为资料缺口。

确认策略后，明确条件直接检查执行；不确定条件交 AI 补判；大仓位或高风险交研讨室。新证券仍需两个不同的、已核验的实际执行来源，配置别名不能充当两个来源。全部路径经过行情、市场日历、现金、持仓、风险与当前策略授权校验。策略外机会只形成讨论或草稿，确认纳入前不能交易。

监控页提供净资产、今日变化、创建以来收益、当前策略、最近检查、等待原因和成交依据。同一起点保持不动的对照使用相同估值与现金边界。暂停停止所有自动买卖，包括保护性退出；恢复时核对当前条件，不补执行错过的订单。

## Upgrade and data behavior

- Back up the current database before upgrading. Startup applies additive migrations 37, 39–42; fresh installations include the same schema. The Docker runtime ships the entire migration directory.
- Duplicate cash rows are archived before enforcing one owner/currency row. Conflicting nonzero duplicates require reconciliation and are never summed blindly. Opening positions are checkpointed once; restarting does not checkpoint new trades or promote new unconfirmed cash.
- Existing holdings, transactions, completed trades, raw research and report archives remain available. Known legacy report sources are linked to their original discussion without replacing valid references.
- Legacy managed automatic accounts without an explicitly confirmed investor strategy pause on upgrade. In-flight candidates and reservations are cancelled; completed records remain. Review and apply a strategy before resuming.
- Saving a draft never switches execution. Applying checks the exact revision, reviewed content hash and current strategy atomically. API retries reuse request keys to avoid duplicate copies, cash additions or strategy applications.
- Free market data can be delayed or unavailable. Missing trustworthy inputs cause an explanation and waiting, rather than fabricated returns or an unsafe simulated fill. Local-agent and provider availability still depend on the user's configured connection.

## English usage summary

Today combines marked positions and confirmed cash, separating daily investment P&L from external funding. Review imported trades and cash flows before posting; holdings snapshots alone never imply cash movements. Initial analysis, each discussion report and their pinned sources remain readable in history.

Saved reports keep a reading link while formatting is pending. Daily team reports and legacy portfolio analyses can be reformatted locally without another model request; recognizable formatting failures recover automatically. Simulation reviews display archived returns, fees, execution constraints and data gaps as readable text, keeping missing figures unknown and preserving the original snapshot. This reading fix requires no database migration.

Research receives the complete frozen holdings, every recorded cash currency, confirmed investor limits and capture times; zero and unknown balances stay distinct. Oversized context stops explicitly instead of sending a partial portfolio. Daily research accounts for each holding, cash, concentration, supporting evidence, next checks and the effect of real information gaps. Stored marks do not establish fresh market prices.

After a daily step has ended, **Complete saved daily report** first validates a returned result that has not yet been accepted. It uses AI only when a new full-context check or summary is needed, preserving the independent work. Running or uncertain upstream tasks cannot be replayed. Earlier partial-input findings remain labelled as such in the report's input-supplementation and coverage explanation. **Reformat saved result** remains a separate local operation without a model call.

Report history defaults to daily research and distinguishes stock research from simulation ledger reviews. A ledger review records valuations and execution, while daily research provides holdings findings and next checks. An opening baseline and its same-instant snapshot are one observation, so initialization alone leaves period returns and drawdown unknown. Equal NAV at a later observed timestamp can establish a zero change for that interval; it does not establish full-day coverage or validate an investment judgment. Missing timestamps or strategy-boundary valuations remain explicit unknowns. General model/data notes appear once, separately from actual period gaps, and older archives retain their original figures with a coverage warning.

Write or import findings into one strategy workspace. Save drafts freely, then review the execution explanation and explicitly apply it to switch simulation authority. A paper account copies real positions and recorded cash once, optionally adding virtual cash. It observes until a trustworthy valuation exists and trades only within the confirmed strategy. Deterministic, AI and council paths share the same final execution guards. Strategy changes invalidate old work; expired entries stop without forcing a sale.

Report import offers readable research and validated execution plans, excluding missing-plan placeholders and internal metadata. Long research is split into observation entries, preferring paragraph boundaries while preserving its text and source. Import makes no additional AI call and does not infer trading instructions. Preview and save share the same source/entry capacity limits; an explanation lets you choose a smaller section or another draft when needed. Validated plans retain their proposed periods, risk limits and review requirements.
