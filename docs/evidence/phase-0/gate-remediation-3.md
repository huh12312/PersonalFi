# Gate remediation 3 — R-1..R-8 close-out

Follow-up to `gate-security-review-2.md` (formatting/naming continues that
file's "R-N" numbering) and `gate-security-review-3.md`, R-1 through R-8. This
agent's ownership: `apps/web/e2e/**`, `apps/web/playwright.config.ts`,
`packages/contexts/identity/test/**`, `.github/workflows/ci.yml`, `justfile`
(verify/test/playwright recipes), `vitest.config.ts` (project lists),
`scripts/compose-hardening-check.sh`, `scripts/fixtures/compose-hostile.yml`,
`scripts/check-history-rewrite-before-push.sh`. A prior agent instance was
killed by a rate limit mid-task; its work (R-1, R-2, R-8, and R-4's
`playwright-check` recipe) was snapshot-committed and is re-verified below
rather than redone. R-3, R-5, R-6, R-7 were unfinished and are closed out
here.

Every fix below was sabotaged (observed red) before being accepted as green,
per the standing evidence bar (see `personalfi-gate-lessons` memory: "a
control that has never been observed failing is decoration").

---

## R-1 — CSP directive pinning (`apps/web/e2e/csp.spec.ts`)

**Finding (already fixed by the prior agent instance; re-verified here).**
The runtime CSP tests only asserted _this app_ survives whatever policy
`docker/Caddyfile` happens to send; nothing asserted the policy itself is
strict. A weakened Caddyfile (`'unsafe-inline'` on `script-src`, or dropping
`object-src 'none'` / `frame-ancestors 'none'` / `base-uri 'none'`) would make
the existing tests pass _more easily_, not fail.

**Fix.** `csp.spec.ts`'s third test reads the actual
`Content-Security-Policy` response header from `csp-static-server.mjs` (the
same derived-from-Caddyfile value the runtime tests ran under) and pins
`default-src 'self'`, `script-src 'self'` (exact match, plus a regex ban on
`unsafe-inline`/`unsafe-eval` anywhere in `script-src`), `object-src 'none'`,
`frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.

**Sabotage.** Weakened `docker/Caddyfile`'s `script-src 'self'` to
`script-src 'self' 'unsafe-inline'`, ran `pnpm --filter @app/web exec
playwright test --project csp`:

```
✘ [csp] › e2e/csp.spec.ts:103:1 › the served Content-Security-Policy pins the directives this repo depends on

  Error: expect(received).toBe(expected) // Object.is equality
  Expected: "'self'"
  Received: "'self' 'unsafe-inline'"
    > 116 |   expect(directives['script-src']).toBe("'self'");

  1 failed, 2 passed
```

**Restored, green.**

```
✓ [csp] the served Content-Security-Policy pins the directives this repo depends on (474ms)
✓ [csp] the toast, warning, and update-prompt code paths all render under CSP (1.1s)
✓ [csp] the kitchen sink renders a toast and a dialog with zero CSP violations (1.2s)
3 passed (16.2s)
```

`docker/Caddyfile` diff confirmed empty after restore (`git diff --stat` — no output).

---

## R-2 — Refresh-rotation race tests understated concurrency (`packages/contexts/identity/test/refresh-concurrency.test.ts`, `harness.ts`)

**Finding (already fixed by the prior agent instance; re-verified here).**
Sabotaging `refresh()` back to the pre-M-4 select-then-update shape used to
fail only the 8-racer test; with a lazily-created `max: 6` pool, the _first_
race a test file ran only had as many backends as `pg` had opened so far, so
a 2-way race was effectively serialised and racer B always observed an
already-superseded row for the "correct" reason instead of genuinely racing
the claim.

**Fix.** `harness.ts` gained a `poolMax` option; `refresh-concurrency.test.ts`
warms the pool to its full `max` in `beforeEach` (`RACERS` = 8 backends) and
raises every race in the file from 2 to `RACERS` concurrent callers. Also
gives its scratch database a unique, per-process name
(`personalfi_gateb_${process.pid}_${hex}`) — this repo runs multiple agents
against the same dev Postgres concurrently, and a fixed name would let a
second run's `DROP DATABASE ... WITH (FORCE)` (harness.ts) destroy the first
run's database mid-race.

**Sabotage.** Reverted `sessions.ts#refresh()` to the pre-M-4 check-then-act
shape (read the row, check `superseded_by`/`revoked_at` in TypeScript, insert
the successor, unconditional `UPDATE` — no atomic claim), ran
`--project identity-db -t "refresh rotation is atomic"`:

```
✘ yields exactly one success when refreshes race the same token — expected length 1, got 8
✘ records the reuse rather than silently issuing two generations
✘ survives a wider race: one winner, the rest detected — expected length 1, got 8
✘ never leaves two usable access tokens behind — expected length 0, got 8
✘ does not report an expired family as reuse — promise resolved instead of rejecting

5 failed, 1 passed
```

**Restored, green.** `sessions.ts` diff confirmed empty after restore
(`git diff --stat` — no output). Full `identity-db` project:

```
Test Files  7 passed (7)
     Tests  110 passed (110)
```

---

## R-3 — `testkit`'s db-dependent suites ran in neither CI job (`.github/workflows/ci.yml`)

**Finding (already fixed by the prior agent instance; re-verified here).**
`packages/testkit/test/database.test.ts`'s `describe.skipIf(ADMIN_URL ===
undefined)` suites — the harness every `*-db` project (`platform-db`,
`secretbox-db`, `identity-db`, `api-db`) is built on — ran in neither CI job:
the `test` job sets no `DATABASE_URL` (so they skip there), and `testkit` was
absent from `migration-test`'s `--project` list entirely.

**Fix.** `migration-test`'s vitest invocation now includes `--project
testkit` alongside `db`/`platform-db`/`secretbox-db`/`identity-db`/`api-db`.
Deliberately redundant with `test`'s own `--project testkit` run (the plain
unit-test share of the same project), documented as such in the CI file's
project→job map.

**Verification (equivalent to CI's two jobs, run locally).**

```
$ unset DATABASE_URL; pnpm exec vitest run --project testkit
Test Files  6 passed (6)
     Tests  19 passed | 4 skipped (23)     # the `test` job's shape — 4 db-dependent tests skip

$ export DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev
$ pnpm exec vitest run --project testkit
Test Files  6 passed (6)
     Tests  23 passed (23)                  # the `migration-test` job's shape — nothing skips
```

The 4 tests that only run with `DATABASE_URL` set are exactly the suites this
finding was about; before this fix, no CI job set `DATABASE_URL` while also
selecting `--project testkit`, so they never ran anywhere.

---

## R-4 — `just verify` didn't cover the `web` CI job (`justfile`, `apps/web/playwright.config.ts`)

**Finding (already fixed by the prior agent instance; re-verified here).**
`just verify` used to stop at `just check`, which never ran `pnpm --filter
@app/web build` or either Playwright project — a green `just verify` could
still predict a red CI `web` job.

**Fix.** `verify` now runs `pnpm --filter @app/web build` and `just
playwright-check` after `check`. `playwright-check` fails loudly — never
skips — when chromium isn't installed, with an explicit next step.

**Sabotage 1 (missing browser, R-4's specific bar).** Moved
`~/.cache/ms-playwright` aside, ran `just playwright-check`:

```
Error: browserType.launch: Executable doesn't exist at .../chrome-headless-shell
6 failed
::error::Playwright's chromium browser is not installed. Run: pnpm --filter @app/web exec
  playwright install --with-deps chromium — then re-run 'just verify'.
recipe `playwright-check` failed with exit code 1     (real exit code: 1)
```

**Restored, green.**

```
Running 6 tests using 4 workers
  ✓ 6 [csp]/[chromium] tests
  6 passed (20.0s)
```

**Sabotage 2 (R-8, exercised through the same recipe).** See R-8 below — the
theme-toggle no-op sabotage was run through `pnpm --filter @app/web exec
playwright test --project chromium`, which is what `playwright-check` wraps.

---

## R-5 / R-6 — the push ratchet asserted `.gitleaksignore` text, not history (`scripts/check-history-rewrite-before-push.sh`)

**Finding.** The script's only signal was whether `.gitleaksignore` still
contained the two `c7846dc...` fingerprint lines. That asserts nothing about
actual git history: deleting those two lines (with or without a real `git
filter-repo` rewrite) flips the check either way, and it said nothing about
whether the live bootstrap-enrolment token from commit `c7846dc` was still
reachable by anything a push could carry. Separately, a missing
`.gitleaksignore` was read as "nothing to check" (exit 0) — silently passing
the exact moment someone deletes the file that documents why the true-positive
fingerprints exist at all.

**Fix.**

- **R-6:** once a remote is configured, a missing `.gitleaksignore` is now a
  hard `exit 1` ("its absence is not evidence a history rewrite happened").
- **R-5:** reachability of the actual `c7846dc` secret is now asserted two
  independent ways: (1) is the exact commit object still reachable from any
  local branch/tag (`git rev-list --all`, not the reflog — a real `git
filter-repo` rewrite gives every descendant a new hash, so the original SHA
  drops out of `--all` once the rewrite has happened); (2) does the token's
  own redacted-fingerprint text still appear anywhere in that file's history
  (`git log --all -S <fragment>`), independent of which commit carries it.

  A real subtlety found and fixed along the way: `git rev-list --all | grep
-qx "$SHA"` under `set -o pipefail` is broken — `grep -q` closes its stdin
  as soon as it finds a match, `git rev-list` dies of `SIGPIPE` (exit 141),
  and `pipefail` reports the _pipeline's_ exit status as that signal death,
  not grep's successful match, so the `if` silently took the wrong branch.
  Fixed by capturing `git rev-list --all`'s output to a variable first, then
  `grep -qx <<<"$var"`.

**Sabotage A (fake remote; the secret genuinely is still reachable — this
repo's history has never been rewritten).**

```
$ git remote add sabotage-test file:///tmp/fake-remote-does-not-exist
$ bash scripts/check-history-rewrite-before-push.sh
check-history-rewrite-before-push: commit c7846dc6282f6ae7156e56b36f47a8de14d969aa is still reachable from a local ref
check-history-rewrite-before-push: the token's own fingerprint text is still reachable in history
check-history-rewrite-before-push: FAIL: a git remote is configured and the c7846dc bootstrap
  enrolment token (P0-10, gate §2.8) is still reachable in history that could be pushed.
exit=1
```

Both independent checks fired.

**Sabotage B (same remote, `.gitleaksignore` also removed — R-6's specific bar).**

```
$ mv .gitleaksignore /tmp/gitleaksignore.bak
$ bash scripts/check-history-rewrite-before-push.sh
check-history-rewrite-before-push: FAIL: a git remote is configured and .gitleaksignore is missing.
  This file documents why the c7846dc... true-positive fingerprints are allowlisted;
  its absence is not evidence a history rewrite happened. Restore it, or rewrite history...
exit=1
```

**Restored (remote removed, `.gitleaksignore` restored), green.**

```
$ git remote remove sabotage-test; mv /tmp/gitleaksignore.bak .gitleaksignore
$ bash scripts/check-history-rewrite-before-push.sh
check-history-rewrite-before-push: no remote configured — nothing to check
exit=0
```

`git remote -v` confirmed empty; `.gitleaksignore` restored byte-for-byte
(`git status --short` clean).

---

## R-7 — `SENSITIVE_BIND_PREFIXES` missed `/etc`, `/root`, `/home`, `/boot`, `/var/lib/docker` (`scripts/compose-hardening-check.sh`)

**Finding.** `sensitive-host-path-bind-mount` only covered `/run`,
`/var/run`, `/proc`, `/sys`, `/dev` — sockets, procfs, devices — but a
read-only bind of `/etc` (every credential-bearing host config, `/etc/shadow`
on most distros), `/root` or `/home` (SSH keys, shell history), `/boot` (the
kernel/initramfs), or `/var/lib/docker` (the daemon's own image/container/
volume storage, disclosing every layer of every image on the host) is just as
much a host-escape primitive, and none of them tripped the gate.

**Fix.** Added all five to `SENSITIVE_BIND_PREFIXES`. Extended
`scripts/fixtures/compose-hostile.yml`'s `hostile-capabilities` service with
five new read-only bind mounts, one per new prefix, so `--self-test` proves
each specifically (not just that the rule mechanism still fires via the
pre-existing `/proc` mount).

**A real regression found and fixed along the way.** `docker compose config`
resolves compose.yml's `./docker/Caddyfile:/etc/caddy/Caddyfile:ro` (a
relative, repo-owned bind mount) to an absolute host path — and that path is
under `/home/...` on this dev box, and would be under `/home/runner/work/...`
on a GitHub Actions runner. Adding a blanket `/home` prefix therefore made
the gate fail the repo's own real, reviewed compose file everywhere it's
actually run. Fixed by exporting `REPO_ROOT` into the node evaluator and
excluding any source path resolved to somewhere _inside_ the checkout
(`isSensitiveHostPath` returns `false` for `source === REPO_ROOT ||
source.startsWith(REPO_ROOT + '/')` before checking the prefix list) — a
relative mount of the repo's own tracked, reviewed files is not a host
escape; an absolute path elsewhere on the host is. The fixture's own
sensitive-path violations are all _literal_ absolute paths, never resolved
from something relative, so they are unaffected by the exclusion.

**Sabotage (isolated to the new prefixes specifically — self-test alone
can't distinguish "still works via `/proc`" from "the new prefixes work"; a
literal `/etc` bind mount fixture makes it unambiguous).**

Reverted `SENSITIVE_BIND_PREFIXES` to the pre-fix five-entry list, ran the
gate against a minimal compose file whose only bind mount is `/etc:/host-etc:ro`:

```
$ bash scripts/compose-hardening-check.sh --json /tmp/etc-only.yml
  /tmp/etc-only.yml: 1 service(s), 0 violation(s), 0 documented exception(s)
compose-hardening-check: PASS      # WRONG — a real /etc:ro mount slipped through
exit=0
```

**Restored the ten-entry list, green — and re-confirmed against the same probe:**

```
$ bash scripts/compose-hardening-check.sh --json /tmp/etc-only.yml
    FAIL /tmp/etc-only.yml: probe: sensitive-host-path-bind-mount: bind mount source is
      under a sensitive host path: /etc -> /host-etc ...
  /tmp/etc-only.yml: 1 service(s), 1 violation(s), 0 documented exception(s)
compose-hardening-check: FAIL
exit=1

# and, with both /etc and /home literal mounts on the same probe:
    FAIL ...: /etc -> /host-etc ...
    FAIL ...: /home -> /host-home ...
  2 violation(s)
exit=1
```

**Self-test and the real files, both green:**

```
$ bash scripts/compose-hardening-check.sh --self-test
  fixture triggered 19 distinct rule(s): ... sensitive-host-path-bind-mount ...
compose-hardening-check: SELF-TEST PASS (all 19 rules fire on a hostile file)

$ bash scripts/compose-hardening-check.sh
  compose.dev.yml: 1 service(s), 0 violation(s), 1 documented exception(s)
  compose.override.example.yml: template with no active services (nothing to check)
  compose.yml: 9 service(s), 0 violation(s), 1 documented exception(s)
compose-hardening-check: PASS (3 file(s) checked: compose.dev.yml compose.override.example.yml compose.yml)
```

(Before the `REPO_ROOT` exclusion was added, this last run failed on
`compose.yml`'s `proxy` service's Caddyfile mount — recorded above as the
regression found along the way, not left in the final state.)

---

## R-8 — Theme-toggle test was true whether or not the toggle worked (`apps/web/e2e/smoke.spec.ts`)

**Finding (already fixed by the prior agent instance; re-verified here).**
The restored version of this test only asserted the post-click `data-theme`
attribute matched `/light|dark/`, which is true whether or not the click did
anything — a no-op click, a throwing handler, or `ThemeToggle` being deleted
entirely (leaving whatever `data-theme` boot sets) would all still pass.

**Fix.** Captures the attribute value before the click and asserts the
post-click value _differs_ from it, in addition to matching `/light|dark/`.

**Sabotage.** Changed `LoginScreen.tsx`'s `ThemeToggle`'s `onClick` to a
no-op, ran the smoke test:

```
✘ [chromium] the theme toggle on the login screen flips data-theme on <html>
  Expected pattern: /light|dark/
  Received string:  ""
  - waiting for locator('html') ... unexpected value "null"
1 failed
```

**Restored, green.** `LoginScreen.tsx` confirmed byte-identical to its
pre-sabotage state (`diff` against a pre-edit backup — no output; the file's
`git diff` against HEAD reflects only the concurrent refactoring agent's
unrelated, in-flight changes to the same file).

```
✓ [chromium] the theme toggle on the login screen flips data-theme on <html> (837ms)
1 passed (14.1s)
```

---

## Lint hygiene found and fixed in owned files while re-verifying

Running `just check` surfaced two problems in files this agent owns (both
introduced by the prior agent instance's R-2/R-1 work, neither previously
caught because `just check`/CI hadn't been re-run since):

- **Formatting:** `apps/web/e2e/csp.spec.ts` and
  `packages/contexts/identity/test/refresh-concurrency.test.ts` were not
  Prettier-clean. Fixed with `pnpm exec prettier --write` scoped to just
  those two files.
- **Import boundary lint:** `refresh-concurrency.test.ts` imported
  `randomBytes` from `node:crypto` directly (banned by
  `no-restricted-imports` — cryptography lives in `@core/secretbox`). Fixed
  by importing `randomBytes` from `@core/secretbox` instead (same pattern
  already used in `sessions.ts`, `recovery.ts`, `users.ts`), wrapping the
  returned `Uint8Array` in `Buffer.from(...).toString('hex')` to keep the
  same scratch-DB-name shape.

Re-verified after the fix: `pnpm exec eslint apps/web/e2e
packages/contexts/identity/test` — clean; `pnpm exec prettier --check` on
both paths — clean; `--project identity-db -t "refresh rotation is atomic"`
— 6 passed, confirming the import change didn't affect behavior.

---

## VERIFY — final run

Postgres: `just db-up` (127.0.0.1:5433, `personalfi_dev`).

| Step                                                                            | Result                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm exec vitest run --project identity-db` (unique scratch DB per R-2's file) | 110/110 passed                                                        |
| `pnpm exec vitest run --project testkit` (with and without `DATABASE_URL`)      | 23/23, then 19 passed + 4 skipped — see R-3                           |
| `pnpm --filter @app/web test`                                                   | 40/40 passed                                                          |
| `pnpm --filter @app/web build`                                                  | passed (strip-sourcemaps, sw-precache check, static CSP check all OK) |
| `pnpm --filter @app/web exec playwright test` (both projects)                   | 6/6 passed                                                            |
| `bash scripts/compose-hardening-check.sh --self-test`                           | PASS (19/19 rules fire)                                               |
| `bash scripts/compose-hardening-check.sh` (real files)                          | PASS (3 files, 0 violations)                                          |
| `bash scripts/check-history-rewrite-before-push.sh`                             | PASS (no remote — nothing to check)                                   |
| `pnpm run typecheck`                                                            | PASS                                                                  |
| `pnpm exec eslint .`                                                            | PASS                                                                  |
| `docker run ... gitleaks detect ...` (CI's pinned digest)                       | PASS — 44 commits scanned, no leaks                                   |
| `just trivyignore-check`                                                        | PASS                                                                  |
| `docker run ... trivy fs ...` (CI's pinned digest)                              | PASS — 0 vulnerabilities/secrets/misconfigs                           |
| `node scripts/check-licenses.ts`                                                | PASS (260 prod, 622 dev packages)                                     |

**`just check` / `just verify` as a single recipe: NOT green, and not from
anything in this agent's scope.** `just check`'s `lint` step runs
`prettier --check .` and `node scripts/check-schema-ownership.ts`
repo-wide, and both currently fail solely inside
`packages/contexts/ledger/**` and `packages/db/migrations/0004_ledger.sql` —
the concurrent Ledger agent's in-flight WP 1.1 work (unformatted files, and
three new tables — `transactions_provider`, `rejected_transfer_pairs`,
`ledger_dedup_keys` — not yet claimed in that package's `OWNERSHIP.md`).
`pnpm exec vitest run` (all root projects, no `--project` filter) likewise
shows exactly one failing file, `packages/db/test/migrate.test.ts`, whose
exact-table-list assertion doesn't yet know about migration 0004's new
tables — same in-flight migration, same non-owner. `THIRD_PARTY.md`
regeneration also shows drift, traced to a `pnpm-lock.yaml` change also made
by that agent. Every other project (`kernel`, `config`, `db`'s other tests,
`platform`, `platform-db`, `testkit`, `seed`, `secretbox`, `secretbox-db`,
`identity`, `identity-db`, `api`, `api-db`) — 480 of 482 tests outside
`apps/web` — passes. None of the four blockers touch a file this agent owns,
and none was introduced by this agent; regenerating `THIRD_PARTY.md` or
editing `OWNERSHIP.md`/ledger formatting would be out of scope and would
collide with that agent's in-progress commit. Deferred to the orchestrator to
re-run `just verify` once the Ledger agent's work lands.

## Summary

| Finding                                                                           | Status                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| R-1 (CSP directive pinning)                                                       | Green, re-verified, sabotage evidence recorded above                                                                      |
| R-2 (race tests, warmed pool)                                                     | Green, re-verified, sabotage evidence recorded above                                                                      |
| R-3 (`testkit` in `migration-test`)                                               | Green, re-verified                                                                                                        |
| R-4 (`just verify` covers web build + Playwright, fails loud on missing browsers) | Green, re-verified, sabotage evidence recorded above                                                                      |
| R-5 (push ratchet asserts real history reachability)                              | Fixed this session, sabotage evidence above                                                                               |
| R-6 (push ratchet fails closed on missing `.gitleaksignore`)                      | Fixed this session, sabotage evidence above                                                                               |
| R-7 (`SENSITIVE_BIND_PREFIXES` extended)                                          | Fixed this session, sabotage evidence above, one regression (repo-owned Caddyfile mount) found and fixed in the same pass |
| R-8 (theme-toggle test asserts a real state change)                               | Green, re-verified, sabotage evidence above                                                                               |

Deferred (not this agent's scope, blocking only the single combined `just
check`/`just verify` recipe, not any individual gate): Ledger agent's
in-flight formatting, `OWNERSHIP.md` table claims, migration 0004's
table-list test, and `THIRD_PARTY.md` regeneration against its lockfile
change.
