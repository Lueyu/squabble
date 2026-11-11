# Source-host tool connectivity and cancelled-response recovery

Baseline: merged main `0d88fc4f9e1954d305aee6dcda96ab9a97958b2d` (PR94).
The standard container suite has passed its published-image gates. The actual
Windows native Web deployment exposed the two faults below. This follow-up is
necessary to complete the already-authorized local deployment; it does not
authorize paid research or change personal grants/preferences.

## Observed failures

1. Docker Desktop29 reports configured port bindings but no effective published
   ports for Docling/broker connected exclusively to the internal tools network.
   The AKTools container with an ordinary bridge attachment publishes normally.
   The native host cannot reach the otherwise healthy internal-only workers.
2. The official MCP client cancels a nonempty HTTP202 notification body. The
   current `Transform` -> `Readable.toWeb` bridge reproducibly crashes Node24.16
   when buffered data enqueues after cancellation. A synthetic localhost202
   fixture reproduces the actual fatal trace; it uses no personal endpoint.

## Required behavior and boundaries

- Keep Docling and broker on the internal-only network. Do not grant either
  Internet access to obtain host forwarding. Standard container-to-container
  access remains unchanged.
- Add a source-host-only relay using the existing prepared Node image. It has
  exactly two fixed service destinations, no caller-controlled destination,
  no Docker socket, credentials or application state. Run nonroot/read-only,
  drop capabilities and publish only loopback ports. Preserve TCP backpressure,
  half-close/cancel handling, finite connections and idle deadlines.
- Replace the vulnerable Web stream adapter with explicit guarded lifecycle
  handling. Cancellation must stop upstream work without a late enqueue/close,
  leaked listeners or unhandled errors. Preserve current DNS pinning, private
  service allowlists, TLS checks, redirect/response limits and abort semantics.
  Do not use a global exception handler or suppress the fatal error.
- Preserve existing DB, keys, state roots, model configuration, preferences and
  grants. No personal activation/model probe/research/trade is an acceptance
  operation. Recheck due work immediately before startup.

## Implementation and verification

- [x] Add deterministic failing MCP202-body-cancel, early cancellation, partial
  read/abort and bounded-body regressions; implement the lifecycle fix and run
  focused transport/provider tests on native Node24.16 and image Node24.22.
- [x] Add relay tests before implementation: fixed destinations, bounded
  connections, stream/backpressure, half-close, reset, timeout and shutdown.
  Extend deployment contracts and verify the relay script is present in full
  source releases. The ordinary container archive retains its existing scope.
- [x] Verify actual Docker Desktop loopback reachability through the relay,
  authenticated worker readiness, preserved internal-only worker networks,
  blocked direct Internet and absence of relay credentials/socket/mounts.
- [x] Review all five architecture flows and canonical contributor knowledge;
  document the source-host route while preserving investment/ledger authority.
- [ ] Run relevant regression suites, context/architecture/build/lint and all
  required PR checks. Independently review and merge the exact tested head.
- [ ] Re-stage the exact merged source, preserve matched backup and start the
  native3192 service through the normal hidden launcher. Verify health/local
  auth, metadata readiness, stable process and unchanged personal business/model
  usage records. Update private locator/global skill after successful delivery.

The published archive acceptance is separate: a fresh disposable project using
actual registry digests must retain its own empty-volume/first-owner evidence.
Local relay tests do not replace that standard new-user acceptance.
