# Independent-agent implementation validation

Date:2026-11-12. Source baseline:`74f3744c69b34fbfff0b38eee921267348806da3` plus the implementation working tree. The user approved the written design and authorized implementation, merge after required checks, and local deployment. This record separates implemented behavior, measured checks and remaining acceptance work.

## Scope

- Persistent owned agents, immutable versions, source/tool ceilings, explicit scoped memory and provenance-preserving sharing.
- Holdings-first navigation, reusable connection setup, capability cards, selected-agent research and resumable guided team creation.
- Standing team agreements with immutable revision history; finite recurring commissions, cross-cycle caps, trusted system adoption/application and pause fences.
- Real A2A1.0 JSON-RPC discovery/send/poll/cancel, encrypted credentials/results, durable no-resend recovery and actual structured-delivery verification.
- Nullable persistent identity/version/team/work/attempt telemetry, honest unknown external usage and metadata-only export. RL/RSI training remains deferred.

Migrations62–65 are additive, registered at application startup and included in the generated fresh schema. Existing data, original user drafts, financial history and immutable source snapshots remain owned by their existing modules.

## Review findings and fixes

Independent backend review identified moderator-order overwrite, duplicate persistent people in one commission and overbroad archive rejection. Regressions prove the explicit/template moderator is preserved, duplicate people are rejected, and only exact server dispatch receipts permit archived work to settle. Automatic teams additionally retain the previous immutable running agreement revision under an archive-only stop; history may settle, while new calls, system adoption and automatic application remain denied. Explicit pause and source/tool/connection revocation still block final publication/application.

Independent A2A review reproduced a late polling/cancellation response overwriting a completed raw artifact. The response, encrypted raw payload, correlation and derived status now commit under one row lock; terminal receipts survive both concurrency orders. Recovery never resends an uncertain original task.

Independent frontend review found unavailable selected agents silently falling back to defaults, incorrect moderator labels, stale preview retry loops, wrong agreement-account links, editable saved connection-test fields, missing pre-authorization external-fee disclosure and a delayed seat-conversion response targeting another seat. Each issue has a focused regression or explicit UI correction.

Compiled provider verification found an eager LocalAgentsService dependency cycle. The roster now receives an explicit read-only local-status port through its module adapter, and the compiled provider graph resolves without bootstrapping jobs.

## Verification record

All database tests use disposable PostgreSQL16 databases with fictional records. A2A tests run an actual loopback HTTP fixture, including roster→Council→published team commission execution; provider transports are fictional. Browser checks use intercepted API fixtures and actual React pages, separately from transactional backend checks. No paid personal-model or real-broker call is an acceptance probe.

| Check | Measured result |
|---|---|
| Combined final new-backend suite (roster, Council identity, run agreements, A2A and telemetry) |57 passed, no failures/skips |
| Roster ownership/version/memory focused checks |10 passed, no skips |
| Team standing-agreement focused checks |11 passed, no skips; archive-only automatic-cycle increment3 passed |
| Council role/archive/tool focused checks |20 passed plus25 tool regressions |
| Independent moderator/duplicate-person recheck |11 passed, no skips |
| A2A protocol and real HTTP/PG integration after concurrency fix |11 passed, no skips |
| Full telemetry suite |62 passed, no skips |
| Guided setup/resume checks |22 passed, no skips; eight lost-response stages replay exact requests |
| Frontend review regressions |15 passed; latest stale-renewal and seat-switch checks2 passed |
| Compiled application provider graph |Passed; no jobs bootstrapped |
| Module boundaries |10 passed |
| Contributor helper tests |15 passed |
| Complete client suite |570 passed, no failures/skips |
| Native fixtures (Windows serial) |202 passed;1 POSIX-only process-group case skipped |
| Development supervisor (Windows) |8 passed;1 POSIX-only case skipped |
| Full lint / Web build |Passed; final changed-source build/CI recorded with PR |
| Complete memory evaluation |99 passed, no failures/skips/cancellations |
| Final complete server revision |Required Linux PR CI is authoritative; initial Windows aggregate and focused repairs described below |
| Actual browser desktop1440 / mobile390 |Added five recommended agents, selected three, reviewed seed/fees/replacement, started and paused; mobile scrollWidth390 at viewport390 |

The first full client run exposed compatibility failures from the changed navigation and new roster query. A later run reached569/570; its remaining render fixture lacked an explicit persistent roster and was corrected. The subsequent complete run passed570/570 with zero skips. The first full server run was stopped at a stale test waiting forever for the removed hidden single-person summary; that scenario now uses a genuine moderated group with a bounded wait and passes. These incomplete runs are not pass evidence. The initial full Windows server run completed1403 cases (1387 passed,16 failed,0 skipped) while fixes were being made. All failing cases were subsequently rechecked in focused suites; the exact final complete revision is gated by Linux PR CI. The later full memory evaluation passed99/99 with zero skips or cancellations. Windows app/Docker database clock differences are handled in fictional fixtures by waiting for the saved availability timestamp; production source-time guards remain strict.

## Limits

No five-participant novice study has been performed. Desktop/mobile browser checks cannot establish the design target of four out of five first-time users completing the journey and explaining simulation, fees and pause.

A2A supports the declared nonstreaming v1 JSON-RPC profile, without URL artifacts, push callbacks or remote interactive continuation. Local endpoints need exact deployment registration and explicit user trust. Internal external-agent behavior and real bill amounts remain unknown; calls-only caps cannot guarantee a provider bill ceiling.

Standing reservations conservatively retain each cycle’s maximum usage, including uncertain work. Verified trading-calendar coverage fails closed outside its supported range. Paper results are simulated, and research completion or applied rules never imply an actual fill.

Real provider compatibility, long-term strategy quality and RL performance are separate future evaluations. No automatic training, self-modification or return-quality claim is made.
