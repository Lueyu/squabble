# Research memory roadmap / 研究记忆升级路线
Updated: 2026-11-04. Baseline: main `6ed6c4d`.

## Product outcome / 产品目标
A personal research and automatic paper-trading assistant that keeps each investment thesis, its boundaries, evidence and changes explainable. 用户每天可以看清判断变化、依据、模拟动作和结果。

## Delivery order / 实施顺序
| Stage | Issue | Depends on | Acceptance outcome |
|---|---|---|---|
| M1 | [#57](https://github.com/Lueyu/squabble/issues/57) Atomic theses / 独立论点 | Existing P1 | Reviewed research produces claims with evidence and explicit missing boundaries; no summary slicing masquerading as a thesis. |
| M2 | [#58](https://github.com/Lueyu/squabble/issues/58) Whole context / 完整注入 | M1 | Token-budgeted whole units; per-attempt sent IDs/versions and omission reasons. |
| M3 | [#59](https://github.com/Lueyu/squabble/issues/59) Time and provenance / 时间与来源 | M1 | Separate fact periods, publication, observation and thesis review times; comparable evidence relations. |
| M4 | [#60](https://github.com/Lueyu/squabble/issues/60) Reliable archives / 可靠归档 | M1, M3 | Retryable archival jobs and historical import; batch recall includes older active theses. |
| M5 | [#61](https://github.com/Lueyu/squabble/issues/61) Monitoring and strategies / 条件与策略 | M2, M3, M4 | Valid observations create idempotent review events; revoked/breached dependencies fence paper orders. |
| M6 | [#62](https://github.com/Lueyu/squabble/issues/62) Research dossier / 股票研究档案 | M1–M5 | User sees boundaries, ownership, changes, sent memory and archive/monitor status. |
| M7 | [#63](https://github.com/Lueyu/squabble/issues/63) Retrieval evaluation / 检索评测 | M1–M6 | Task-aware retrieval and counterevidence; reproducible operation-level fixtures and request-level regressions. |

## Execution checklist
- [x] M1 structured delivery and archival (implementation and focused reviews complete; final integration/PR checks pending)
- [x] M2 intact token-budgeted context and telemetry (implementation and focused reviews complete; final integration/PR checks pending)
- [x] M3 temporal evidence and claim relations (implementation and focused reviews complete; final integration/PR checks pending)
- [x] M4 archival recovery and batch retrieval (backend implementation and focused reviews complete; operation UI follows in M6; final integration/PR checks pending)
- [x] M5 monitoring and automatic paper-strategy dependencies (implementation and focused reviews complete; operation UI follows in M6; final integration/PR checks pending)
- [ ] M6 research dossier and bilingual interactions
- [ ] M7 evaluation and retrieval tuning
- [ ] Whole application verification, migrations, review and PR

## Boundaries / 边界
- Preserve account isolation, revisions, tombstones, local-agent simplicity and the existing paper risk gate.
- Agent research judgments may evolve automatically after validation; user endorsement and risk limits remain separate.
- Never invent missing conditions, evidence dates or calibrated probabilities. Retrieved memory is untrusted opinion.
- No additional silent paid extraction. Historical import restores report history; explicit model-assisted legacy extraction is a later extension.
- Provider tokenization is exact only where supported. Local CLI internal context is not observable; sending does not prove model use.
- First monitoring sources are the existing validated price and completed daily indicators. Unsupported financial/text conditions remain visibly unsupported.
- Independent graph/vector databases, arbitrary model-generated monitor code, real brokerage execution and institution-specific approval workflows are not part of this delivery.
- Semantics beyond deterministic term aliases/linked evidence require a measured retrieval need before adding embeddings.
- Daily overview, extensive experience mining and portfolio-wide attribution remain later product increments, not prerequisites of memory integrity.

## Validation
Use offline model/native fixtures, disposable PostgreSQL, zh/en UI checks and real serialized executor requests. Test revocation, CAS races, repeated monitor ticks, failed archival retry, 100+ report histories and fresh/upgrade schemas.
Follow CONTRIBUTING: lint, server/client/desktop/local-agent tests, builds and all six required PR checks. No performance or accuracy claims without measured results.

Local tutorial and architecture diagrams live in ignored `docs/local-development/`. They are not published to GitHub.

