# Agent tools: configuration, recovery and deployment

See the [implementation acceptance record](agent-tooling-validation.md) for tested
behavior and the remaining live-service and quality gates.

Squabble can give a configured model access to a reviewed tool catalog while
retaining its existing independent research, report and simulated-account flows.
The application owns permission checks, durable receipts, budgets and acceptance.
An API model and a connected external agent remain separate execution choices;
outbound tools are reusable capabilities, not a second investment workflow.

## Enable a capability deliberately

The standard [Web bundle](../deploy/README.bundle.md) prepares Docling CPU/OCR,
reviewed AKTools operations, sandboxed Chromium and a required local-container
compute provider. Deploy the generated fixed-digest archive with
`docker compose up -d`; no host Python, browser/model installation or E2B account
is required. Initial downloads include several GiB. Actual component readiness
is separate from app health. Qualified images are Linux amd64; Windows uses
Docker Desktop Linux containers/WSL2. macOS/arm64 and future desktop installers
need separate qualification before being advertised.

Open **Settings → Tools**. First-visit preparation creates disabled owner grants
and checks metadata without business calls. One screen confirms local processing
and public-network queries. Private export to a model/cloud service retains its
separate permission. Component health, catalog and owner grant are independent;
reading status is read-only. Unchanged catalogs preserve permission revisions;
changed metadata stays a candidate with an active/candidate diff. Reboots cannot
revive a disabled grant. Internal endpoints and keys come from the deployment.

**Add tools and cloud services** retains presets and custom MCP. Saving performs
one metadata discovery; failure retains the connection for repair. Enablement
remains explicit. Model compatibility probing is a separate charged action.
The advanced connection workflow below also applies to source-only installations.

Open **Settings → Tools** (`/settings/tools`). Existing **MCP** settings remain
the inbound scoped-session interface for another client to call Squabble.

1. Add a connection and save its write-only credential or complete OAuth.
   Supported adapters are MCP Streamable HTTP, Tavily, Exa, Firecrawl and Composio.
   Public endpoints use pinned public-address HTTPS transport. A private MCP
   endpoint must already appear in the operator's exact endpoint registry.
2. Discover the catalog. Review the exact tool/schema version, effect (`read`,
   `compute` or `external_write`) and permitted data classes. Remote read-only
   hints do not grant permission. A changed catalog requires confirmation again.
3. Explicitly enable only the needed tools and data classes. Connection status
   describes saved configuration and verification facts; it is not a claim that
   every provider operation works or that a remote account is currently healthy.
4. Explicitly run the selected model connection's tool-calling probe. This can
   charge up to two model requests and one side-effect-free echo invocation.
   Cached status reads and driver selection make no model request. A lost probe
   response keeps its request identity; retrying the same request reuses receipts.
5. Leave the default **controlled** driver selected, or explicitly choose
   **Deep Agents** for read-only research. The chosen route is frozen for each
   saved turn; changing preferences never reroutes an existing attempt.

Credentials, model prompts and private tool payloads are encrypted private state.
No owner-facing API accepts arbitrary host commands or a global tools/call proxy.
Provider setup and paid calls are separate from opening settings or reading a run.

## Research, approval and unknown outcomes

The model receives a frozen catalog and complete owner context. Each model step
is one HTTP request with retries disabled. The runtime persists dispatch identity
and budget reservation before sending, stores the response before parsing, and
records tool invocations separately. Reads may run two at a time, at most one per
connection. In a mixed batch, reads finish first and writes wait for approval.

The application implements approvals before dispatch; SDK tool approval is not
used. A preview includes the exact target/account, arguments, attachments,
source and catalog revisions, cost facts and expiry. Editing creates a new preview
revision/hash and invalidates old confirmation; it does not rerun a model step.
Confirming saves permission for that action. The original research recovery entry
resumes the run and rechecks permission immediately before external dispatch.
Report adoption, strategy application and financial fills retain their own gates.

Cancel prevents new calls and publication; it cannot prove an upstream paid
request stopped. A missing response becomes `provider_unknown`. Status/recovery
checks never replay it. When the provider cannot establish its outcome, explicitly
close it as `settled_unknown`; possible charges and old reservations remain.
A new request needs a new identity and an explicit user choice after the duplicate
risk is visible. Saved malformed final responses may be reparsed locally under
the original context/evidence/hash fence, with no hidden model repair request.
Zero usage placeholders and missing costs remain unknown.

`ResearchToolActivity` displays actual runtime events, approvals and recovery
state. Sealed research evidence stays private to its original member until the
existing publication workflow shares it. Browser observations receive citation
IDs; page text and external results remain untrusted evidence.

## Local data, documents and browser

AKTools uses its official MCP endpoint, bound to one owner-approved connection;
Tushare uses an encrypted owner token and official HTTPS API. Current added
coverage is CN daily prices/income/calendar and AKTools HK income, with explicit
market/exchange and adjustment metadata. Existing public/SEC/Finnhub/Alpha Vantage
paths remain available. This is not complete market, FX or corporate-action
coverage, and provider entitlements/retention terms still apply.

Financial queries retain complete immutable rows, source version IDs and content
hashes before returning a labelled sample. Runs and calculations bind exact
dataset versions; a current revised value never silently replaces a historical
input. `availableAt`, observation time and report period are distinct. Missing
business timestamps remain null. A six-digit CN code is not enough to infer its
exchange.

PDF/DOCX originals are retained before optional asynchronous local extraction.
Without a configured engine, the saved source reports an unconfigured parser;
it is not represented as successfully read. PDF locators distinguish physical
pages from printed labels; DOCX uses elements without invented page numbers.
Original text, numeric-validation discrepancies and parser versions remain
separate. The current preview displays extracted text/locators, not rendered
page images. See [document workers](../workers/documents/README.md).

Anonymous `browser_research` sessions belong to one run/lease and offer bounded
navigation, reading, pagination, disclosure expansion and screenshots. They do
not import a saved source's login state. Use `read_browser_source` for an enabled
owned authenticated source. Public DNS/socket policy applies to redirects and
subresources. Optional Playwright MCP and Browserbase adapters remain unavailable
until an operator registers the backend with the required independent egress
assurance; their fixtures do not establish live provider compatibility.

## Isolated statistics and hypothetical backtests

Compute tools read full dataset files by immutable ID/hash and default to the
required local container sandbox. Model-authored Python runs in a fresh isolated
job container. Only the trusted broker receives the Docker socket; containers
are nonroot, networkless and resource-bounded, with no host paths, application
credentials or other job data. The broker journals identity before creating the
container. Results require hashes and confirmed termination. Local failure never
falls back to host Python or cloud execution.
Public source licenses must allow research. Local processing retains current
owner/source/data-class grants. Historical cloud E2B compatibility additionally
requires `egress:e2b` for sensitive inputs. Old jobs retain their provider for
cleanup; model arguments cannot grant permission or change a frozen provider.

Fixed QuantStats templates disclose frequency, annualization, risk-free rate,
benchmark, missing data and positive-return-period ratio. That ratio is not trade
win rate. Price-series conversion requires an explicit return basis; unadjusted
price changes are labelled price-only. Missing trading calendars leave annualized
statistics unknown. Backtrader uses unadjusted execution prices and the next
tradable session with explicit calendar/rules/actions/FX/universe inputs and
availability timestamps. Incomplete validated inputs are rejected. Free code is
exploratory, never a validated backtest. No computation changes a real or paper
ledger. Worker setup, reproduction and licensing are in the
[analytics guide](../workers/analytics/README.md).

Sandbox receipt and cleanup outcome are durable. Cancellation/revocation prevents
result publication; uncertain termination remains visible and must be reconciled.
Do not recreate a sandbox merely to find or clean up an earlier one.

## Operator configuration

Keep secrets outside Git. Connection-specific search/crawl/application keys are
saved through the owner-scoped settings UI, not global environment defaults.

| Variable | Purpose |
|---|---|
| `SETTINGS_ENCRYPTION_KEY` | Existing stable private key for credentials, runtime payloads and checkpoints; preserve with backups |
| `RESEARCH_ARTIFACT_ROOT` | Private durable directory outside a replaceable release; default `.data/research-artifacts` under the process working directory |
| `TOOL_MCP_LOCAL_SERVICES_JSON` | Operator-owned exact endpoints, for example `[{"id":"aktools","endpoint":"http://127.0.0.1:8080/mcp"}]`; no arbitrary command execution |
| `FINANCIAL_AKTOOLS_MCP_URL` | Exact reviewed AKTools endpoint also registered above and approved for this owner's read tools |
| `TOOL_OAUTH_CALLBACK_URL` | Exact registered OAuth callback on `/settings/tools`; callback completes through the authenticated API with PKCE/state |
| `COMPOSIO_CALLBACK_VERIFIER_ENABLED` | Set `1` only when using the implemented account/status verification flow; connected-account identity remains owner-bound |
| `DOCUMENT_DOCLING_URL`, `DOCUMENT_DOCLING_KEY` | Optional private Docling Serve endpoint and internal key |
| `DOCUMENT_MINERU_URL`, `DOCUMENT_MINERU_KEY` | Optional private MinerU endpoint and bearer key |
| `DOCUMENT_ALLOWED_ORIGINS` | Comma-separated exact private document service origins; Docker DNS origins require explicit registration |
| `SANDBOX_BROKER_URL`, `SANDBOX_BROKER_TOKEN_FILE` | Deployment-owned local broker endpoint/credential generated by the suite |
| `TOOL_CAPABILITIES_BUNDLE_ENABLED` | Enforce bundled owner grants and cached metadata readiness |
| `DOCUMENT_DOCLING_KEY_FILE`, `FINANCIAL_AKTOOLS_MCP_TOKEN_FILE` | Generated internal credential files; preserve in matching backups |
| `E2B_API_KEY`, `E2B_ANALYTICS_TEMPLATE_ID`, `E2B_ANALYTICS_TEMPLATE_VERSION` | Optional historical cloud compatibility; not a local compute prerequisite |
| `COMPUTE_CLEANUP_WORKER_ENABLED` | Set `true` to reconcile bounded pending cleanup work |

Deep Agents refuses execution when `LANGCHAIN_TRACING`, `LANGCHAIN_TRACING_V2`
or `LANGSMITH_TRACING` enables external framework tracing. Existing opt-in
Langfuse exports remain metadata-only; prompts, answers, holdings and keys are
excluded. None of these new services requires opening local authentication to a
public listener.

## Deployment, backup and verification

Apply registered additive migrations53–60 through normal startup only after
fresh/upgrade/replay checks on disposable PostgreSQL16. Fresh installation uses
the consolidated `01_schema.sql`; migration numbers are not a schema-version
ledger. Keep database, encryption keys, private environment, native task journals,
imports and `RESEARCH_ARTIFACT_ROOT` in one matched backup. Restore into an
isolated database and verify artifact sizes/hashes before cutting over. Retaining
the database without its encryption keys or durable receipt files is insufficient.
See the [deployment runbook](../.agents/skills/squabble-contributor/references/deployment-and-recovery.md).

Artifacts use owner-separated private paths, size/hash checks and quotas. Cleanup
of deleted sources erases derived bytes and rows while retaining tombstones.
Bounded reconciliation removes only aged unindexed files/temporary files;
indexed retained artifacts and unrelated owners/backups are protected.

Use disposable `RESEARCH_TEST_DATABASE_URL` and
`TOOL_CONNECTIONS_TEST_DATABASE_URL` for the new integration suites. Fake
transports exercise actual SDK/MCP protocol, durable dispatch, approval changes,
source revocation and late-result handling without private data or paid calls.
Actual Chromium fixtures verify browser egress/lifecycle. Actual Python libraries
verify fixed analytics templates. These tests do not prove live cloud service
compatibility or research quality.

The implementation acceptance record must distinguish local/offline checks from
live integrations. Real Docling/MinerU execution on the twenty-document gold
corpus, numeric agreement targets, bilingual search/retrieval quality, live OAuth/
MCP/Composio/E2B checks and complete financial-provider coverage remain separate
acceptance work until measured. Never turn missing prerequisites into a passing
quality claim or silently enable a provider to make a demonstration work.

## 中文操作要点

标准套件在“设置 → 工具”显示资料、金融、网页和本地沙箱的真实准备状态，一屏确认本地
处理与公开联网权限。高级入口保留自定义 MCP 和可选云服务；保存自动发现目录，授权另行
确认。再按需显式验证模型工具调用，探测可能计费，查看设置不会自动探测。Deep Agents
是共用预算、回执和权限的只读替代运行器，不额外开放文件系统或子 Agent。

外部写入先展示可编辑预览；修改使旧确认失效，不重跑研究。确认仅授权该次外部操作，
不代表采纳报告、启用投资策略或生成成交。取消后不再发布结果；供应商状态未知时保留
可能费用，核验与关闭不会自动重发。资料停用、删除和外发权限收紧会阻止后续使用。

资料、版本、原件和产物在部署服务器保存，默认计算使用必备本地容器，搜索和应用连接
可按需连接云服务。组件未准备显示具体原因。部署时共同备份数据库、加密密钥、内部
服务密钥、沙箱/本地 Agent 回执和产物目录；
真实 OCR、付费供应商联调和研究质量须分别验收，不能用离线夹具结果替代。
