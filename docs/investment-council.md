# 🗣️ Investment council and research room

[简体中文](investment-council.zh-CN.md) · [Documentation](README.md) · [Privacy](privacy.md)

Build a small research team in **Agent Builder**, discuss a stock in the **Research room**, and keep each conclusion with its evidence. An enabled council also reviews candidates produced by your active paper strategy. It does not connect to a broker or execute real trades.

## Configure the team

Each member has two execution choices. **Local agent** delegates the brief to a supported native research agent installed on your computer; Squabble manages task progress, user steering and report storage, while the agent uses its own research tools. **Model API · built-in research** keeps the direct-model workflow and Squabble's data collectors. New independent rooms prefer connected local agents; you can also delegate an existing team while preserving its roles.

Open **Settings → Local research agents**. The desktop app detects supported native research agents automatically. Install a missing command-line app using its linked installation guide, select **Sign in** to complete the provider's login in a terminal, then select **Connect**. For local Docker, pair the Squabble desktop app from this settings panel: create a pairing, open the desktop app, and confirm the displayed local website address there. Keep the desktop app running while researching. The pairing link expires after five minutes and can be regenerated; Settings also lets you disconnect the desktop app. Only local addresses (`localhost`, `127.0.0.1` or `[::1]`) can be paired. See [local agent setup](local-agents.md).

Local agents use their existing provider account and model configuration; local execution does not mean offline inference or free usage. **You can keep the research budget enabled.** It applies to model API members, including those in mixed teams. Local agents are billed by their providers, and missing token usage stays unknown. Older teams using retired connection IDs need a supported native agent reconnected and selected; their historical reports remain readable.

Choose **2–6 members**, including exactly one moderator/manager. Seven templates cover value, growth, risk, technicals, news, macro and moderation. The default three-person team works as follows:

| Member | Job | Direct-model default tier |
|---|---|---|
| Researcher | Build a case from the available evidence. | Fast |
| Challenger | Test the researcher's claims, cite contrary facts and ask questions. | Fast |
| Portfolio manager | Summarize agreements, disagreements and next checks; assess an exact trade candidate only when one is attached. | Slow |

Customize names, role titles, personality, research focus, speaking style and an additional prompt. In direct-model mode, each member selects the default model connection or a separately saved connection and its fast/slow model. **Settings → Team model connections** supports up to eight extra OpenAI-compatible public HTTPS connections. Credentials are encrypted server-side and never copied into room configuration. A missing connection stops that member instead of silently switching credentials.

The default discussion has four sequential turns: research → challenge → response → summary. Larger teams add viewpoints before the response and summary. Members see previous contributions, user steering and cited facts. Direct-model members can request bounded financial, valuation, news, price or optional web research; local agents use their own research tools and web search. The team's model API web-search switch does not control those native tools. Permissions and trade direction/size remain outside persona prompts. Expand a message to read its **public rationale**, questions and sources; this is not the model's private chain of thought.

Each direct-model request waits up to two minutes and does not automatically retry transport failures. A timed-out request may still be billed; its reservation remains counted. Explicitly continue from the retained turn after checking the provider. Native execution persists the task before launch, reports bounded progress and saves its result. Each provider runs at most one task at a time, with a ten-minute task timeout. Pause or disconnect requests cancellation of the local process tree; when using Docker, the connected desktop app receives that cancellation through its polling connection. An offline app's work is interrupted when its execution lease expires. Already accepted provider work may still incur charges. Uncertain or interrupted native tasks are never automatically replayed. Sources returned by a local agent are recorded as agent-provided evidence, not automatically treated as verified financial data or trading approval.

The controls follow the useful separation of role/goals/tools in [CrewAI agents](https://docs.crewai.com/en/concepts/agents) and speaker selection/termination in [AutoGen group chat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html). Squabble implements its own bounded workflow; it does not add either framework as a runtime dependency. Role, personality and prompt shape the contribution; focus determines research preferences; concise/detailed/Socratic style shapes presentation. Tool permissions, stop conditions and shared spending caps stay outside persona prompts.

For a free starting point, turn off the council and leave custom AI review instructions empty. Basic analysis, public quotes and explicit investor-authored price rules can work without a model key. An enabled council needs each member's selected executor to be configured. In direct-model mode, opening a discussion without a model produces an honest basic **wait** report, without simulated AI member messages. A provider's “free” model is still subject to its own key requirements, availability, limits and pricing.

## Discuss and keep the report

1. Open **Research room**, enter a ticker, select a preset and customize the team. A saved Builder profile is optional; a standalone room never activates a strategy. Add your question in the chat.
2. Creating a discussion starts one research round. The central chat shows member replies; the composer stays at the bottom. The page polls for completed messages rather than streaming individual tokens.
3. Add your own view at any time. Sending a note after a completed round starts another bounded round, with the previous conclusions as context. During research, your note steers the current discussion; model API calls remain within their existing task budget. Enter sends, Shift+Enter adds a new line, and selecting Chinese input does not send accidentally. Paused or failed rooms require an explicit resume; the native-task recovery limits below still apply.
4. Pause when needed. A provider request already in flight may finish and incur usage, but a paused or obsolete revision cannot become current approval.
5. Reports are organized in the right sidebar (the Reports button on small screens). Open a version to read its conclusions, dissent, evidence and related report or paper-order links. Each discussion freezes the profile configuration and version; after editing the profile, start a new discussion to use that version.

A note can contain up to 2,000 characters; a discussion accepts up to 30 user notes. Completed turns and the next speaker are checkpointed in the database. Continuing preserves those turns rather than replaying the whole round. An interrupted or cancelled native invocation is not submitted again by resuming; review the retained state before deliberately starting a new discussion if needed. Continuing or pausing does not reset model API task usage. Bounded context goes to the selected executor; full collected sources and user notes remain in the instance database. Standalone reports use positive, balanced or cautious assessments; they are not trade approvals. Open the members panel and create a new room to use a changed team.

The following collector behavior applies to **direct-model mode**. Local agents obtain research through their native tools and return sources with their report.

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

The limits and reservation accounting below apply to **model API calls made by Squabble**. Keep the research-budget switch enabled when using local agents: model members in mixed teams still follow these limits, while supported native research agents use their provider's account, billing and retention policies. Native tasks have separate timeout and concurrency limits. Reported native usage can be recorded, but absent usage remains unknown rather than zero and does not reserve or consume this model API budget. Connecting an agent never changes the budget switch.

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

For local-agent members, the assigned brief and relevant conversation context are sent to the native application and its selected provider. Native credentials stay with the provider's installed app; Squabble does not copy them into model API settings. The server persists task prompts, progress and results in its private local-agent data directory, or the dedicated Docker volume. The desktop helper also keeps its connection credential and task journal locally. Keep these directories and their backups private; local administrators can access them. See [local agent setup](local-agents.md).

Connections and tasks are scoped to the signed-in Squabble account. A native runtime is claimed by one application account; another account cannot access its jobs. Desktop pairing requires a single-use, expiring code and confirmation of the local website address in the desktop app. The server stores a hash of the helper credential, and the helper stores its credential locally. The helper makes outbound requests to the paired local app; it does not expose a host listening port. Disconnecting the helper revokes its access and cancels its pending work.

Messages, member preferences, frozen configuration, evidence snapshots and reports persist in the instance database. Each selected model provider receives bounded evidence, profile/candidate context, user notes and prior contributions. Optional DeepSeek Search receives the ticker and research query. Budget records keep task/model identifiers, usage, status and timestamps, not prompt bodies. Hosting operators can access their database and server secrets. See [Privacy and data flow](privacy.md).

The supported deployment remains a **single application instance**. Restarting it marks unfinished council sessions paused and invalidates their previous revision; it does not resume model work automatically. Native task recovery marks unfinished jobs interrupted and never redispatches them; completed results remain available. Startup recovery currently pauses all running council rows, so multiple live replicas are not supported as a durable job queue. Review the retained state after a restart, remembering that previously reserved model usage or provider charges remain counted.
