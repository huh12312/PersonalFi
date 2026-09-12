<!-- SPDX-License-Identifier: MIT -->

# WP 0.4 evidence — license gate (D15, master plan §4 supply-chain items under D14)

Collected 2026-09-12 by running `node scripts/check-licenses.ts` (`just
licenses`) directly against this tree's committed `pnpm-lock.yaml` — no
`pnpm install` was run (collision rule); the existing `node_modules` from an
earlier `pnpm install --frozen-lockfile` was reused, which is all this script
needs (`pnpm licenses list --json --prod|--dev`).

## What the gate checks

`scripts/check-licenses.ts` reads `licenses.policy.yaml` (the single source
of truth) and classifies every package in the runtime (`--prod`) and
development (`--dev`) dependency trees, across the whole pnpm workspace, into
`allow` / `reviewRequired` / `deny` / `unknown`:

- **prod tree**: `deny` or `unknown` fails the build; `reviewRequired` is
  recorded in `THIRD_PARTY.md` and printed, but does not fail (MPL-2.0 et al.
  are fine for an unmodified, dynamically-consumed dependency — see the
  policy file's own comment).
- **dev tree**: exempt from the `allow`/`review`/`deny` copyleft scoping
  (devDependencies are never distributed) but _not_ exempt from `unknown` —
  an unparseable license is treated as all-rights-reserved regardless of
  scope — and never exempt from `denyPackages` (name-based deny, e.g.
  `argon2`, `better-sqlite3`, `sodium-native` — native bindings this
  Alpine/no-native-deps policy avoids on principle, per D13).
- Regenerates `THIRD_PARTY.md` from the prod tree on every run, pass or fail.

## Run output

```
$ node scripts/check-licenses.ts
license gate: 260 prod package entries, 620 dev package entries checked

license gate: PASS
THIRD_PARTY.md regenerated.
```

No `allowed-with-review` lines were printed, meaning the **prod** tree
contains zero packages under a `reviewRequired` license (MPL-2.0, LGPL-_,
EPL-2.0, CDDL-_) today. This matters specifically because `licenses.policy.yaml`
calls out one _known_ occurrence of a reviewRequired license in this
workspace — Vite's transitive `lightningcss` (MPL-2.0) — and states it "must
never reach the runtime image." The license gate alone cannot prove that
(it only sees the dependency graph, not which image ships which files);
`docs/evidence/phase-0/wp0.4-container-hardening.md`'s "lightningcss ...
absence from the api image" section is the check that closes that gap, by
grepping the actually-built `personalfi/api:dev` image. Together: prod tree
has no reviewRequired entries (confirmed here) _and_ the one known
MPL-2.0 dependency in the whole workspace is proven dev-only and absent from
the shipped image (confirmed there) — the two facts the "MPL is fine because
it's dev-only" argument in `docker/api.Dockerfile`'s header actually rests on.

## `THIRD_PARTY.md` drift check

```
$ git status --porcelain THIRD_PARTY.md
$ git diff --stat THIRD_PARTY.md
(no output — zero diff)
```

The regenerated file is byte-identical to the committed copy: the lockfile
has not moved since `THIRD_PARTY.md` was last generated. This is exactly the
check CI's `license-gate` job runs as its second step
(`git diff --exit-code -- THIRD_PARTY.md`) — reproduced here locally with the
same result. 260 production packages are listed, grouped by SPDX license
identifier: `0BSD`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`,
`MIT`, `MIT and ISC`, `Python-2.0`, `Unlicense` — no `MPL-2.0`, no
`LGPL-*`, no `GPL-*`/`AGPL-*`, no `UNKNOWN`.

## Deny-list and named-package checks

None of `licenses.policy.yaml`'s `denyPackages` (`hyperformula`,
`Levenshtein`, `python-Levenshtein`, `fuzzywuzzy`, `ofxtools`, `beancount`,
`sodium-native`, `argon2`, `better-sqlite3`) appear anywhere in either tree —
confirmed by the clean `PASS` above, since any one of them would have failed
the run regardless of its declared license (name-based deny is checked
first, before license classification, in `analyze()`).

## Interaction with `trivy fs`'s `js-yaml` suppression

`.trivyignore` separately suppresses three `js-yaml` CVEs (transitive via
`@hey-api/openapi-ts`, an `apps/web` devDependency) with a 2026-10-12 expiry.
That is a _vulnerability_ finding, not a _license_ finding — `js-yaml` is
MIT-licensed and passes the license gate cleanly in both trees. The two
suppression mechanisms (`.trivyignore` for CVEs, `licenses.policy.yaml` for
licenses) are independent and this is the one dependency that happens to
show up in both contexts, for unrelated reasons.

## What this does not cover

- The gate runs against the npm/pnpm dependency graph only. It has no
  visibility into apk packages baked into `docker/backup.Dockerfile` /
  `docker/caddy.Dockerfile` (`postgresql18-client`, `age`, `rclone`, `caddy`
  itself) — those are covered by `THIRD_PARTY.md`'s own scope note (npm
  runtime tree only) and by the base images' own upstream licensing (Alpine:
  MIT-style/BSD per-package; Caddy: Apache-2.0; age: BSD/MIT; rclone: MIT).
  Not a gap in this WP's brief (docs/research/06 §5.4 scopes the gate to the
  npm tree specifically) but worth naming so nobody assumes the gate is
  broader than it is.
- CI also runs `git diff --exit-code -- THIRD_PARTY.md` as an independent
  drift check on every PR — reproduced above locally with the same clean
  result, not just asserted.
