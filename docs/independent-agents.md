# My agents and automatic teams

Start with three steps: **import holdings → meet your agents → create your team**. Open the research room later when you have a specific question.

## Getting started

Confirm holdings and cash on the overview. Team setup reviews positions, cash and snapshot time before creating an independent paper account. Missing inputs must be completed first. Later changes to real holdings never overwrite that paper ledger.

Connect your model service or installed local assistant once. Agents reuse that connection. Saving and checking a model connection explicitly sends one short, potentially billable request; adding agent profiles does not invoke a model.

The recommended roster covers financials, valuation, challenge, risk and moderation. Every agent has a stable identity, specialty and immutable capability versions. Different people sharing a model remain distinct. Editing creates a new version; existing published teams retain their pinned version until explicitly updated. Advanced source/tool declarations are ceilings, not live grants.

Personal, conversation and team memories are separate. You can save a note or explicitly share a selected item with an existing team. Sharing retains provenance and all original source restrictions. It never copies another team’s history or grants a revoked/deleted source.

Archiving prevents new selection and paid dispatch. Already-dispatched work may settle under its pinned version and still-valid permissions. Team pause and source/connection revocation continue to block late publication or application. History remains readable.

## Creating and operating a team

1. Keep the recommended collaboration and name the team.
2. Choose existing agents. Financials, challenge and moderation are selected by default.
3. Review the holdings copy, main market, budget and startup authorization, then start.

Defaults cap calls at8/run,16/day and320/month. A run reserves at most half the daily dollar limit; the monthly dollar limit is twenty daily limits. Existing account/global limits still apply. Larger teams may need a higher existing call allowance; setup does not increase it implicitly.

Startup authorizes recurring research, system adoption and replacement of the paper combination within account risk rules. Every cycle rechecks team version, binding, permissions, trading calendar and budgets. Research is scheduled one hour after the main market closes; paper execution separately respects each instrument’s trading session, prices, funds and risk constraints.

The team overview shows status, recent work, members, budget and the paper account. Pause stops future research and all automatic paper trading, including protective orders. In-flight work retains its real cancellation, uncertain or settlement state. Changed versions or permissions may require fresh confirmation.

Interrupted setup preserves its progress. Restore and review the original setup to continue instead of creating another team. Advanced organization editing and manual commissions remain available. Legacy seats can be linked to an existing agent or converted into a persistent profile before publishing; private history remains in its original team.

## Research, external agents and observability

Chat with one agent from its card, or choose several in the research room. One person answers directly; a group has one moderator and a bounded ending. Follow-ups retain the discussion’s frozen agent versions.

External connections read a real A2A Agent Card. The current profile supports A2A1.0 JSON-RPC send, poll and cancel, without streams, push callbacks, remote interactive continuation or URL-artifact downloads. Structured team delivery requires actual verification; card claims alone are insufficient. Internal models, memory, tools and fees can remain unknown.

Local endpoints require both explicit user trust and exact card/RPC URL entries in deployment configuration `A2A_LOCAL_SERVICES_JSON`. Public endpoints use constrained address checks, pinned resolution and bounded responses; credentials are not forwarded across origins.

Run analysis filters by persistent agent/version, team/version, commission, work item and attempt. Different people sharing a model are separate. Configured and observed models are distinct; unsupported historical attribution stays unknown. Metadata export excludes prompts, responses, positions and credentials.

RSI and RL training are deferred. Stable identity, immutable versions, trajectories and explicit feedback provide extension points for later individual-agent evaluation and optimization. See the [implementation validation record](independent-agents-validation.md) for measured evidence and remaining limits.
