# Capability backend validation notes

Task 2 implementation follows the saved bundled-capabilities design. No personal database, paid model/cloud call, or real order was used by this worker.

- Migration 59 adds owner grants, deployment readiness facts, stable managed AKTools bindings and active/candidate catalog pointers. Migration 60 from the sandbox worker is registered and included in the fresh schema.
- Capability GET is read-only. Explicit refresh performs only bounded readiness and MCP metadata discovery. Activation binds the displayed manifest, owner revision and exact AKTools catalog ID/hash. Repeated identical activation preserves authority revisions.
- Managed AKTools is excluded from generic model-facing external catalogs. Its financial facade constructs the fixed CN daily-history/HK profit-statement request and rechecks grants before dispatch and in the publication transaction.
- Document tasks bind grant revision in the internal configuration version. Browser runs bind their grant revision durably; revoke/re-enable cannot revive old work. Research evidence acceptance holds the matching grant lock through publication.
- Sensitive browser runs can start only at exact public evidence URLs frozen at creation. Owner/private library URLs do not authorize navigation. The trusted runtime scope can widen sensitivity; model arguments cannot supply approved URL lists. Public-only runs retain normal public URL navigation.

Observed RED cases: unchanged discovery incorrectly advanced revision; missing capability service; document result survived revoke/re-enable; repeated identical activation advanced all grant revisions; missing browser provenance authority/helper.

Observed GREEN before final provenance verification: server TypeScript check; 9 architecture tests; connection grant/encryption/OAuth tests; catalog no-op/addition/candidate tests; owner activation and stale-catalog batch rollback; stable managed binding with a duplicate custom endpoint; document receipt/source deletion and revoked-result tests; persistent browser grant revision; financial immutable dataset/late-disable test; Docling and MinerU protocol tests; fresh/upgrade/replay including persisted disabled grant.

Final browser provenance tests passed: exact frozen URL allowed; appended private query and caller-forged URL list rejected; current private scope tightens a public run; public-only runs keep public navigation. A final library-search test also demonstrated a public-only documents grant reaching search before the explicit private-material gate was added. The parent worker tracks whole-repository lint/build/CI. Actual Docling OCR, Chromium, AKTools upstream and Docker sandbox acceptance are separate from these fixtures and must not be represented as passed by metadata registration.
