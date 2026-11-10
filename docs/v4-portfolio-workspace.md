# V4 portfolio and companion workspace / 账户与股友工作区

## Independent accounts / 独立账户

The overview compares recorded real and simulation valuations without adding independent funds into a personal total. `period`, `metric` and `accounts` in the URL preserve comparison choices; account links also carry a safe return location. Missing observations still break lines. A lone observation displays its exact time rather than a fabricated multi-day date axis.

总览只比较已经记录的实仓与独立模拟仓估值，不把多仓资金合计为个人资产。时间范围、指标和账户选择保存在 URL；缺少估值仍断线显示，只有一个观测点时明确标记其时间。

## Four starting points / 四种起点

| Origin | Frozen input / 冻结内容 | Confirmation / 确认边界 |
| --- | --- | --- |
| `holdings` | Owner's real holdings and recorded cash / 本人的实仓数量和现金 | Rechecks the real source revision before creation / 创建前复核源修订 |
| `cash` | Explicit virtual amount and currency / 明确填写的模拟现金与币种 | Uses the stored preview / 使用已存预览 |
| `account` | Explicit owned simulation's current positions and total currency balances / 指定的本人模拟仓当前数量与分币种现金总额 | Source ledger captured in an owner/account transaction; later changes do not alter the preview / 事务冻结来源，之后不自动同步 |
| `custom` | Canonical security, positive quantity, optional reference cost and explicit cash / 规范证券代码、正数数量、选填参考成本与现金 | Server owns market/currency resolution and current quotes / 服务器解析市场、币种并读取行情 |

All four use the existing persisted investment preview and idempotent account creation flow. Current available quotes and dated FX establish the new baseline. Reference costs are preserved in the seed but never stand in for current prices. Missing quotes, FX or unconfirmed cash produce a waiting ledger and unknown initial valuation. There is no historical backtest, fabricated historical fill, source strategy copy, or source pending-order copy. An account begins paused and observes until the owner confirms a strategy combination. Opening inventory and cash retain the existing new-simulation semantics.

四种起点共用持久化预览与幂等创建链。参考成本仅留档；新起点使用当前可用行情与有日期的汇率。资料缺失时可以建立等待中的账本，初始估值保持未知。不会复制历史成交、策略或待执行订单，不声称历史回测。账户建立后先观察，明确确认策略组合后才运行；期初持仓和现金沿用既有独立模拟仓语义。

The seed JSON adds optional `origin.kind` provenance: `real_holdings`, `cash`, `simulation_account` or `custom_holdings`. A copied account also records source account ID/name. Legacy seed JSON remains readable. Only real-holdings seeds participate in the existing real-source economic comparison; custom/copied accounts have `sourceChanged: null`. No schema migration is needed for the origin extension.

## Companion metadata / 股友呈现数据

Migration `47_portfolio_companions.sql` adds owner/account-scoped `portfolio_account_companions`. The explicit seven-value identity has its own revision and idempotency receipt; it never updates account balances, policy revisions, constraints, research members or execution settings. Old accounts remain unassigned until the owner chooses. Archived accounts reject new changes; a previously committed receipt can still be acknowledged. Cosmetic identity is not a claim that a persona is an independently configured research agent.

`PATCH /api/ai-investment/accounts/:accountId/companion` requires `companionId`, `expectedRevision`, and `requestKey`. Creation first acknowledges the new account, then saves its companion preference. If the second step fails, the UI keeps the acknowledged account and retries only the preference, even after the seed expires. Users can open the already-created account without repeating creation.

If the creation response itself is lost, the UI freezes the submitted name, seed and request key, then retries that exact receipt before allowing further edits. An explicit server rejection permits a fresh preview. This avoids turning a connection failure into an accidental second creation.

## Delete from the account list / 从列表删除股友

The small **Delete** action on each current companion card asks for one confirmation. It stops that account and removes it from the current list; its ledger, holdings, snapshots and reports remain readable under **Archived**. It does not create a replacement account or affect another account.

股友卡片的“删除”入口只确认一次。确认后停止该仓并移出当前列表；历史账本、持仓、估值与报告保留，可从“已归档”回看，不会创建新仓，也不影响其他账户。

`POST /api/ai-investment/accounts/:accountId/archive` requires `expectedPolicyRevision` and `requestKey`. Legacy accounts without a policy use an explicit `null` revision. Owner/account locks serialize archiving with the existing final execution fence; active automation, pending approvals and reservations for that account are stopped together. Replaying a committed receipt returns the same result. A failed or unconfirmed browser request keeps the card visible and retries the same intent until acknowledged.

## Integrations / 集成入口

`features/integrations/PaperIntegrationPanels.tsx` exports notification and MCP cards for Settings and the legacy paper terminal. `active` gates hidden settings queries and portal dialogs. No provider config value is used as a channel display label. Secret inputs are masked; the one-time MCP token displays only a suffix and an explicit copy button. Provider errors are not echoed where they might include credentials.

## Verification / 验证

Behavior tests cover four-origin request transport and validation, URL restoration after account navigation, companion retries after partial success/expiry, and secret masking. Disposable-Postgres integration tests cover account ownership, frozen copy independence, multi-currency valuation, request conflicts/replay, missing quote/FX/cash handling, and metadata independence from ledger/policy authority.

- Client: `account-starting-points.test.cjs`, `companion-creation-flow.test.cjs`, `portfolio-comparison.test.cjs`, `portfolio-workspace.test.cjs`, `portfolio-history-flow.test.cjs`, `integrations-reachability.test.cjs`. Deletion tests cover cancellation, retry without optimistic removal, legacy revisions and archived-list recovery.
- Server: `portfolio-seeds.integration.spec.ts`, `portfolio-companions.integration.spec.ts`, `portfolio-archive.integration.spec.ts`, plus existing investment-policy, simulation-experiments and portfolio-workspace regression suites. Archive coverage includes owner isolation, preserved ledger/report data, idempotency and both final-execution lock orders. Set `STRATEGY_TEST_DATABASE_URL` to a dedicated disposable test database; skipped integration tests are not a pass.
