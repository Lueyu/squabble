# My agents and automatic teams

Start with three steps: **import holdings → meet your agents → create your team**. Open the research room later when you have a specific question.

## Getting started

Confirm holdings and cash on the overview. Team setup reviews positions, cash and snapshot time before creating an independent paper account. Missing inputs must be completed first; opening prices prefer live quotes and otherwise fall back to the holding's recorded price, so a temporarily unavailable public quote does not block team creation. Later changes to real holdings never overwrite that paper ledger.

Connect your model service or installed local assistant once. Agents reuse that connection. Saving and checking a model connection explicitly sends one short, potentially billable request; adding agent profiles does not invoke a model.

The recommended roster covers financials, valuation, challenge, risk and moderation. Every agent has a stable identity, chosen animal avatar, specialty and immutable capability versions. Different people sharing a model remain distinct. The editor saves working instructions and response preferences used in research; recommended agents created in English use English templates. Changing identity fields such as name, description or avatar updates the profile without creating a capability version. Changing instructions, preferences, executor or source/tool ceilings creates a new version; existing published teams retain their pinned version until explicitly updated. Advanced source/tool declarations are ceilings, not live grants.

The roster, team selection and research selection display the same person. New conversations and team commissions freeze the person's name and animal avatar alongside their selected version; later profile edits do not rewrite existing conversations or commissions. Historical snapshots without an avatar retain their compatible role fallback.

Personal, conversation and team memories are separate. You can save a note or explicitly share a selected item with an existing team. Sharing retains provenance and all original source restrictions. It never copies another team’s history or grants a revoked/deleted source.

Archiving prevents new selection and paid dispatch. Already-dispatched work may settle under its pinned version and still-valid permissions. Team pause and source/connection revocation continue to block late publication or application. History remains readable.

## Creating and operating a team

1. Keep the recommended collaboration and name the team.
2. Choose existing agents. The recommended template selects financials, challenge and moderation by default; valuation, defensive and full-research member templates swap the group in one click, and you can always adjust the checkboxes yourself.
3. Review the holdings copy, main market, budget and startup authorization, then start.

Defaults cap calls at8/run,16/day and320/month. A run reserves at most half the daily dollar limit; the monthly dollar limit is twenty daily limits. Existing account/global limits still apply. Larger teams may need a higher existing call allowance; setup does not increase it implicitly.

Startup authorizes recurring research, system adoption and replacement of the paper combination within account risk rules. Every cycle rechecks team version, binding, permissions, trading calendar and budgets. Research is scheduled one hour after the main market closes; paper execution separately respects each instrument’s trading session, prices, funds and risk constraints.

The team overview shows status, recent work, members, budget and the paper account. Pause stops future research and all automatic paper trading, including protective orders. In-flight work retains its real cancellation, uncertain or settlement state. Changed versions or permissions may require fresh confirmation.

Setup retains editable fields across refreshes and visits to the roster in the same browser tab, partitioned by workspace identity. Interrupted requests retain their original keys and exact payloads. Restore and review the original setup to continue instead of creating another team. A resolved obsolete setup can end while preserving its created team, account and receipts; an unknown operation must be resolved first. Old unscoped tab progress is exposed only after every referenced resource is verified through owner-scoped APIs. These caches never grant server authority. Advanced organization editing and manual commissions remain available. Legacy seats can be linked to an existing agent or converted into a persistent profile before publishing; private history remains in its original team.

## Research, external agents and observability

Chat with one agent from its card, or choose several in the research room. The empty conversation shows the actual selected people. One person answers directly; a group has one moderator and a bounded ending. Follow-ups retain the discussion’s frozen agent versions. Team work links open that team's commission history. Budget limits are labelled as caps, separate from observed spending.

Investment overview (`/`) compares accounts; Holdings (`/holdings?accountId=real|id`) is a separate primary destination for the selected ledger. Simulation accounts (`/paper`) remain separate from persistent agents. Saving an import offers a next step to meet agents; starting research remains an explicit action.

External connections read a real A2A Agent Card. The current profile supports A2A1.0 JSON-RPC send, poll and cancel, without streams, push callbacks, remote interactive continuation or URL-artifact downloads. Structured team delivery requires actual verification; card claims alone are insufficient. Internal models, memory, tools and fees can remain unknown.

Local endpoints require both explicit user trust and exact card/RPC URL entries in deployment configuration `A2A_LOCAL_SERVICES_JSON`. Public endpoints use constrained address checks, pinned resolution and bounded responses; credentials are not forwarded across origins.

Run analysis filters by persistent agent/version, team/version, commission, work item and attempt. Different people sharing a model are separate. Configured and observed models are distinct; unsupported historical attribution stays unknown. Metadata export excludes prompts, responses, positions and credentials.

RSI and RL training are deferred. Stable identity, immutable versions, trajectories and explicit feedback provide extension points for later individual-agent evaluation and optimization. See the [implementation validation record](independent-agents-validation.md) and [UI repair validation](ui-regression-repair-validation.md) for measured evidence and remaining limits.
