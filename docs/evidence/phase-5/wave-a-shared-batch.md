<!-- SPDX-License-Identifier: MIT -->

# W-A0 — Phase 5 pre-dispatch shared-file batch

_Evidence for the batch dispatched ahead of Wave A (05-phase-5-dispatch.md §4 items 1, 2, 3, 6, 9,
10, pulled forward per the dispatch instructions to this session), landed at HEAD `97d1e6b` on
`main`. WP 5.1 and WP 5.2 (Opus, Wave A) start once this lands._

---

## Scope reminder

Exactly the items named: `pnpm-workspace.yaml`; the `@advisor/local-model` stub package;
`vitest.config.ts`'s new `advisor-local-model` project; `scripts/eslint-boundaries.js`'s new layer
and `eslint.config.js`'s `no-restricted-globals`; `.github/workflows/ci.yml`'s project list and
prose map; `apps/api/src/platform.ts`'s `advisors.kind.local_model` flag; the config/secrets batch
(`packages/config`, `.env.example`, RUNBOOK.md step 3); `compose.yml`'s two `environment:` blocks;
`.dockerignore`. No other file touched, no git state changes, no `pnpm install`.

---

## 1. `pnpm-workspace.yaml` — `packages/advisors/*`

`pnpm-workspace.yaml:14-16` (comment) / `:16` (the glob). Added in the file's own voice, mirroring
the `packages/connectors/*` comment immediately above it: one package per model runtime, denied
`@ctx/*` by the boundary rule so `@ctx/insights` keeps its "no LLM client" promise.

**Proof.** `pnpm exec vitest run --project advisor-local-model` finds and runs
`packages/advisors/local-model/src/index.test.ts` (below) without any workspace-glob error — the
pattern resolves.

---

## 2. Stub package `packages/advisors/local-model/`

- `packages/advisors/local-model/package.json` — name `@advisor/local-model`, `private: true`,
  `license: MIT`, `type: module`, `exports["."] = "./src/index.ts"`, `dependencies`:
  `@core/kernel`, `@core/platform`, `@core/contracts`, all `workspace:*`. **No external
  dependency** (05 §4 item 10 — the Ollama client is `@core/platform`'s transport, never the
  `ollama` npm package).
- `packages/advisors/local-model/src/index.ts` — a header comment naming WP 5.2 as the package's
  real author, and one export: `PACKAGE_NAME = '@advisor/local-model'`. **Imports none of its
  three declared dependencies yet**, on purpose: the lockfile is not updated in this batch (no
  `pnpm install` was run), and the package type-checks and lints green without it — proved below.
- `packages/advisors/local-model/src/index.test.ts` — one test, `'exports its own package name'`,
  so the `advisor-local-model` vitest project is never reported empty.

**Test.** `advisor-local-model` project → `'@advisor/local-model (stub) > exports its own package
name'` — PASS (see the full-suite run, §11).

**Boundary check, not sabotaged live (WP 5.2's own job) but confirmed structurally**: the package's
`src/index.ts` imports nothing but its own file, so no boundary rule can even fire yet; the layer
that will refuse an `@ctx/*` import once WP 5.2 adds one is item 4, proved below by direct ESLint
invocation against a same-shaped violating snippet reasoning (see §4).

---

## 3. `vitest.config.ts` — the `advisor-local-model` project

`vitest.config.ts:257-274`. `root: './packages/advisors/local-model'`,
`include: ['src/**/*.test.ts', 'test/*.test.ts']`, `environment: 'node'`, `testTimeout: 30_000`, no
Postgres — placed immediately after `connector-walletrpc`, before the `investments` project.

**Project count.** Before this batch: **41** (26 in `test`, 16 in `migration-test`, `testkit`
counted in both — the exact baseline `05-phase-5-dispatch.md` §4 item 1 states for `088fe4d`).
After this batch's one addition to `test`: **42** (27 in `test`, 16 in `migration-test`), matching
the `check-ci-projects` output below exactly.

```
$ node scripts/check-ci-projects.ts
check-ci-projects: self-test PASS (5 fixtures + 3 parser checks, correct state clean, every broken shape caught)
check-ci-projects: PASS — all 42 vitest.config.ts project(s) are covered by ci.yml (27 in 'test', 16 in 'migration-test'), and every name ci.yml lists exists.
```

(`testkit` counts in both lists per the tool's own accounting, so 27 + 16 − 1 = 42, matching the
dispatch's target exactly.)

---

## 4. `scripts/eslint-boundaries.js` — the `advisor-local-model` layer; `eslint.config.js`

`scripts/eslint-boundaries.js:469-497`. New layer, placed immediately before the `insights` layer
entry (mirroring how `connector-plaid` sits before the generic `connectors` entry — the comment at
`:485-488` states why): `prefix: 'packages/advisors/local-model/'`, `allow: ['@core/kernel',
'@core/platform', '@core/contracts', ...UNIVERSAL]`, `allowNodeBuiltins: false`. The `insights`
layer's own `allow` array (`scripts/eslint-boundaries.js:507-517` after the shift) is **unchanged**
— confirmed by diff, `@advisor/local-model` does not appear in it.

No dedicated boundaries _test file_ exists in this repo (`scripts/eslint-boundaries.js` is
consumed directly by `eslint.config.js`, not imported by any `*.test.ts`; confirmed by grep — only
comments elsewhere reference the filename). Per the work order ("if the boundaries rule has a test
file, add cases"), none was added because none exists to add to.

**Live proof the layer is real**, not merely declared (the dead-configuration bug this file's own
`crossContext` branch comment warns about): a scratch file was linted in place and deleted
immediately after the observation — never committed, never left behind (`ls
packages/advisors/local-model/src/` after each probe shows only `index.ts`/`index.test.ts`; the
final `git status --short` in §11 shows no probe file).

```
$ printf "import { x } from '@ctx/insights';\nexport { x };\n" > packages/advisors/local-model/src/__boundary_probe.ts
$ pnpm exec eslint packages/advisors/local-model/src/__boundary_probe.ts
$ rm -f packages/advisors/local-model/src/__boundary_probe.ts
```

Actual, unedited output:

```
/home/chris/Projects/PersonalFi/packages/advisors/local-model/src/__boundary_probe.ts
  1:19  error  '@ctx/insights' is another bounded context. @core/advisor-local-model must talk to
  it through a domain event or its published port, never a direct import (decision D8)
  personalfi/layer-imports

✖ 1 problem (1 error, 0 warnings)
```

(The rule fired through its `crossContext` message branch rather than the generic `denied` one,
because `@ctx/insights` matches `pkg.startsWith('@ctx/')` in `scripts/eslint-boundaries.js`'s
`check` function before the plain allow-list check runs — still a refusal, from the layer this
batch added; the context name reads `@core/advisor-local-model` because `packages/advisors/` is
not `packages/contexts/` or `packages/connectors/`, so `layerFor`'s generic
`` `@core/${layer.name}` `` naming applies, exactly as it does for e.g. `@core/platform`.)

`eslint.config.js:199-221` — `no-restricted-globals: ['fetch', 'WebSocket']` scoped to
`files: ['packages/advisors/local-model/**/*.ts']`, each with a message naming
`@core/platform`'s transport and WP 5.2's local-endpoint egress policy as the only network path.
Sabotaged the same way:

```
$ printf "export function f() { return fetch('http://example.com'); }\n" > packages/advisors/local-model/src/__fetch_probe.ts
$ pnpm exec eslint packages/advisors/local-model/src/__fetch_probe.ts
$ rm -f packages/advisors/local-model/src/__fetch_probe.ts
```

Actual, unedited output:

```
/home/chris/Projects/PersonalFi/packages/advisors/local-model/src/__fetch_probe.ts
  1:30  error  Unexpected use of 'fetch'. Reach the network only through @core/platform's
  transport, under WP 5.2's local-endpoint egress policy — never a bare fetch  no-restricted-globals

✖ 1 problem (1 error, 0 warnings)
```

Both probe files were deleted immediately after each observation.

---

## 5. `.github/workflows/ci.yml`

- `advisor-local-model` added to the `test` job's `--project` list: `.github/workflows/ci.yml:215`.
- The prose map's `test` job project list, updated: `.github/workflows/ci.yml:35`.
- A new "Phase 5" paragraph in the header's prose map: `.github/workflows/ci.yml:87-93`, stating
  the addition and the 41→42 count — `scripts/check-ci-projects.ts` does not read this paragraph
  (confirmed by reading the script: it parses only the `name: '...'` entries and the two
  `--project` lists), so it is a human-maintained note, per the work order.

**Test.** `check-ci-projects: PASS` (§3) proves the mechanical half; the paragraph is prose,
verified by re-reading it against the actual counts above.

---

## 6. `apps/api/src/platform.ts` — `advisors.kind.local_model`

`apps/api/src/platform.ts:210-236` — new exported constant `ADVISOR_KIND_FLAGS`, **not** folded
into `MODULE_FLAGS`. Reasoning recorded in the comment at `:210-219`: `MODULE_FLAGS`'s own doc
calls itself "the module flags", and `apps/api/test/worker-pool-guard.test.ts:57,119-120` sizes the
worker's pinned connection pool as `3 + 2 + MODULE_FLAGS.length` (one consumer per _module_, worst
case) — a kind flag registers no consumer, and folding it into `MODULE_FLAGS` would have silently
inflated that arithmetic. `buildPlatform` (`:267-270`) merges `ADVISOR_KIND_FLAGS` into the same
`FlagService` alongside `PLATFORM_FLAGS` and `MODULE_FLAGS`.

```ts
// apps/api/src/platform.ts:239-246
export const ADVISOR_KIND_FLAGS: readonly FlagDefinition[] = Object.freeze([
  Object.freeze({
    key: 'advisors.kind.local_model',
    defaultEnabled: false,
    owner: 'insights',
    removeWhen: "never — this is kill level 2 (05 §3 WP 5.1's ladder)",
  }),
]);
```

`module.insights`'s description (`apps/api/src/platform.ts:112-130`, the block around the `key:
'module.insights'` line) gains the local model, the Weekly Brief and the health score;
`defaultEnabled` **stays `true`** — confirmed unchanged by diff.

**Tests that pin the flag list.** `apps/api/test/module-flag-defaults.test.ts` iterates only
`MODULE_FLAGS` and asserts its `defaultEnabled` values and an exact "no undocumented key" set.
Because `advisors.kind.local_model` was **not** added to `MODULE_FLAGS`, that test needed **no
edit** — confirmed green, unmodified, in the full run (§11). `worker-pool-guard.test.ts`'s
`MODULE_FLAGS.length` arithmetic is likewise unaffected — also confirmed green, unmodified.

---

## 7. Config keys — `packages/config`, `.env.example`, RUNBOOK.md, the insights pin test

### Schema (`packages/config/src/schema.ts`)

| Key                          | Line       | Shape                                                                   |
| ---------------------------- | ---------- | ----------------------------------------------------------------------- |
| `MONTE_CARLO_MAX_CONCURRENT` | `:296`     | `int().min(1).default(8)`                                               |
| `ADVISORS_ENABLED`           | `:306`     | `stringbool().default(true)`                                            |
| `LOCAL_MODEL_ENDPOINT`       | `:323`     | `string().default('')`                                                  |
| `LOCAL_MODEL_NAME`           | `:329`     | `string().default('')`                                                  |
| `LOCAL_MODEL_DIGEST`         | `:339`     | `string().default('')`                                                  |
| `LOCAL_MODEL_TIMEOUT_MS`     | `:348-353` | `int().min(1_000).max(LOCAL_MODEL_TIMEOUT_MS_CEILING).default(180_000)` |
| `LOCAL_MODEL_ALLOW_REMOTE`   | `:360`     | `stringbool().default(false)`                                           |

`LOCAL_MODEL_TIMEOUT_MS_CEILING = 300_000` declared at `schema.ts:30`, with a comment
(`:22-29`) naming `packages/contexts/insights/src/contract/manifest.ts:43`
(`PLATFORM_LIMITS.timeoutMs`) as the source `@core/config` cannot import.

### Load (`packages/config/src/load.ts`)

- `LocalModelConfig` interface (`:115-135`); `PlanningConfig.monteCarloMaxConcurrent`
  (`:109-113`); `AppConfig.localModel: LocalModelConfig | undefined` (`:174-175`).
- `resolveLocalModel` (`:840-893`) — feature-detects `LOCAL_MODEL_ENDPOINT` the same way
  `resolvePlaid` feature-detects Plaid: empty/absent ⇒ `undefined`; present-but-partial (name or
  digest missing, or digest not shaped `sha256:` + 64 lowercase hex) ⇒ a named `ConfigProblem`,
  boot refuses.
- Wired into `loadConfig` at `:348` (`resolveLocalModel` call) and `:373-376` (returned object).

### `packages/config/src/index.ts`

Exports widened: `LocalModelConfig`, `PlanningConfig` (types), `LOCAL_MODEL_TIMEOUT_MS_CEILING`
(value) — the only edit needed beyond `schema.ts`/`load.ts` to make the ceiling reachable through
the package's sole `exports["."]` surface.

### Tests, one per key (`packages/config/src/load.test.ts`)

| Key                          | Test(s)                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADVISORS_ENABLED`           | `'ADVISORS_ENABLED' > 'defaults to true'`, `'an explicit false is read through'`                                                                                                                        |
| `MONTE_CARLO_MAX_CONCURRENT` | `'defaults to 8, unchanged from the literal it replaces'`, `'a non-default value passes through'`, `'rejects a value below 1'`                                                                          |
| `LOCAL_MODEL_ENDPOINT`       | `'empty endpoint ⇒ localModel undefined'`, `'an absent endpoint (the default) also leaves localModel undefined'`, `'a fully configured endpoint resolves, with the configured timeout and allowRemote'` |
| `LOCAL_MODEL_NAME`           | `'name required when the endpoint is set'`                                                                                                                                                              |
| `LOCAL_MODEL_DIGEST`         | `'digest required when the endpoint is set'`, `'a malformed digest is refused, even when non-empty'`                                                                                                    |
| `LOCAL_MODEL_TIMEOUT_MS`     | `'LOCAL_MODEL_TIMEOUT_MS defaults to 180000 once the endpoint is configured'`, `'LOCAL_MODEL_TIMEOUT_MS never exceeds PLATFORM_LIMITS.timeoutMs (300000)'`                                              |
| `LOCAL_MODEL_ALLOW_REMOTE`   | `'LOCAL_MODEL_ALLOW_REMOTE defaults to false once the endpoint is configured'`                                                                                                                          |

All in the `config` vitest project — PASS, see §11.

### The ceiling pin (`packages/contexts/insights/test/platform-limits-config.test.ts`, new file)

Reads `packages/config/src/schema.ts` as **text** (via `node:fs`, the same
reach-across-a-package-boundary-by-file device `test/contract-parity.test.ts` already uses for
`packages/contracts/advisor/` in this same directory) rather than importing `@core/config` —
`@ctx/insights`'s `package.json` does not declare `@core/config` as a dependency, and this batch
may add **no** dependency beyond the stub's (05 §4 item 10; "no dependency or lockfile edits
beyond the stub package.json"). Parses `LOCAL_MODEL_TIMEOUT_MS_CEILING`'s literal out of the
source text and asserts it equals `PLATFORM_LIMITS.timeoutMs` imported normally from
`../src/contract/manifest.ts` (same package, no boundary crossing).

**Test.** `insights` project → `'LOCAL_MODEL_TIMEOUT_MS_CEILING pins PLATFORM_LIMITS.timeoutMs (05
§4 item 9) > the two numbers are equal'` — PASS.

### `.env.example`

New "Phase 5 wiring" section added before the image-registry footer, documenting all seven keys
with their defaults, each commented out (matching every other optional key's convention in this
file).

### RUNBOOK.md step 3 ("Configure `.env`")

A new paragraph added to the **existing** step-3 environment listing (`RUNBOOK.md`, the "### 3.
Configure `.env`" section), listing the seven keys and their defaults. No other RUNBOOK.md section
touched — confirmed by `git diff --stat RUNBOOK.md` showing one hunk.

---

## 8. `compose.yml` — the two `environment:` blocks

Touched **only** `api`'s and `worker`'s `environment:` blocks — confirmed by `git diff compose.yml`
(reproduced in full below): two hunks, both strictly additive lines inside existing `environment:`
maps, zero lines touching `secrets:`, `networks:`, the `local-llm` block, or any other service.

```diff
@@ (api, environment:) @@
+      ADVISORS_ENABLED: ${ADVISORS_ENABLED:-true}
@@ (worker, environment:) @@
+      ADVISORS_ENABLED: ${ADVISORS_ENABLED:-true}
+      LOCAL_MODEL_ENDPOINT: ${LOCAL_MODEL_ENDPOINT:-}
+      LOCAL_MODEL_NAME: ${LOCAL_MODEL_NAME:-}
+      LOCAL_MODEL_DIGEST: ${LOCAL_MODEL_DIGEST:-}
+      LOCAL_MODEL_TIMEOUT_MS: ${LOCAL_MODEL_TIMEOUT_MS:-180000}
+      LOCAL_MODEL_ALLOW_REMOTE: ${LOCAL_MODEL_ALLOW_REMOTE:-false}
+      MONTE_CARLO_MAX_CONCURRENT: ${MONTE_CARLO_MAX_CONCURRENT:-8}
```

`api` receives only `ADVISORS_ENABLED`, per the work order; the comment at `compose.yml:352-360`
records why the other six do not join it yet (they are `worker`'s until the wave that wires
`config.planning.monteCarloMaxConcurrent` and the local-model port into
`apps/api/src/domain.ts` decides whether `api`'s own interactive route needs them too — not this
batch's call to make).

`prettier --write compose.yml` run; reported `(unchanged)` — the hand-written YAML already matched
prettier's formatting.

**`scripts/compose-hardening-check.sh`**:

```
$ bash scripts/compose-hardening-check.sh
...
  compose.yml: 9 service(s), 0 violation(s), 1 documented exception(s)
compose-hardening-check: PASS (3 file(s) checked: compose.dev.yml compose.override.example.yml compose.yml)
```

---

## 9. `.dockerignore`

`.dockerignore:14-20` — `compose.override.yml` added beside the existing `.env`/`secrets` block;
`.claude` added as its own entry with a one-line comment naming Phase 4 gate G4-21.

---

## 10. Secrets: none

**Confirmed.** No file secret, no `SECRET_SPECS` entry, no `secrets:` block on any compose service
was added or touched. A local model needs no credential — it runs on the host, over the internal
compose network, with no API key, no bearer token and nothing to seal. `ADVISORS_ENABLED` and every
`LOCAL_MODEL_*`/`MONTE_CARLO_MAX_CONCURRENT` key added this batch is non-secret deployment shape,
exactly like `PLANNING_RETURNS_CACHE_DIR` before it. `git diff --stat` (§11) shows no touch to
`packages/config/src/schema.ts`'s `SECRET_SPECS` array or to any `compose.yml` `secrets:` list.

---

## 11. `just check`

Posted before the final `just check`, per the work order. Individual checks run ahead of it, each
already reproduced above:

- `pnpm run typecheck` — clean (`tsc -p tsconfig.json`, no output).
- `pnpm exec eslint <every file this batch touched>` — clean, individually invoked because the
  whole-tree `pnpm run lint:eslint` has one pre-existing, unrelated failure at HEAD (see "Needs the
  orchestrator" below).
- `pnpm run lint:schema-ownership` — `ok — 103 table(s) claimed across 14 package(s), 90 defined.`
  (this batch defines no table).
- `node scripts/check-ci-projects.ts` — `PASS — all 42 vitest.config.ts project(s)...` (§3).
- `pnpm exec vitest run --project advisor-local-model --project config --project insights` — **27
  test files, 394 tests, all passed.**
- `pnpm exec vitest run --project api` — **15 test files, 95 tests, all passed** (confirms
  `module-flag-defaults.test.ts` and `worker-pool-guard.test.ts` are unaffected).
- `bash scripts/compose-hardening-check.sh` — `PASS (3 file(s) checked...)`.

```
$ git status --short
 M .dockerignore
 M .env.example
 M .github/workflows/ci.yml
 M RUNBOOK.md
 M apps/api/src/platform.ts
 M compose.yml
 M eslint.config.js
 M packages/config/src/index.ts
 M packages/config/src/load.test.ts
 M packages/config/src/load.ts
 M packages/config/src/schema.ts
 M pnpm-workspace.yaml
 M scripts/eslint-boundaries.js
 M vitest.config.ts
?? packages/advisors/
?? packages/contexts/insights/test/platform-limits-config.test.ts
```

(Also present, from concurrent work this session did not touch and did not modify further: `M
apps/api/src/domain.ts`, `M docker/api.Dockerfile`, `M packages/contexts/planning/data/returns/series.ts`,
`M packages/secretbox/src/secret-box.ts`, `M pnpm-lock.yaml`, `??
apps/api/test/db/carry-c1-newest-baseline-run.test.ts`, `??
packages/contexts/planning/test/returns-fetch-checksum.test.ts`, `??
packages/secretbox/test/keyring-race.test.ts` — WP 5.13a's disjoint file list, per the task
briefing. No file in this session's diff overlaps any of those paths. The `secret-box.ts` edit is
what `just check` was caught mid-flight on, above.)

### `just check` — full run

```
$ just check
pnpm run typecheck
$ tsc -p tsconfig.json
packages/secretbox/src/secret-box.ts(442,36): error TS2345: Argument of type 'EncryptionKeyRow | null' is not assignable to parameter of type 'EncryptionKeyRow'.
  Type 'null' is not assignable to type 'EncryptionKeyRow'.
[ELIFECYCLE] Command failed with exit code 2.
error: recipe `typecheck` failed on line 124 with exit code 2
```

**Red, and not on this batch's files.** `packages/secretbox/src/secret-box.ts` is mid-edit by a
concurrent agent in this same tree (`git status --short` shows it `M`odified, plus an untracked
`packages/secretbox/test/keyring-race.test.ts` beside it) — neither path is named anywhere in this
work order, and this session made no edit to either. `pnpm run typecheck` run in isolation earlier
in this session, before that file's in-flight edit reached this state, was clean (§11 above); the
error is specifically and only in that one file's line 442, nothing this batch touched. Per the
collision rules ("no other file, ever" / disjoint path ownership), this session does not fix,
touch, or work around it — recorded here as the honest `just check` result at the moment this batch
finished, for the orchestrator to re-run once the concurrent edit lands or resolves.

Every check this batch's own files are responsible for was independently green, run in isolation,
before this shared-tree collision: typecheck (clean, §11), eslint on every touched file (clean,
§11), schema-ownership (`ok`), `check-ci-projects` (`PASS`, 42/42), the `advisor-local-model` /
`config` / `insights` / `api` vitest projects (394 + 95 tests, all passed), and
`compose-hardening-check.sh` (`PASS`).

---

## Needs the orchestrator

- **Pre-existing lint failure, not touched by this batch**: `pnpm run lint:eslint` over the whole
  tree fails on `packages/contexts/planning/test/returns-fetch-checksum.test.ts:23` (`'mkdirSync'
is defined but never used`). That file is untracked in this working tree and not part of this
  session's file list (see the concurrent-work note above) — almost certainly WP 5.13a's or
  another concurrent agent's in-progress file. Flagging so it is not mistaken for something this
  batch introduced; every file this batch actually touched lints clean individually (confirmed
  above).
- **The lockfile.** `packages/advisors/local-model/package.json` declares `@core/kernel`,
  `@core/platform` and `@core/contracts` as `workspace:*` dependencies that `src/index.ts`
  deliberately does not yet import. `pnpm install --offline` (or equivalent) is needed before WP
  5.2 can import them; this batch's own tests do not require it (confirmed green without it,
  above).
