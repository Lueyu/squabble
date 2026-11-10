# Research skills and data workspace implementation plan

**Goal:** Make research a persistent agent conversation with callable skills and a nearby strategy library, simplify companion/daily presentation, and replace the data link index with usable research materials, subscriptions and financial connections.

**Architecture:** Reuse owner-scoped research sessions, public activity events, pinned research skills, strategy interviews and encrypted settings. Add a separate material/source/version/sync domain backed by PostgreSQL, including bounded original file bytes. Raw imported material is evidence with provenance, not automatically an endorsed thesis. Existing ledgers, paid-task identity and explicit strategy application remain authoritative.

**Source baseline:** main `02e9d735a368ccc794c56f9e287cff26f6093091`; isolated branch `codex/research-skills-data-center`. The reviewed baseline passed server999/client435/native181 and required CI. Current personal3192 is not a mutation or paid-model test fixture.

## Product decisions

- Keep the original animal identities. Daily account activity uses the same animal as the account; legacy unset identities get a consistent animal fallback. Companion cards have one identity header, one main asset figure, concise strategy/status information and distinct account/stop/delete actions. Remove the three requested cross-navigation links and redundant account explanatory prose.
- `/research` owns chat and strategies. The side rail switches between conversation history and strategy history without losing drafts. `/strategy` opens the existing persisted, revisioned interview in the workspace; questions clarify intent, preview stays reviewable, and saving never applies a trading policy automatically. Older strategy URLs remain compatible.
- A slash picker exposes actual registered skills, not decorative commands. Selected skill identity/version must reach execution and saved activity. The conversation shows public member summaries, evidence, tool activity, skill use and failures. Private internal reasoning and credentials are not exposed or fabricated as a thinking transcript.
- `/data` has materials, subscriptions and financial-source views. Materials support saved pages, slides, website material and images with original files/content, versions, extraction state and preview. Image storage does not imply OCR; unsupported or failed extraction is visible.
- Subscription configuration binds URL, authentication method, schedule and enabled state. Owner-scoped encrypted credentials are never sent to models, returned in API reads or stored in extracted documents. Manual and scheduled sync share durable jobs, limits, deduplication and failure history; expired access requests reconnection rather than indexing a login page.
- PostgreSQL stores metadata, extracted text, exact source versions and full-text indexes. Embeddings may be added behind the retrieval contract; the UI does not claim Codex's private implementation or require a vector database to store files.
- Financial configuration moves out of Settings into Data. Preserve existing Finnhub keys and public sources; add real capability-labelled provider connections and a working research/query consumer. Delayed/end-of-day values must retain their source timestamp and not be called realtime.
- The supplied financial-skill reference has been adapted into nine bundled research methods plus the existing strategy interview. Product content uses Squabble naming; genuine model-provider identifiers remain unchanged. Pickalphas uses a browser password form rather than HTTP Basic authentication. The generic subscription connector is implemented, but authenticated collection is not claimed until an actual session and retrieved article are verified.

## Work packages and ownership

1. **Figma first — design agent.** Extend the existing file with research/skills/strategy side rail, materials, subscription states, financial sources, companion/daily views and mobile layouts. Inspect screenshots and document node links in `v5-figma-design.md`. Implementation of each view begins after its corresponding draft is inspected.
2. **Research — research agent.** Audit/extend registered skills, requests, prompt pinning, public activity, slash selection, persistent sidebar state and embedded strategy interviews. Add meaningful no-automatic-dispatch, identity/retry/history and activity tests. Coordinate the material retrieval contract with data foundation.
3. **Data services — data foundation agent.** Implement additive schema, source/version/job/file persistence, bounded safe fetch/format extraction, scheduling, credentials, owner isolation, memory source visibility and financial providers. Keep source deletion and downstream retrieval availability consistent. Test actual adapters with isolated fixtures, not real subscription credentials.
4. **Presentation/integration — root.** Implement the Figma companion/daily changes, functional data center UI, configuration relocation and route compatibility. Exercise create/read/sync/error/delete flows with fictional material; no personal record deletion.
5. **Independent review/verification.** Review source identity, credentials, fetch boundaries, concurrent sync and deletion, paid-dispatch limits and accessible responsive UI. Update architecture flows and contributor references. Run relevant targeted tests then final required suites/CI without bypassing gates.
6. **Delivery.** Merge through a reviewed PR into main, synchronize installed contributor knowledge, and complete the session's authorized local deployment using a matched recoverable backup and current runtime identity. Record operational evidence privately.

## Acceptance evidence

- Desktop/tablet/mobile: readable companion cards, visible daily animals, no removed links, unchanged primary navigation, large usable composer, keyboard slash picker and retained per-task drafts.
- Skill selection survives retry/reload and is recorded truthfully; no display-only activity is presented as execution. Tool results cite the specific owned material version. Invalid/deleted/foreign sources cannot be retrieved for new research.
- Strategy interviews and historical strategies open in the research workspace, keep saved identity and return paths, and require existing explicit review/application fences.
- Upload/author/import creates retrievable original material and honest extraction state; webpage/RSS/JSON sync creates bounded deduplicated versions. Repeated jobs and failures are inspectable. Authentication expiry, hostile redirects/private-network destinations and oversized bodies fail safely without leaking credentials.
- Provider configuration is accessible within Data, existing keys survive migration, available capabilities have actual consumers and timestamps, and former Settings URLs lead to the owning workspace.
- Fresh/upgrade schema parity, immutable history, owner isolation and ledger preservation pass against disposable PostgreSQL. Final lint/types/CSS, client/server/native suites, architecture/context checks and required CI validate the final source.

## Implementation and review record

The V5 Figma states have been implemented. Isolated browser checks covered 1440px
desktop and 390px mobile layouts, source creation/original/version preview, slash
selection and the strategy sidebar. Mobile source details now have an explicit
return action that restores search, filters, list scroll and focus. These checks
used fictional materials and accounts; no live portfolio was used as a fixture.

Independent review found and verified fixes for source availability through
derived reports and memory, more than thirty unique source references, disabled
source retrieval, uploaded-text metadata editing and legacy financial-provider
queries after disablement. Additional checks cover final tool-call dependencies,
API/native submitted memory dependencies and publication/deletion locking. Exact
forty-source and concurrent transaction fixtures passed without truncating refs.
The final review reported no remaining P1/P2 findings within that scope.

Local verification includes lint/types/styles, compiled Nest module wiring,
architecture boundaries, contributor-context checks, the fictional memory
evaluation and sixteen offline Python tests. Native-agent and development suites
pass on Windows with one POSIX-only skip each. Full server/client runs and the
required Linux/PostgreSQL/Docker checks remain release gates; their final results
are recorded with the PR, rather than inferred from this design document.

Deployment follows the existing matched database/key/native-journal backup and
restore procedure. The active personal instance is never a destructive test
fixture. Pickalphas authentication remains a separately verified integration;
saved configuration or a design sample is not evidence of a successful login.
