# Source-host tool recovery acceptance

Baseline: merged main `0d88fc4f9e1954d305aee6dcda96ab9a97958b2d`, PR94.
The recovery plan was written before implementation in
[the follow-up plan](superpowers/plans/2026-11-11-source-host-tools-recovery.md).
This record separates verified recovery behavior from the final merge and local
restart gates.

## Actual faults and fixes

The native Windows server initially served health, local authentication and the
Web page, then crashed during MCP metadata refresh. Node24.16's
`Transform`/`Readable.toWeb` adapter could enqueue buffered HTTP202 notification
bytes after the official MCP client cancelled the response. A synthetic
localhost fixture reproduced the identical fatal `ERR_INVALID_STATE` trace.
The replacement body uses guarded async reads, backpressure and explicit HTTP
destruction on cancellation. It retains DNS pinning, private endpoint allowlists,
TLS validation, redirect rejection and response bounds. No global exception
handler, ignored crash or Node patch is used.

Docker Desktop also retained configured bindings without effective published
ports for workers attached only to the internal tools network. A source-host-only
relay now publishes two loopback ports to fixed Docling/broker destinations.
The engines remain internal-only. The relay reuses the prepared Node image,
runs nonroot/read-only/capless, has bounded connections/deadlines/buffers and
mounts only its read-only source file. It receives no credentials, Docker socket
or application state and accepts no destination from the wire/environment/CLI.
The ordinary container archive does not require this relay or change scope.

## Completed checks

- Transport/official MCP regressions:10/10 on native Node24.16 and10/10 on the
  isolated Node24.22 application image, zero skips. The cancellation regression
  failed before the fix. Independent parent execution also passed10/10.
- Relay regressions:6/6; combined deployment suite13/13 and gateway Python3/3.
  Binary streaming, backpressure, half-close, cancellation, refusal, shutdown,
  admission, idle/lifetime bounds and protocol-specific health checks are covered.
  The health regression rejected the original uniform status-field assumption.
- Actual Docker Desktop source-host test in a separate fictional project:
  Compose `up --wait` exited0; real host loopback document/broker/AKTools metadata
  was reachable. Private paths rejected missing authorization, scoped bytes were
  preserved and unknown operations were rejected. No compute job was created.
  Docling and broker had no effective host ports/default gateways and actual
  outbound Internet probes failed. Only the relay had loopback publications.
  It ran as uid1000 with64 MiB cgroup limit; observed peak was28,557,312 bytes.
- Three real AKTools initialize/list-only discoveries through the fixed native
  transport safely handled its nonempty202 body. They invoked no business tool,
  model, database operation or grant change.
- Independent transport and relay reviews found no P1/P2 issue. Architecture9/9,
  contributor helpers15/15 and context structural validation passed. All five
  diagrams were reviewed: only the system source-host route changes; research
  identity/budget/publication and investment/channel/ledger authority remain.

The personal failed-start audit retained original records, private files and
model usage. Metadata preparation added a managed connection; the existing
scheduler appended a valuation snapshot. Original valuation rows were separately
verified unchanged against the protected restored backup. No state was deleted
or restored over the live database. Personal grants remain unactivated. Private
matching backup/recovery and final restart receipts stay outside Git.

The original main's standard published suite passed its separate GitHub release
gates, including actual cold boot, offline OCR, Chromium, MCP and full real
sandbox exhaustion/recovery. Its local downloaded archive additionally passed
SHA/tar/manifest checks; local registry download/startup evidence is separate.

## Remaining delivery gates at this commit

Run the required checks on the exact recovery PR, merge its tested head, update
the stopped native candidate from that merged source and repeat actual local
metadata preparation/process-stability checks. Preserve matched backups and
existing owner grants; no paid model probe or personal research is a smoke test.
