## What and why

<!-- Describe the behavior change and the problem it solves. Link an issue if there is one. -->

## Verification

<!-- List commands run and manual checks. Explain any skipped check. Web-only phase: Lint & typecheck, Agent tests, Docker image build. Desktop checks are manual-only until resumed. -->

## Data and release impact

<!-- Describe migrations, existing local data, Docker updates, desktop installers or user-facing changes. Write "None" when not applicable. -->

## Checklist

- [ ] The PR is focused on one feature or fix and is based on current `main`.
- [ ] I ran `npm run lint` and relevant tests, or explained why I could not.
- [ ] I added no secrets or personal data, including real holdings in demo data.
- [ ] I updated Chinese and English UI text and docs where behavior changed.
- [ ] I described how existing installations keep their data, if this changes storage or deployment.

Before merging: wait for all required CI checks, bring the PR up to date with
`main`, resolve review conversations and follow the maintainer merge convention
in [CONTRIBUTING.md](../CONTRIBUTING.md).
