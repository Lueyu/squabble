# Browser source collection implementation plan

**Goal:** Let Squabble collect a saved website's rendered content through its own browser connection and expose that capability to task-scoped research Agents.

**Architecture:** Keep HTTP fetching as the default. A browser runtime owns isolated contexts and controlled public-network egress; a database service owns encrypted session state, connection actions and durable source/job/version identities. Research Agents can read an enabled saved browser source, but cannot log in, export sessions, accept an arbitrary browser endpoint or choose a local profile path. The user-approved flow is browser connection → normal manual login → explicit save → collection → versioned research evidence.

**Baseline:** main `fa4a5922afa848a1e6c6a310e86a58bc66c3196d`; branch `codex/browser-source-collector`. The previous release passed server1010/client443 plus all required CI checks. Its personal installation remains separate from fictional test fixtures.

## Product and technical boundaries

- Capture mode (`http` / `browser`) and HTTP authentication are separate. Browser mode uses a dedicated session, never the accidentally configured HTTP Basic password. Existing sources keep HTTP mode until explicitly saved otherwise.
- The subscription UI shows unconnected, login-window-open, connected, expired and unavailable states. Unsaved configuration cannot silently launch or collect using older saved settings. Sources with zero versions do not claim retained content.
- Interactive login is initiated only by an explicit local-workspace action. The user enters credentials and any challenge in the normal browser; the application does not automate credential entry. Confirming a connection saves encrypted browser state, never returns cookies/tokens to the frontend or model. Remote/headless installations state their actual supported capability.
- Collection reads the configured page's dynamic main/article content. It does not claim a complete crawl of every article on a site. Rendered snapshots retain acquisition type, actual URL, title and observation time; login pages and empty shells do not become successful versions.
- Browser network egress checks every destination and pins verified public addresses. A short-lived authenticated CONNECT proxy prevents Chromium from independently resolving an already-checked hostname. Private addresses, unsafe protocols/ports and credential-bearing navigation URLs are blocked. Browser TLS verification and sandbox stay enabled. Requests, bytes, pages and lifetime are bounded, with service workers and unproxied transports disabled. Configured upstream proxy credentials remain internal.
- Login is separate from the sync lease. Collection has a total deadline below the existing90-second lease. Sync also gains an active-job token so an expired or cancelled worker cannot commit after its replacement. Source edits, stop, disconnect and deletion cancel work and are rechecked in the final transaction.
- Browser state and HTTP secrets have separate encrypted storage. Source/version APIs use explicit projections. Owner/source identity and revision are rechecked when confirming, collecting and committing; old sessions cannot revive a deleted or disabled source.
- The Agent tool `read_browser_source` accepts only an owned saved source ID. It uses the same collector/version pipeline, emits real tool activity and preserves exact source/version dependencies through reports and memory. It cannot enable global MCP tools or operate an unrestricted browser.

## Work packages

### 1. Browser engine and egress — runtime agent

Files: `server/modules/data-library/browser/browser-source.types.ts`, browser runtime, controlled proxy and their specs. Runtime contract: `availability`, `open(key,url,state?)`, `confirm(key)`, `read({key,url,storageState?,signal?})`, `close(key)`, `shutdown`; key is the internally constructed owner/source tuple. Read returns actual URL/title, bounded HTML/text, observation time and `browser-rendered` provenance. Test forbidden destinations and redirects, proxy authorization isolation, stream limits, cancellation cleanup, real JavaScript rendering and fictional login-state reuse.

### 2. Persistence and API — integration agent

Files: shared data-library contracts, migration51, fresh schema/registry, data-library controller/module/service, new browser connection service, source/job/upgrade integration specs. Add default HTTP capture mode, encrypted browser state and connection timestamp, sync lease identity, and version acquisition metadata. Endpoints under `sources/:id/browser`: GET status, POST open, POST confirm, DELETE session. Existing `sync(owner,id)` stays compatible and gains optional cancellation. Test real isolated PostgreSQL owner isolation, late results, token takeover, explicit disconnect, deletion, encrypted responses and fresh/upgrade preservation.

### 3. Figma then UI — design/frontend agent

Reuse the existing Squabble V5 subscription design. Add desktop and mobile connection states as editable layers; inspect their screenshots before implementation. Frontend files: subscription workspace, source form, browser connection panel, data API/labels/styles, material provenance and interaction tests. Test saving mode before use, explicit confirmation/clear, expired/unavailable display, empty history copy and mobile return state. Real credentials are never fixtures.

### 4. Agent tool and delivery — root

Add `read_browser_source` to the research tool registry/handler and visible translated activity labels. Preserve cancellation, session/revision/attempt scope, result byte bounds, archival and library references. Test the real tool → exact collected version → report evidence path plus unavailable/foreign/deleted/cancelled cases. Add Playwright as a pinned runtime dependency and install Chromium in CI for genuine browser integration tests. Container images without a browser report unavailable instead of pretending collection succeeded.

Review all five architecture flows and update contributor/privacy/self-hosting guidance. Run targeted behavior tests, then final lint, complete server/client/native suites, fresh/upgrade, module wiring, context/architecture and required Linux/Docker CI. Independently review browser egress/session isolation and lifecycle races. Merge via PR, synchronize the installed skill, and use a matched database/key/native-state backup with verified restore for the authorized local update. Personal data and paid Agent invocations are not test fixtures.

## Delivery evidence

Design nodes and actual desktop/mobile/colour-mode checks are recorded in
`browser-source-figma.md`. Fictional browser/data tests verified dynamic content,
login-state reuse, session expiry, explicit disconnect, lease takeover, late
confirmation/results, source changes and exact acquisition metadata. The Agent
tool integration verifies exact version archival, owner/input boundaries,
deduplication and cancellation through the real database services.

Independent review additionally verified pause/revision/permission revocation
reaching active collection in about one second, with no version committed, and
the production browser/proxy path reading public IANA pages. Review found a
source-binding gap: third-party login state and cross-origin final navigation.
The fix filters saved/restored state to source-applicable cookies and the exact
source origin, atomically captures content URL, then rechecks final origin after
state capture. Forced navigation during both confirmation and read is rejected;
normal same-origin redirects remain supported. Final targeted browser/network
tests:17 passed, zero skips; data/API/fresh-upgrade focused tests:11 passed, zero
skips. The independent review reported no remaining confirmed P1/P2 in scope.

One existing concurrency test treated a 1.5-second startup deadline as its
parallelism assertion. A loaded full local run exceeded it; its two-call barrier
still keeps both model calls blocked until both enter, now with a ten-second
deadlock guard and proper timer cleanup. The unchanged concurrency/independence
assertions pass in the focused rerun. Full PR checks remain mandatory.

A public no-credential Pickalphas runtime read reached its actual login page and
returned NEEDS_AUTH, instead of the prior static-fetch timeout. This does not
verify an authenticated subscription article. Real login and content collection
require the user's normal login in the dedicated browser; real credentials and
personal data were not used as automated fixtures.
