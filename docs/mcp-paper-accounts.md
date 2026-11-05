# MCP paper experiment identity / MCP 模拟实验身份

`get_portfolio` returns the selected experiment's `accountId`. Pass that exact
value to the existing `place_paper_order` tool alongside ticker, side and
quantity. Missing or changed account IDs reject the request before execution.
After the user switches experiments, fetch the portfolio again and reassess the
candidate. Never automatically replay the old candidate against the new book.

`list_orders` returns only the selected experiment's history. All agent orders,
including pending orders approved by a person, retain fresh-quote, available
currency cash, share sellability, settlement and automatic risk checks.
Switching experiments stops prior automation and cancels pending approvals.
The final transaction reads the session's current status, trade permission and
approval mode. Its daily cash-spending limit includes adverse slippage, fees and
pending buys, and is scoped to the selected experiment's business-risk day.

`get_portfolio` 返回当前所选实验的 `accountId`。调用现有
`place_paper_order` 时，除股票、方向和股数外，必须原样传入该 ID。
缺少 ID 或实验已切换时，系统会在成交前拒绝请求。切换后重新读取持仓，
重新评估候选；不要把旧候选自动重放到新账本。

`list_orders` 仅返回当前实验的订单。所有代理订单（包括人工批准的待审订单）
均保留新鲜行情、原币可用现金、可售股数、结算及自动风控校验。
切换实验会停止旧自动化并取消未完成审批。
成交事务重新读取会话状态、交易权限和审批模式。每日现金支出额度包含不利滑点、
费用及待审买单，并使用当前实验的业务风险日。

Trading-unit rules were checked on 2026-11-05 against the
[SSE 2026 trading rules](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/c_20260424_10816482.shtml),
[SZSE main-board explanation](https://investor.szse.cn/knowledge/t20230308_599142.html)
and [HKEX trading FAQ](https://www.hkex.com.hk/Global/Exchange/FAQ/Securities-Market/Trading?sc_lang=en).
HK odd-lot matching uses a separate market and is not simulated. Unknown HK
board-lot metadata blocks execution. Corporate-action events reported by the
quote source after the account opens stop automation and require a reconciled
new seed; the free source is not a comprehensive real-time halt feed.

The cash model uses [US T+1](https://www.sec.gov/newsroom/press-releases/2024-62)
and [HK T+2](https://www.hkex.com.hk/Global/Exchange/FAQ/Securities-Market?sc_lang=en).
Model `paper-v1` freezes configurable per-fill fees and adverse slippage in the
opening seed (new real-account experiments default to 5 bps fees and 10 bps
slippage; legacy cash books retain their explicit zero model). Fees debit native
cash. SPY and QQQ are optional price-only market proxies using the same opening
USD NAV and period; missing quotes or period endpoints remain unknown. These
are paper assumptions, not estimates of a specific broker's executable returns.

Cash is conservatively released at the verified settlement day's market close.
US money settlement additionally skips the [Federal Reserve bank holidays](https://www.frbservices.org/about/holiday-schedules/)
on 2026-10-12 and 2026-11-11 even though equities trade. Unknown calendar years
block settlement-dependent execution until the calendar is renewed.

Only full market-order fills are simulated. Limit orders, partial fills, short
borrowing and margin are unsupported. 当前仅模拟整笔市价成交，不支持限价单、
部分成交、借券卖空和融资；缺少可验证的市场、行情或资产资料时会阻止成交。
