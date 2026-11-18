# My agents and automatic teams

Start by importing your holdings. Connect a local agent or a model API in Settings, then use your existing agents to create a paper team. Open the research room later when you have a specific question.

## Getting started

Review your recorded holdings and cash on the Holdings page. Team setup reviews positions, cash and snapshot time before creating an independent paper account. Missing inputs must be completed first; opening prices prefer live quotes and otherwise fall back to the holding's recorded price, so a temporarily unavailable public quote does not block team creation. Later changes to real holdings never overwrite that paper ledger.

Connect your model service or installed local assistant once. Agents reuse that connection. Saving and checking a model connection explicitly sends one short, potentially billable request; adding agent profiles does not invoke a model.

The specialty catalog covers twelve disciplines — financials, valuation, counterpoint (bear), risk, moderation, business fundamentals, industry, growth, macro, events, quantitative and portfolio — and the friend library recommends whichever of them you do not own yet. Every agent has a stable identity, chosen animal avatar, specialty and immutable capability versions. Different people sharing a model remain distinct. The editor saves working instructions and response preferences used in research; recommended agents created in English use English templates. Changing identity fields such as name, description or avatar updates the profile without creating a capability version. Changing instructions, preferences, executor or source/tool ceilings creates a new version; existing published teams retain their pinned version until explicitly updated. Advanced source/tool declarations are ceilings, not live grants.

The roster, team selection and research selection display the same person. New conversations and team commissions freeze the person's name and animal avatar alongside their selected version; later profile edits do not rewrite existing conversations or commissions. Historical snapshots without an avatar retain their compatible role fallback.

Personal, conversation and team memories are separate. You can save a note or explicitly share a selected item with an existing team. Sharing retains provenance and all original source restrictions. It never copies another team’s history or grants a revoked/deleted source.

Archiving prevents new selection and paid dispatch. Already-dispatched work may settle under its pinned version and still-valid permissions. Team pause and source/connection revocation continue to block late publication or application. History remains readable.

## Creating and operating a team

1. Open "New team" and pick an organization template (11 starting templates, including the default `classic` investment-research team), start blank, or copy an existing published version. Review the frozen real positions and editable virtual opening cash, defaulting to CNY10,000, USD10,000 and HKD10,000. Each creation makes a separate paper account; real cash is replaced by these virtual balances and the real ledger stays unchanged.
2. Creation opens the run overview with actionable staffing, publication and paper-account steps. Review suggested existing friends or choose each seat explicitly; creating an account returns to this team for binding. The advanced canvas and structural work-plan preview remain available; saving does not dispatch models or place trades.
3. Publish an immutable version, retrieve the server run preview, review its actual agents, account, budget and timing, then confirm startup. Legacy guided setup (`?guided=1`) still resumes an in-flight request; published teams without a blueprint keep their legacy division until you explicitly establish a standard division and republish.

Research has no team-specific money, daily-call or monthly-call ceiling by default. You can set a daily USD ceiling before startup; each run then reserves at most that amount. Per-run call counts remain finite and follow the published plan, with a minimum of eight. Unbounded reservations are recorded as unknown rather than zero; changing to a finite period ceiling cannot treat earlier unknown costs as free. Existing account/global limits still apply.

Startup authorizes recurring research, system adoption and replacement of the paper combination within account risk rules. An optional immediate first run uses the same durable cycle and budget checks; pause/resume, retries and restart do not repeat it. Existing agreements without this option keep their scheduled behavior. Subsequent research runs one hour after the main market closes, at most once per market-local date. Paper execution continuously checks each instrument's trading session, prices, funds and risk constraints; an applied strategy is not proof of a fill.

The team overview shows status, recent work, members, budget and the paper account. Pause stops future research and all automatic paper trading, including protective orders. In-flight work retains its real cancellation, uncertain or settlement state. Changed versions or permissions may require fresh confirmation.

Native billing may be unknown while research is running normally. Unknown fees do not make execution uncertain or block the next authorized review. Explicitly uncertain task/attempt results still block new dispatch; their costs remain unknown and the original provider command is not resent.

The team commission's check-existing action can inspect the original native receipt; passive settlement currently supports native Codex only. It settles failed/cancelled work whose identity, scope and explicit original process termination evidence match, after the native task slot is released. It starts no research and does not refund unknown charges. Missing exit evidence, restart leftovers, Companion work, other providers and active tasks remain unresolved.

Setup retains editable fields across refreshes and visits to the roster in the same browser tab, partitioned by workspace identity. Interrupted requests retain their original keys and exact payloads. Restore and review the original setup to continue instead of creating another team. A resolved obsolete setup can end while preserving its created team, account and receipts; an unknown operation must be resolved first. Old unscoped tab progress is exposed only after every referenced resource is verified through owner-scoped APIs. These caches never grant server authority. Advanced organization editing and manual commissions remain available. Legacy seats can be linked to an existing agent or converted into a persistent profile before publishing; private history remains in its original team.

## Research, external agents and observability

Chat with one agent from its card, or choose several in the research room. The empty conversation shows the actual selected people. One person answers directly; a group has one moderator and a bounded ending. Follow-ups retain the discussion’s frozen agent versions. Team work links open that team's commission history. Budget limits are labelled as caps, separate from observed spending.

Investment overview (`/`) compares accounts; Holdings (`/holdings?accountId=real|id`) is a separate primary destination for the selected ledger. Simulation accounts (`/paper`) remain separate from persistent agents. Saving an import offers a next step to meet agents; starting research remains an explicit action.

External connections read a real A2A Agent Card. The current profile supports A2A1.0 JSON-RPC send, poll and cancel, without streams, push callbacks, remote interactive continuation or URL-artifact downloads. Structured team delivery requires actual verification; card claims alone are insufficient. Internal models, memory, tools and fees can remain unknown.

Local endpoints require both explicit user trust and exact card/RPC URL entries in deployment configuration `A2A_LOCAL_SERVICES_JSON`. Public endpoints use constrained address checks, pinned resolution and bounded responses; credentials are not forwarded across origins.

Run analysis filters by persistent agent/version, team/version, commission, work item and attempt. Different people sharing a model are separate. Configured and observed models are distinct; unsupported historical attribution stays unknown. Metadata export excludes prompts, responses, positions and credentials.

RSI and RL training are deferred. Stable identity, immutable versions, trajectories and explicit feedback provide extension points for later individual-agent evaluation and optimization. See the [implementation validation record](independent-agents-validation.md) and [UI repair validation](ui-regression-repair-validation.md) for measured evidence and remaining limits.
