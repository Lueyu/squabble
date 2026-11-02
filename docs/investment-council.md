# 🗣️ Investment council and research room

[简体中文](investment-council.zh-CN.md) · [Documentation](README.md) · [Privacy](privacy.md)

Build a small research team in **Agent Builder**, discuss a stock in the **Research room**, and keep each conclusion with its evidence. An enabled council also reviews candidates produced by your active paper strategy. It does not connect to a broker or execute real trades.

## Configure the team

Each member now has two execution choices. **Local agent · A2A** delegates the brief to a registered A2A 1.0 JSON-RPC agent; Squabble manages routing, task progress, user steering and report storage, while the agent uses its own tools. **Model API · built-in research** keeps the existing direct-model workflow and Squabble's data collectors. New independent rooms prefer connected local agents; existing profiles and rooms retain their saved configuration. You can explicitly delegate an existing team while preserving its roles.

The repository includes a local **Codex CLI bridge**. Other A2A 1.0 peers can be registered, but a native Claude CLI adapter is not bundled. The operator registers trusted endpoints and exact account access; the web page cannot execute arbitrary commands or register arbitrary localhost URLs. Start with [local agent setup](local-agents.md). Local runtime does not mean offline inference. A2A agents currently require the Squabble research budget to be off; the agent/provider manages its internal spending, and missing usage is displayed as unknown.

Choose **2–6 members**, including exactly one moderator/manager. Seven templates cover value, growth, risk, technicals, news, macro and moderation. The default three-person team works as follows:

| Member | Job | Direct-model default tier |
|---|---|---|
| Researcher | Build a case from the available evidence. | Fast |
| Challenger | Test the researcher's claims, cite contrary facts and ask questions. | Fast |
| Portfolio manager | Summarize agreements, disagreements and next checks; assess an exact trade candidate only when one is attached. | Slow |

Customize names, role titles, personality, research focus, speaking style and an additional prompt. In direct-model mode, each member selects the default model connection or a separately saved connection and its fast/slow model. **Settings → Team model connections** supports up to eight extra OpenAI-compatible public HTTPS connections. Credentials are encrypted server-side and never copied into room configuration. A missing connection stops that member instead of silently switching credentials.

The default discussion has four sequential turns: research → challenge → response → summary. Larger teams add viewpoints before the response and summary. Members see previous contributions, user steering and cited facts. Direct-model members can request bounded financial, valuation, news, price or optional web research; A2A members research in their own runtime. Permissions and trade direction/size remain outside persona prompts. Expand a message to read its **public rationale**, questions and sources; this is not the model's private chain of thought.

Each direct-model request waits up to two minutes and does not automatically retry transport failures. A timed-out request may still be billed; its reservation remains counted. Explicitly continue from the retained turn after checking the provider. A2A execution instead follows the remote task lifecycle, persists task/context IDs, polls progress and collects artifacts. Pausing requests cancellation; a remote runtime may already have spent tokens. Ambiguous dispatch is not blindly replayed. Sources returned by an external agent are recorded as agent-provided evidence, not automatically treated as verified financial data or trading approval.

The controls follow the useful separation of role/goals/tools in [CrewAI agents](https://docs.crewai.com/en/concepts/agents) and speaker selection/termination in [AutoGen group chat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html). Squabble implements its own bounded workflow; it does not add either framework as a runtime dependency. Role, personality and prompt shape the contribution; focus determines research preferences; concise/detailed/Socratic style shapes presentation. Tool permissions, stop conditions and shared spending caps stay outside persona prompts.

For a free starting point, turn off the council and leave custom AI review instructions empty. Basic analysis, public quotes and explicit investor-authored price rules can work without a model key. An enabled council needs each member's selected executor to be configured. In direct-model mode, opening a discussion without a model produces an honest basic **wait** report, without simulated AI member messages. A provider's “free” model is still subject to its own key requirements, availability, limits and pricing.

## Discuss and keep the report

1. Open **Research room**, enter a ticker, select a preset and customize the team. A saved Builder profile is optional; a standalone room never activates a strategy. Add your question in the chat.
2. Creating a discussion starts one research round. The central chat shows member replies; the composer stays at the bottom. The page polls for completed messages rather than streaming individual tokens.
3. Add your own view at any time. Sending a note after a completed round starts another bounded round, with the previous conclusions as context. During research, your note steers the current discussion within its existing budget. Enter sends, Shift+Enter adds a new line, and selecting Chinese input does not send accidentally. Paused or failed rooms require an explicit resume.
4. Pause when needed. A provider request already in flight may finish and incur usage, but a paused or obsolete revision cannot become current approval.
5. Reports are organized in the right sidebar (the Reports button on small screens). Open a version to read its conclusions, dissent, evidence and related report or paper-order links. Each discussion freezes the profile configuration and version; after editing the profile, start a new discussion to use that version.

A note can contain up to 2,000 characters; a discussion accepts up to 30 user notes. Completed turns and the next speaker are checkpointed in the database. An interruption continues from that point instead of replaying the whole round. Continuing or pausing does not reset the task budget. Bounded context goes to the model; full collected sources and user notes remain in the instance database. Standalone reports use positive, balanced or cautious assessments; they are not trade approvals. Open the members panel and create a new room to use a changed team.

The following collector behavior applies to **direct-model mode**. A2A members obtain research through their own runtime and return sources with their report.

For supported US stocks, a saved Finnhub key enables valuation metrics, recent company news and reported financial statements with filing dates and SEC references. Access and completeness depend on the endpoint and subscription; a successful connection test does not guarantee every field. Missing balance-sheet items, stale filings, unsupported markets, provider permissions and network errors are identified separately. Available facts remain in the report. Research-driven approval is withheld when critical evidence is missing. An explicitly configured price-rule candidate can be assessed as **rule-only**, with gaps disclosed; this is not an AI price forecast.

Incomplete US financial statements trigger a free SEC EDGAR fallback, checked against filing, currency and reporting period. Optional **web research** uses a saved DeepSeek connection and is off by default. Search is separately metered by the provider: at most two requests per task and twenty per UTC day. Web excerpts support discussion, but cannot become verified financial statements or bypass approval checks. See [research data and tools](research-data.md).

A new round collects current data; resuming an interrupted round retains its checkpoint and evidence. Each report retains its original snapshot. An unrelated portfolio or FX failure does not prevent stock research, although portfolio sizing remains unavailable. Task limits, daily limits, provider rate limits and account balance have separate remedies.

## How a conclusion can affect paper trading

The discussion's **Start**, **Continue**, **Pause** and message actions only affect research. They never place an order. A discussion created by hand has no executable candidate attached.

An active Builder scan first produces a deterministic candidate from the profile's rules. When council review is enabled, the service reviews that exact ticker, side, quantity and reference price. Only a current approval for that candidate and profile version can proceed to the normal paper-order checks. The transaction rechecks the current session revision, approval age, fresh quote, price movement, account state and risk/cadence limits. A used approval cannot fund another order. The approved report is linked to the resulting paper order when it is filled.

Waiting, rejected or unavailable results are cached for equivalent evidence and price regimes to avoid repeatedly paying to veto the same idea. A cached approval still requires the exact candidate and current revision. New information does not guarantee immediate automatic reruns: the scan cadence also applies. Any real trade remains a separate manual action at your broker.

## Default trading cadence

These settings apply to active Builder scans, including manually triggered scans. They complement the existing order-size, daily-count, daily-loss, cash and position checks.

| Limit | Default |
|---|---|
| Routine review interval | 5 weekdays |
| Orders | At most 2 in a rolling 7-day window |
| Same-ticker cooldown | 3 weekdays |
| Turnover | At most 10% of current paper equity in the rolling 7-day window |

The review interval uses each market's local date. Changed profile/research/position inputs can make a review due earlier, but automatic reviews are coalesced to at most one per profile and ticker per local day, including unsuccessful reviews. Weekly caps are account-wide, and pending approvals reserve capacity. “Trading days” currently means Monday–Friday; exchange holidays are not excluded. This is a low-frequency simulator, not a holiday-aware execution calendar.

## Budget and usage

The limits and reservation accounting below apply to **direct-model calls made by Squabble**. Standard A2A has no universal hard token-budget mechanism. Current external-agent dispatch therefore requires the research-budget switch to be off; timeouts and concurrency controls in the local bridge still apply. External reported usage can be recorded, while absent usage remains unknown. The selected agent's own credentials, billing and retention policies apply.

**Research budget** is in Settings. It is enabled by default. Turn it off to stop enforcing the app's input, token and call limits while retaining the usage ledger and saved limit values. Turning it back on restores those values, and already recorded usage still counts. Explicit per-request output parameters and provider limits and charges still apply. All council members and revisions in a discussion share one task identifier.

| Setting | Default |
|---|---:|
| Tokens per UTC day | 60,000 |
| Tokens per UTC month | 600,000 |
| Tokens per task | 24,000 |
| Input tokens per call | 6,000 |
| Output tokens per call | 1,000 |
| Calls per task | 8 |
| Calls per UTC day | 30 |

The server conservatively estimates input from UTF-8 bytes and reserves capacity for the request plus its output cap. This can stop a long prompt earlier than a provider's tokenizer would. Reported provider usage replaces the reservation when available; failures or missing usage retain the conservative reserved amount. In-flight and interrupted work therefore still counts. Daily and monthly periods reset at **UTC** boundaries; the task allowance does not reset with them. Budget caps stop later requests; they cannot undo a request already accepted or enforce a provider's billing system.

Optional input/output prices are your estimates in USD per million tokens. If either is absent, estimated cost stays unknown. The number shown is not a provider invoice and actual charges may differ. Screenshot recognition/OCR uses a separate path and is **not covered by this LLM budget**. This feature does not promise free or unlimited agent chat.

Users can change their own limits. These account budgets are not an operator-wide spending ceiling for a shared server API key. Operators should also set limits at the provider; all users' usage can accrue to that key.

## Storage and operation

For A2A members, the assigned brief and relevant conversation context are sent to the registered agent, whose runtime and selected provider also process that content. The bundled bridge persists task prompts and outputs locally. Keep that task directory private and apply your own retention policy; see [local agent setup](local-agents.md).

Messages, member preferences, frozen configuration, evidence snapshots and reports persist in the instance database. Each selected model provider receives bounded evidence, profile/candidate context, user notes and prior contributions. Optional DeepSeek Search receives the ticker and research query. Budget records keep task/model identifiers, usage, status and timestamps, not prompt bodies. Hosting operators can access their database and server secrets. See [Privacy and data flow](privacy.md).

The supported deployment remains a **single application instance**. Restarting it marks unfinished council sessions paused and invalidates their previous revision; it does not resume model work automatically. Startup recovery currently pauses all running council rows, so multiple live replicas are not supported as a durable job queue. Resume deliberately after a restart, remembering that previously reserved or spent task usage remains counted.
