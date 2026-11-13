# Deterministic UI audit

This is a finite, fictional UI scan. It does not start the Nest server, connect a
database, call AI, send messages or place trades. `fixture-server.cjs` serves
`dist/client` and process-local fake HTTP responses; other upstream origins are
blocked. Run `npm run build:client` before starting the fixture.

The completed repair and screenshot comparisons are in [REPORT.md](REPORT.md).
Run the fixture in one terminal and the probe/gate in another.

For the later user-requested compact desktop proportions, run `npm run build:client`
and `npm run ui:density`. This18-scenario acceptance uses a self-contained
fictional HTTP server and real compiled CSS, without browser zoom or a personal
backend. It checks overview chart visibility and research-pane scrolling, rather
than updating any approved baseline. See the [compact UI and removal record](../docs/compact-ui-team-removal.md).

```powershell
npm run ui:fixture -- --port 4173
npm run ui:lock -- --check
npm run ui:probe -- --capture before --output output/playwright/ui-audit/before
# After the reviewed source edits and a new client build:
npm run ui:probe -- --capture after --output output/playwright/ui-audit/after
npm run ui:gate -- --vs output/playwright/ui-audit/before/before.json --current output/playwright/ui-audit/after/after.json
npm run test:ui-probe
```

`route-matrix.json` freezes 112 route/state/viewport scenarios at widths
1440/768/390/320. Every scenario gets a new Chromium context, fixed time,
language, light theme, reduced motion and a screenshot with animations disabled.
English, multilingual long descriptions, agent editor, personal memory,
external-agent details and all three guided-team stages use fictional data.
The final startup checkbox is never selected and the team is never started.

Snapshots contain detector/matrix/token fingerprints, scenario status and
structured findings with code, severity, route, state, viewport, selector,
rect, computed styles, numerical metric, source hint and screenshot path.
The script can filter `--route`, `--viewport`, `--state`, or `--only` for focused
reproduction. Filtered captures are incomplete and cannot pass the gate.
Examples use `node scripts/ui-probe/probe.cjs` when npm scripts are unavailable.

The gate rejects any new P0, any new P1 identity (including severity escalation),
missing/failed/duplicated scenarios, changed matrix/detector/token fingerprints,
changed browser/OS/font environment, or weighted improvement below 8
(P0=10, P1=3, P2=1). `--min-gain N` can set a
positive threshold for an explicitly chosen run. Identical debt counts with
different P1 selectors do not pass. `ui:lock` only checks; it never overwrites.
Token fingerprints cover scoped CSS variables and font-family declarations in
theme/typography/index/mixed workspace styles and the entire Tailwind config;
layout declarations in mixed stylesheets remain editable.

There is **no approved baseline.json**. A `before.json` capture is evidence for
this run and has `approvedBaseline: false`; neither probe nor gate creates,
approves or updates a formal baseline. Output belongs under the ignored
`output/playwright/ui-audit/` directory. Screenshots require human inspection;
they are not pixel-diff assertions or approval records.

This iteration dispatches repairs manually by disjoint file families. There is
no automatic crawler, clustering, nightly job, auto-merge or baseline approval.
See [dictionary.md](dictionary.md) and [KNOWN.md](KNOWN.md) for the implemented
rules and their limits.
