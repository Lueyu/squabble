# Bundled capabilities acceptance record

Baseline: e18b5fe. Design and plan were saved and committed as1ff3719 before
production implementation. PR94 contains the Web bundle, capability grants,
candidate catalogs and required local-container compute provider. This record
separates completed checks from final delivery gates.

## Component and regression evidence

| Scope | Actual evidence |
|---|---|
| Local Docker sandbox | Real Engine suite passed1/1, zero skips,152.181s; assertions include nonroot/network/rootfs/socket/credential/cross-job isolation, actual QuantStats and Backtrader, PID/memory limits, output/symlink rejection, timeout/cancel/restart. Current broker component acceptance also passed. |
| Compute persistence | Full focused compute suite30/30, zero skips; queued replay regressions preserve original grant/provider/image/source-policy identity and prevent dispatch after revoke/re-enable. |
| Document engines | Actual Docling CPU offline corpus20/20 parse/reject outcomes;40/40 expected field literals in lossless JSON,39/40 in Markdown because one header is classified as page_header. Chinese scan4/4 expected fields. This is fixture acceptance, not general OCR accuracy. Detailed timings, model/package hashes and memory are in bundle-packaging-validation.md. MinerU remains optional and is not live-certified. |
| AKTools | Actual official MCP initialization/schema and7 public historical rows; forbidden operation rejected. No model or paid provider call. Coverage is restricted to the implemented functions, not every AKShare interface. |
| Browser | Actual nonroot sandboxed Chromium and dynamic JavaScript passed with the exact Compose security profile. Existing real pinned-egress HTTPS fixture tests are a separate full-server gate. |
| Capability/connection authority | Disposable PostgreSQL tests cover owner isolation, exact catalog/manifest CAS, unchanged discovery, candidate separation, idempotent grants, disabled-state persistence, source/late-result fences and exact public browser URL scope. |
| Review regressions | Deterministic concurrent candidate replacement and stale generated-key/runtime-key backup tests both reproduced RED then passed2/2 after fixes. Review-required cards can revoke; source-host configuration preserves custom service registrations. |
| Frontend | Full local client466/466, zero skips. Actual1440/390px bilingual browser journey remains a final integration gate. |
| Knowledge/static checks | Context15/15; structural check valid=true, no errors, expected semantic-drift warning. Architecture9/9. Initial complete precommit lint/typecheck/stylelint passed; final late-fix CI remains separate. |

The initial PR90029f3 CI server run had1257 tests,1248 pass/9fail/no skips.
Eight failures came from a fixture exact-object assertion after a new explicit
scope field was added; identity and scope are now asserted separately. One
private-library permission regression had already prompted a production grant
fence correction. Neither failure is treated as a passing run. Final-head CI
must pass before merge. Existing Python agent16/16 and actual analytics26/26
passed in that CI; these results do not certify real cloud services.

## Remaining delivery gates

- Empty-volume whole-suite cold boot and first-user activation.
- Actual custom MCP save/discover/review/invoke, unchanged discovery, changed
  candidate review and disable/restart behavior through the application.
- Actual bilingual desktop/mobile pages, public browser/data and document flow.
- Final-head required CI, module wiring, memory/native/dev coverage and independent review.
- Exact tested-head PR merge; published fixed image archive with anonymous
  digest verification and its own whole-suite acceptance.
- Matched private DB/runtime-key/artifact/native/capability-key/broker-journal
  backup, isolated restore, merged-main local deployment and read-only checks.

Only fictional accounts/data, self-authored documents and explicitly public
financial samples are fixtures. No personal holdings were used for a model call,
application write, deletion or trade. Windows Docker Desktop Linux amd64 was
executed; native macOS/arm64/desktop installer qualification remains future work.
