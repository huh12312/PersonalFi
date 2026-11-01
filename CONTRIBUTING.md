<!-- SPDX-License-Identifier: MIT -->

# Contributing to PersonalFi

PersonalFi is a self-hosted personal finance application with one maintainer. Contributions are
welcome. This page covers how to run the project, what a change has to pass, and the rules that
the code does not make obvious.

To report a vulnerability, do not open an issue. Follow [`SECURITY.md`](SECURITY.md).

## Licence of your contribution

PersonalFi is MIT-licensed ([`LICENSE`](LICENSE)). There is no contributor licence agreement and no
sign-off line to add to commits. **By opening a pull request you agree that your contribution is
licensed under the repository's MIT licence.**

## The development loop

You need Node 26, pnpm 12, Docker with Compose v2, and [`just`](https://github.com/casey/just).
[`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) is the full reference; this is the short path.

```bash
just install    # pnpm install --frozen-lockfile
just db-up      # dev Postgres on 127.0.0.1:5433
just migrate    # apply pending migrations
just dev        # run the API against the dev database
just up         # or run the whole stack in Docker (see the README's Install section first)
just verify     # run this before every push
```

`just check` (typecheck, lint, test) is the quick loop. `just verify` is what predicts CI: it adds
the web build, Playwright, gitleaks, the licence gate and `THIRD_PARTY.md` drift, the
compose-hardening gate, the `.trivyignore` expiry sweep and a trivy scan, using CI's pinned tool
digests. Run `just --list` for every recipe. `just test-unit` runs the unit projects and needs no
database; `just check-docs` checks that the README, RUNBOOK and release notes name only recipes,
variables, secrets, paths and links that exist.

## What to read first

- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md): package layout, the dependency rule, migrations,
  money, time, errors, configuration.
- [`docs/TESTING.md`](docs/TESTING.md): test layers, the test database harness, sabotage evidence.
- [`RUNBOOK.md`](RUNBOOK.md): how an install is operated, which is what a change has to keep
  working.
- [`docs/security/threat-model.md`](docs/security/threat-model.md): what is defended and what is not.
- [`docs/plan/00-master-implementation-plan.md`](docs/plan/00-master-implementation-plan.md): the
  decisions already taken. Read it before proposing a change to one.

## Rules that are not obvious from the code

**Tests never call a live model or a live vendor.** Every provider, bank aggregator, price feed and
language model has a fake, and tests use the fake. A test that needs the network is a bug in the
test. Live runs, such as the control checks below and `scripts/redteam-live.ts`, are started by an
operator by hand and never by CI.

**Every migration is expand-only, and an applied migration is immutable.** The runner stores a
SHA-256 for each applied file and refuses to start if one changes. To alter a table, add a new
migration with `just migrate-new name=add_something`. Anything destructive is split across
releases: add, backfill, switch reads, switch writes, drop later. There are no down migrations.

**Figures are `Money` or decimal strings at every boundary.** Never a float where an amount, a
quantity or a price is carried. `scripts/check-numeric-boundaries.ts` enforces it and runs inside
`just lint`. Its rules and its fixtures are in [`docs/TESTING.md`](docs/TESTING.md).

**Copy a holder reads passes the copy linter.** Text that reaches the holder from the advisor, the
Brief or the narrator is checked by `packages/contexts/insights/src/advisors/copy-lint.ts`, which
refuses banned phrasing ("you should", "we recommend", "guaranteed returns"), sentences that open
with an instruction, untraced numerals and merchant tokens in prose. Add a case to
`packages/contexts/insights/test/copy-lint.test.ts` when you add a rule.

**The model writes words, not numbers.** A figure shown beside a model's text is placed by the
application from its own evidence. The numerals check refuses any digit or number-word the
application did not supply. Do not weaken it to make a prompt pass.

**A package lands with its evidence file, sabotage first.** Work is organised in numbered work
packages. Each one adds `docs/evidence/phase-N/wpN.M-<name>.md` recording what was built, the checks
run and, for every new invariant, the exact change to production code that should break it and the
failure output you saw. A control that has never been watched failing is not evidence. Write the
test, break the code on purpose, watch it fail, then restore the code. See "Sabotage evidence" in
[`docs/TESTING.md`](docs/TESTING.md).

**A context never imports another context.** Use a domain event. `personalfi/layer-imports` in
`eslint.config.js` enforces the allow-list.

**Time and ids go through the kernel.** No `Date.now()` or `new Date()` outside `Clock`, no
`process.env` outside `@core/config`, ids from `newId()`.

## Writing documentation

Plain sentences. Say what the thing does and what it does not do. No marketing, no "simply", no
"just" as a softener. Name a recipe, variable, secret or path only if it exists:
`just check-docs` fails when a README, RUNBOOK or release note names one that does not.

## The GenAI control checks

The narrator's controls are proved against a running install, not only in tests. From the host,
with the stack up and the insights module registered:

```bash
just genai-selftest holder="<name>"
```

It prints one row per control and exits 0 (pass), 2 (partial) or 1 (fail). The same checks run from
Settings, Language model, **Run control checks**. If your change touches the narrator, the kill
switches, the egress policy or the validator, run it and say so in the pull request.
[Proving the GenAI controls](RUNBOOK.md#proving-the-genai-controls) lists what each check proves.

## Dependencies

Renovate owns dependency bumps (`renovate.json`). Do not bump a package by hand in an unrelated
change. A `minimumReleaseAge` of seven days means a version is not proposed, and should not be
installed, until it has been public for a week. Versions are pinned exactly, install scripts are
disabled, and a runtime dependency must carry a licence on the allowlist in
[`docs/research/06-platform-devops-licensing.md`](docs/research/06-platform-devops-licensing.md)
§5.4 (the permissive licences; MPL-2.0 is accepted with a review note; `scripts/check-licenses.ts`
is the gate). Check the registry's `license` field before you add a package, and prefer not adding
one.

## Pull requests

Keep a pull request to one change. State what it does and what you ran: `just verify`, and the
evidence file if the change is a work package. CI runs the same gates as `just verify`; a red check
is the first thing to look at. The maintainer reviews in the order PRs arrive and may ask for
sabotage evidence on a new control.
