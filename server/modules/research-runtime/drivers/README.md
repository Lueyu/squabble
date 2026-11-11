# Controlled Deep Agents driver

`DeepAgentsDriver` runs the actual **deepagents 1.16.4** graph with a real
`@langchain/core 1.3.7` `BaseChatModel` subclass. It does not cast an AI SDK model
into a LangChain model. AI SDK remains a single-request transport behind
`ModelStepService`.

The initial supported mode is **read-only research**. The driver rejects catalogs
containing external writes. Filesystem tools, host commands, delegated subagents,
global memory, external tracing and automatic summarization are disabled. This
mode does not claim to provide Deep Agents' unrestricted filesystem, delegation
or summarization features.

## Integration

Register `DeepAgentCheckpointsService` and `DeepAgentsDriver` in the runtime module
after applying migration 58. Dependencies are the existing runtime journal,
single-step model service, durable invocation service and database. Call:

```typescript
await deepAgentsDriver.execute(runtimeExecuteInput, runtimeLoopPorts);
```

`RuntimeExecuteInput` retains the owner/run, immutable model request, full frozen
owner input, scope and turn/evidence-specific final parser. `RuntimeLoopPorts`
must be the same dispatch budget, source/scope, should-continue, tool adapter and
receipt hooks used by the controlled driver. No global default credentials or
framework-specific budget route is added.

The route selection must be explicit and frozen with the run. Existing runs keep
their original driver. The default controlled driver remains appropriate for
ordinary research; selecting Deep Agents does not increase permissions, tool
counts or budgets.

## One loop and durable dispatch

Deep Agents owns this driver's graph loop. The default runtime loop is not run
inside it. Every model callback:

1. Checks cancellation, source/scope validity and remaining frozen step limits.
2. Saves an encrypted complete pre-model transcript under owner/run/context hash.
3. Creates the usual runtime model receipt and budget reservation in one
   transaction, or reuses the exact saved response without sending again.
4. Stores the response before settling known usage and validating actions.
5. Routes tool calls through the existing invocation receipt and budget hooks.

The LangChain model has zero retries and no cache. A strict `bindTools` gate
rejects unexpected framework tools before model transport. Known tool calls are
limited to four per model step, twenty-four invocations per run and six model
steps, with at most two reads concurrently and one per connection. Invalid
actions produce bounded structured feedback; there is no paid repair callback.

The exact package release names its subagent middleware `subAgentMiddleware`
(different casing from its published required-middleware constant). The driver
uses per-instance same-name replacements for that actual middleware, filesystem
and summarization. It does not mutate a global harness-profile registry. A
future release that introduces another tool fails the binding gate instead of
silently gaining permission.

`LANGCHAIN_TRACING`, `LANGCHAIN_TRACING_V2` or `LANGSMITH_TRACING` enabled in the
server environment make this driver explicitly unsupported. Prompts, private
holdings and tool results are not exported to external framework tracing.

## Recovery

There is no production `InMemorySaver`. Migration 58 stores authenticated,
encrypted transcripts with context and payload hashes and a lease-checked
monotonic step index. Framework-local state is restricted to messages and a
constant optional version marker. No writable files, tasks, shared memory or
automatic summaries exist outside that transcript.

If execution stops during a tool batch, recovery starts from the prior model
boundary. The original model response is restored and completed tool receipts
are reused. Any unresolved model/tool dispatch halts as `provider_unknown` before
another paid request. A locally rejected final response can be reparsed from the
same response under the same context/evidence boundary. Accepted replay still
revalidates source scope and the final parser. Neither read/status nor migration
code invokes the graph.

Frozen holdings and cash remain whole. The driver fails explicit payload/context
limits rather than clipping them. It never allows a framework summary to replace
required owner facts.

## Offline comparison and limits

The disposable PostgreSQL suite uses actual Deep Agents/LangChain classes and a
fake single-step model port. One identical fictional research sample produces
the same evidence-backed answer with the default and Deep Agents drivers; both
make exactly two model requests and one durable read. This confirms accounting,
message flow and recovery behavior for that sample. It is not a live quality,
latency, token-cost or provider-compatibility benchmark, and does not establish
that Deep Agents is generally better.

Additional fixtures cover saved response/read recovery, unknown dispatch,
duplicate IDs, cancellation, write rejection and future child permission/budget
subset checks. Child allocation validation is preparatory only: delegated
subagents are disabled in this version. Real model/provider evaluation remains
separate and must not be inferred from offline fake model tests.

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test server/modules/research-runtime/drivers/deep-agents-driver.spec.ts
```
