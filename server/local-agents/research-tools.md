# Native research tools and public activity

`tool-config.ts` exports `researchToolCapability(provider, version)`. Detection and
each nonempty task tool bundle probe the resolved executable with `--version`.
Empty/missing bundles keep the existing run arguments and probe sequence.

| Provider | Squabble capability | Gate / reason |
| --- | --- | --- |
| Codex | Task-scoped Streamable HTTP MCP | Version >= 0.104.0, plus effective MCP isolation verified before the research process starts. |
| Claude Code | Task-scoped Streamable HTTP MCP | Version >= 2.1.221, strict MCP configuration and exact allowlisted tool names. |
| Gemini CLI | Read-only snapshot | This adapter deliberately keeps `admin.mcp.enabled=false`; isolated dynamic MCP configuration has not been validated. |
| Antigravity | Read-only snapshot | This adapter retains `inheritMcp: false` and its MCP deny rule; isolated dynamic MCP configuration has not been validated. |
| OpenCode | Read-only snapshot | This adapter retains default-deny tool permissions; merging a task MCP into native configuration without inheriting other tools has not been validated. |
| Kimi Code | Read-only snapshot | This adapter retains the custom agent's read/web tool allowlist and no subagents; isolated dynamic MCP configuration has not been validated. |
| Doubao Agent | Read-only snapshot | Headless cloud execution cannot reach a caller's loopback listener. The existing CLI public run status is the available activity contract. |

These are Squabble integration capabilities, not claims that the other CLIs lack
MCP. The floors are conservative protocol baselines covered by offline fixtures,
not the first vendor releases supporting MCP. Older or unrecognized Codex/Claude
versions receive a dated, size-limited quoted evidence snapshot. A Codex snapshot
run also disables and verifies all effective MCP servers. A failed isolation
check fails closed with `NATIVE_AGENT_TOOL_ISOLATION_FAILED`.

For Codex, an empty `mcp_servers` table is insufficient because configuration
tables merge. The runner enumerates effective servers, disables each explicitly,
disables apps/plugins/hooks for the invocation, adds a random private server name,
and checks that it is the sole enabled MCP server. No user config is written.
Claude retains `--strict-mcp-config` and `--permission-mode dontAsk`; only the
specific task tool names are added to `--allowedTools`. Both resolve the random
task token from the child environment, never argv or a user/session bearer token.

The loopback bridge uses 127.0.0.1, an ephemeral port, exact Host/Origin validation,
and a random bearer token. It has 64 KiB request / 256 KiB result limits, 8 active
calls, 128 distinct calls, 512 HTTP requests, and a 60-second call deadline. A
JSON-RPC ID is bound to a canonical request fingerprint: retries reuse the same
call and result; changed arguments are rejected. Lost HTTP responses do not abort
the shared call. MCP cancellation, task cancellation, timeout and task cleanup
do abort it. Shutdown closes connections and drops the retry cache.

Activity uses only allowlisted public metadata with hashed call IDs, deduped event
IDs, fixed summaries and observed durations. It never forwards arguments,
commands, errors, stderr, thinking blocks or commentary prose. Codex, Claude,
Gemini and OpenCode expose supported tool lifecycles. Kimi exposes tool starts;
its opaque tool reply does not establish a documented outcome. Antigravity's
public step update and Doubao's run status produce phase activity only. The task
owner closes unfinished tools. Squabble MCP calls are omitted because the backend
publishes their authoritative tool events.

Sources checked 2026-11-03:

- [Codex MCP configuration](https://developers.openai.com/codex/mcp),
  [0.104.0 configuration loader](https://github.com/openai/codex/blob/rust-v0.104.0/codex-rs/core/src/config_loader/mod.rs),
  [0.104.0 MCP CLI](https://github.com/openai/codex/blob/rust-v0.104.0/codex-rs/cli/src/mcp_cmd.rs).
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and
  [MCP HTTP/environment configuration](https://code.claude.com/docs/en/mcp).
  The 2.1.221 floor includes waiting for explicit MCP servers before a print run.
- [Gemini MCP configuration](https://geminicli.com/docs/tools/mcp-server/),
  [Antigravity MCP](https://antigravity.google/docs/mcp?tab=cli),
  [OpenCode MCP configuration](https://opencode.ai/docs/mcp-servers/),
  [Kimi Code source and documentation](https://github.com/MoonshotAI/kimi-code),
  [Doubao CLI's headless/cloud contract](https://github.com/Fullstop000/doubao-cli).

Verification uses disposable subprocess fixtures that initialize MCP, list tools,
invoke an actual callback and consume its structured result. An additional manual
metadata-only check used installed `codex-cli 0.166.0-alpha.5.1` with a disposable
CODEX_HOME and fictional MCP configuration; it confirmed unrelated MCP disabling.
It did not launch a research prompt, use account credentials or invoke a model.
No paid-provider/model end-to-end verification was performed.
