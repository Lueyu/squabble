# Research records, chat workspace and navigation refinement

The user requested four concrete corrections, then integration into main and local deployment. Continue the existing isolated `codex/ai-friend-v4` branch and PR89, preserving the prior portfolio/history work.

## Behavior and ownership

- Backend: owner-scoped report-version and research-session deletion. Additive49 persists tombstones and request receipts; synchronize fresh-schema and narrow database fixtures. Repeated requests retain the same outcome, and legacy import/recovery/late publication must not recreate deleted records. Preserve ledger rows and immutable execution snapshots.
- Report list: one delete action per row and one confirmation, with explicit version identity and a stable request key after uncertain transport. Remove the confirmed record without leaving its list/date; deleting the last record on a later page returns to the previous page.
- Research workspace: remove the four capability links. Reuse the persisted research conversation in a large chat area, with a desktop history sidebar and a mobile history layer. Selecting, returning, creating and deleting tasks preserves drafts and explicit model-dispatch boundaries. Existing channel URLs remain compatible.
- Assets: align secondary navigation with the content's existing horizontal inset; avoid adding a second inset.
- Settings: preserve the primary workspace sidebar's width, branding, icons, labels and selection styles. Settings adds only its secondary menu.

Reports delete one immutable version, not every version of its document. Deleted reports stop being available as fresh research/strategy evidence; existing trades and frozen snapshots remain. Latest-generated pointers may select a remaining visible version; deleting an adopted version clears adoption rather than silently endorsing another version. Running or provider-uncertain tasks require settlement before removal.

## Delivery checks

- [x] Meaningful database tests for owners, request replay/conflict, revisions, version isolation, no legacy resurrection, source invalidation and late callbacks.
- [x] DOM tests for cancellation, retry identity, one-row deletion, pagination, chat drafts/history and no automatic send.
- [x] Actual desktop/mobile layout review for assets alignment and invariant primary settings navigation.
- [ ] Full lint/client/server/local-agent checks with disposable databases, fresh/upgrade parity, architecture/context checks, production build and provider wiring.
- [x] Independent review and resolve blocking findings; update architecture/contributor references.
- [ ] Push final PR head, mark ready, wait for all required checks/review conversations and merge normally into main.
- [ ] Build the merged revision in a separate release, back up the personal database/config/native journal and verify restore, deploy the merged main to3192, and verify data/native connections and new UI without paid model calls.
- [ ] Synchronize the installed contributor skill from merged main and retain private recovery records.

## Verification before integration

The disposable 3193 browser workspace verified large-chat rendering, original message reading, per-task drafts, mobile history selection and confirmed/cancelled deletion. Actual deletion retained original messages, another report and exact date-filter/back navigation. No question was sent to a model. Tabs and content share x=264 at1440 and x=20 at390; the primary navigation keeps its geometry in Settings. At768–1023 the secondary Settings navigation uses the existing select control so the body remains readable.

The first full server pass exposed a nullable-field-order regression in Drizzle's nested left join and a strict in-memory loader missing the new source helper. The session schema now keeps its non-null id first; all six daily-publication cases pass again. The pending-order race fixture explicitly rejects unexpected strategy/source helper use and passes. Neither financial behavior nor the daily acceptance checks were weakened. Final exact-head CI remains the merge gate; operational merge, backup/restore, deployment and installed-skill results are recorded outside the repository after those operations actually occur.
