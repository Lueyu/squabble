# Team simulation acceptance

Run from the checkout that contains the client and server builds you want to
verify. Use the pinned Playwright Chromium and FFmpeg, and a disposable
PostgreSQL cluster with an empty **squ_acceptance_test** database on port 55491.
The role needs to create and drop its own schemas.

```powershell
npm run build:web
$env:SQU_ACCEPTANCE_DATABASE_URL = 'postgresql://postgres:test-only@127.0.0.1:55491/squ_acceptance_test'
npm run test:team-acceptance
```

Use the disposable cluster's credentials. The runner verifies the database
identity, creates a fresh schema, and boots the compiled Nest entry point on a
new loopback port. It drops its schema on exit. Chromium loads the actual
application and its APIs. The provider fixtures respond to exact model and
market requests. The local fixture uses the pairing and polling HTTP protocol
and advertises the MCP transport capability required by team research. It sends
structured replies to real commands. The test requires a date covered by the
bundled US calendar.

The desktop user registers, imports holdings, tests a model connection after
one rejection, creates a team with saved friends, and explicitly authorizes a
run. The browser loses the first successful startup response. The test checks
the exact retry payload and persisted agreement revision. The accepted model
summary proposes a fixed order and cites the actual frozen team-account
evidence ID. The test requires an applied cycle and records the report version,
accepted attempt, policy revision and paper trade. It checks the fill in the
run overview and opens that account's ledger before pausing.

The existing narrow-screen user pairs a companion and publishes an observation.
The account initially has zero fills. The test separately approves a fixed
user rule and verifies that its real paper-ledger fill does not appear as team
execution. It checks account ownership, timestamped valuations, a missing
quote observation, keyboard account switching and an immutable report deep
link. The order's **filledAt** follows the simulated market clock. PostgreSQL
records its actual wall-clock insert time separately.

For the 55e457f baseline, run **npm run test:team-acceptance -- --baseline**.
This mode uses observation-only model output and checks the independent fill
in the ledger. The baseline omits the automatic execution proposal at
publication and lacks the new TeamRun fills section. Its lost-start feedback
incorrectly reports a model connectivity issue. The runner uses the persisted default input budget and reports any
pre-dispatch rejection. Use **npm run test:team-acceptance -- --legacy-ui** to
exercise the executable proposal on a server build with the older client.
That mode checks report-to-fill attribution through the real assets API.
Run the default command for the TeamRun fills projection and ledger link.

## Evidence

Check **output/playwright/team-acceptance/<run>/result.json** for the current
step, actual API and PostgreSQL identifiers, and any assertion failure. The
directory also contains recordings, PNG captures and an accessibility
snapshot for each browser failure. For a combined build, use the captures
with these approved design nodes.

| Captures | Approved Figma nodes |
| --- | --- |
| Import and seed | Import review (272:1197) and seed review (274:1236) |
| Settings | Model API desktop (273:1248) and local Agent narrow (273:1342) |
| Configuration and consent | Organization (274:1372) and startup review (289:1712) |
| Run, report and ledger | First research (281:1746), run history (270:998) and ledger (281:1610) |
| Comparison and account switch | Overview (277:1616) and paper holdings (281:1824) |

Adjust the control names and navigation in **browser.cjs** when the combined
build changes them. Verify Figma parity from the actual captures. The test
does not use a production provider, a desktop installation, or deployment.
