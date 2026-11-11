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
| Frontend | Full local client466/466, zero skips. Real account activation/custom connection journey and final-image Chinese/English1440/390px layouts passed. The discovered English model-verification nowrap overflow was reproduced, narrowly fixed and rechecked: content width equals scroll width335px on mobile and877px on desktop. |
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
passing compute chain or silently retried. The narrow fix then passed37/37 pinned
analytics tests. After the worker image changed, the existing grant correctly
required review; a stale-manifest request created zero jobs. The new manifest
was explicitly approved through the actual UI. A distinct request over the same
hash-verified dataset succeeded on local worker
`sha256:21f3560368aba97e7b45ff74c8faa602e8dd8e53bbe80e94181bbb5dd6a49981`,
with confirmed termination and five saved, hash-verified artifacts. Seven price
rows yielded six observed returns. Without a trading calendar or known
currency/unit, coverage stayed partial and annualized return/volatility/Sharpe/
Sortino stayed null; no missing values were filled and dividends/splits were
not claimed. The original failed receipt and prepared authority remain intact.

The final tested app image is
`sha256:8d326cd6ea9335d88a7b19d85f3403ca459df360d0d0b4c9d0e69be0850661ff`.
Its before/after build context hash and independent comparison with clean
commit `be7a16815918ef80ba15c6677660c84b63e7bc80` match:
`461419b8c3dcd074c1fbb3dd4602959d866ecb7179a821816325df42aa7f4c40`
over1,493 files. The image was built while the commit was being recorded, so
the source hash is the content authority. All four capabilities remained
available after the separately reviewed compute image update. Model/usage
rows and portfolio/paper records were unchanged throughout owner API acceptance.

The normal owner browser-source API also synchronized one anonymous public page
with the actual Chromium collector. Its saved version records
`acquisition=browser-rendered`, one section and1,289 UTF-8 bytes; the original
source content hash and byte length were verified. A historical public-page
phrase assertion in the temporary helper was corrected to use actual metadata
and nonempty content, without another network request. The final owner audit
matched all38 portfolio/paper/strategy/holding tables and found zero total rows
across all six model/usage tables. Guarded API acceptance exited0; its receipt
is `tmp/bundle-owner-api-20261111/complete.json`.

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

Final source-suite cold boot also passed with previously absent project volumes
in `squabble-bundle-fresh-20261111`. The unmodified Compose `up --wait` exited0;
the last initial healthy transition occurred about37 seconds after launch.
This is a health-transition measurement, not an exact command stopwatch. A
fresh account saw four prepared/verified packs with disabled grants, and one
explicit fixture authorization made all four ready. The actual Chromium sandbox
probe passed. Cached local images were used; the published archive is separate.

All three required checks passed on `830494f8fab7e63b2f9462b1783398e681d12310`
([CI run42998097308](https://github.com/Lueyu/squabble/actions/runs/42998097308)):
server1263/1263, client466/466, native181/181, memory99/99, dev9/9, context15/15,
architecture9/9, browser preflight3/3, Python agent16/16 and analytics37/37;
all had zero failures and zero skips. Compiled wiring passed. Docker contracts7/7
and gateway3/3 passed. The final archive disk-headroom guard was independently
reviewed with no P1/P2 finding and four negative host/runner/kernel guards passed
without reaching cleanup. It changes only the workflow and excluded documents;
the tested runtime build-context hash is unchanged.

The remaining gates at this pre-merge record are:

- Required CI on the final workflow/documentation commit.
- Exact tested-head PR merge; published fixed image archive with anonymous
  digest verification and its own whole-suite acceptance.
- Matched private DB/runtime-key/artifact/native/capability-key/broker-journal
  backup, isolated restore, merged-main local deployment and read-only checks.

Only fictional accounts/data, self-authored documents and explicitly public
financial samples are fixtures. No personal holdings were used for a model call,
application write, deletion or trade. Windows Docker Desktop Linux amd64 was
executed; native macOS/arm64/desktop installer qualification remains future work.
