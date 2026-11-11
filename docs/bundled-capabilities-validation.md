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
| Frontend | Full local client466/466, zero skips. Actual account first-visit and custom connection journey passed; desktop Chinese and mobile Chinese layouts have no content overflow. Mobile English exposed the explicit model-verification button's nowrap style; final-image verification of its narrow wrapping fix remains pending. |
| Knowledge/static checks | Context15/15; structural check valid=true, no errors, expected semantic-drift warning. Architecture9/9. Initial complete precommit lint/typecheck/stylelint passed; final late-fix CI remains separate. |

The initial PR90029f3 CI server run had1257 tests,1248 pass/9fail/no skips.
Eight failures came from a fixture exact-object assertion after a new explicit
scope field was added; identity and scope are now asserted separately. One
private-library permission regression had already prompted a production grant
fence correction. Neither failure is treated as a passing run. Final-head CI
must pass before merge. Existing Python agent16/16 and actual analytics26/26
passed in that CI; these results do not certify real cloud services.

## Actual first-account and custom-tool acceptance

The empty-volume project `squabble-bundle-acceptance-20261111` is isolated from
personal state. A fictional account was created through the real browser at
`127.0.0.1:54831` with no API interception. Four prepared cards initially required
authorization. One explicit recommended-activation click enabled all four;
the user entered no internal endpoint, version or tool schema. No model probe
was invoked. Prepared grants and credentials survived application replacement.

A synthetic MCP endpoint registered only in this deployment was entered through
the custom-tools editor. Saving automatically discovered metadata and made zero
business calls. Explicit catalog selection, read-effect classification and public
data authorization enabled one echo invocation with one receipt. Invalid arguments
and tampered schema identities made no dispatch. Rediscovery of the identical
catalog retained its revision and grants with zero additional business calls.
Changing the remote schema rejected the original frozen invocation with
`TOOL_RECONFIRMATION_REQUIRED`, made zero business calls, cleared allowed tools
and displayed the candidate difference for manual review. The changed version
was explicitly approved through the UI, then disconnected through the UI.
After a real app-only restart, two fresh service instances rejected the old
descriptor, the connection remained unconfigured at revision5 and neither a
business call nor a network request occurred. The synthetic server retained its
original process and counted exactly one `tools/call` throughout.

The owner API document flow uploaded `10-printed-label.pdf`, parsed it with the
real offline Docling service and found the otherwise Markdown-omitted `Revenue40`
through normal library search. The locator retained physical page1 and the
original `#/texts/0` bounding box/page size. A public AKTools request also saved
seven unadjusted historical rows as an immutable dataset. Its first statistics
job failed explicitly and confirmed termination: the upstream midnight timestamp
format was not accepted by the price template. That receipt is preserved while
the narrow date-normalization fix is verified; this attempt is not counted as a
passing compute chain or silently retried.

Browser screenshots and guarded operator receipts are retained under ignored
`output/playwright/` and `tmp/bundle-mcp-operator-20261111/`. No credentials are
included in this committed record.

Independent review of the final delta found no P1/P2 issues. Its separate
executions passed deployment contracts7/7, document provenance6/6 and analytics
date handling14/14. The date fix accepts only timezone-free midnight daily labels,
preserves the provider calendar date and rejects offsets/intraday/invalid values
and duplicates after normalization. The whole worker and real job gates remain
separate from these focused checks.

## Remaining delivery gates

- Final release empty-volume whole-suite cold boot (the actual first-user
  activation in the source-built suite is already verified above).
- Final-image bilingual desktop/mobile layout and corrected actual
  public-data-to-local-statistics chain; public browser owner flow.
- Final-head required CI, module wiring, memory/native/dev coverage and independent review.
- Exact tested-head PR merge; published fixed image archive with anonymous
  digest verification and its own whole-suite acceptance.
- Matched private DB/runtime-key/artifact/native/capability-key/broker-journal
  backup, isolated restore, merged-main local deployment and read-only checks.

Only fictional accounts/data, self-authored documents and explicitly public
financial samples are fixtures. No personal holdings were used for a model call,
application write, deletion or trade. Windows Docker Desktop Linux amd64 was
executed; native macOS/arm64/desktop installer qualification remains future work.
