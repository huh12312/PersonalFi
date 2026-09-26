<!-- SPDX-License-Identifier: MIT -->

# WP 4.7 — the Phase 3 gap-field sources (I1, I3, I5)

_Backend-architect, Sonnet. Migration 0026 (renumbered from 0023 mid-session; see §2.1). Scope:
`docs/plan/04-phase-4-dispatch.md` §3 "WP 4.7", the other half of the 3.10a ruling
(`docs/evidence/phase-3/wp3.10a-snapshot-readers.md` §7.2)._

---

## 1. What shipped

| File                                                              | What                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/db/migrations/0026_allocation_targets.sql`              | `allocation_targets`, `security_tags`                                                                                |
| `packages/contexts/investments/schema/targets.ts`                 | Drizzle table defs, `SECURITY_TAGS`, `DEFAULT_BAND_PCT`                                                              |
| `packages/contexts/investments/schema/index.ts`                   | one export line                                                                                                      |
| `packages/contexts/investments/OWNERSHIP.md`                      | both tables claimed under `## Tables`                                                                                |
| `packages/contexts/investments/src/targets.ts`                    | `assertTargetsSumToOne`, `drizzleAllocationTargetsStore`, `inMemoryAllocationTargetsStore`, `AllocationTargetsError` |
| `packages/contexts/investments/src/tags.ts`                       | `drizzleSecurityTagsStore`, `inMemorySecurityTagsStore` — set/clear/listFor/listForMany                              |
| `packages/contexts/investments/src/dwell.ts`                      | `cashSnapshotHistory` (the one DB read), `idleDaysOf` (pure), `cashPositionFor` (pure composition)                   |
| `packages/contexts/investments/src/events.ts`, `src/index.ts`     | `investments.AllocationTargetsChanged`, added to `INVESTMENTS_EVENTS` (5 → 6)                                        |
| `packages/contexts/investments/test/{targets,tags,dwell}.test.ts` | new, per §3's exit-test names                                                                                        |
| `apps/api/test/db/phase3-advisors.test.ts`                        | the re-derived silence test, **and no other change**                                                                 |
| `apps/api/src/reports/export/registry.ts`                         | two `EXEMPT_TABLES` entries                                                                                          |

Not touched: `apps/api/src/domain.ts`, `packages/contexts/planning/**`, `packages/db/test/migrate.test.ts`,
`vitest.config.ts`, `ci.yml`, `scripts/**`.

### 2.1 — Migration renumbered 0023 → 0026 mid-session

Dispatched as 0023. WP 4.3's `test/db` run found it failed to apply on a fresh database:
`security_tags`' composite FK to `securities (user_id, id)` needs the `UNIQUE (user_id, id)` constraint
`0025_investments_security_scoping.sql` adds by `ALTER TABLE`, and migrations apply in filename order.
0025 (WP 4.12, a different wave) reached `main` before this file did and is immutable (its own SHA-256
guard refuses a change), so 0023 running first is the defect, not 0025 running second. The orchestrator
(via a mid-session message, verified independently before acting — the ordering claim was re-derived by
inspecting `0025`'s `ALTER TABLE securities ADD CONSTRAINT securities_user_id_id_uniq UNIQUE (user_id,
id)` directly) assigned 0026 as the next free number and confirmed `packages/db/test/migrate.test.ts`'s
attribution comment is theirs to fix. Every file that named the migration by number was updated; no
second unique constraint was added. Re-verified: `DATABASE_URL=… pnpm exec vitest run --project db` —
**10/10 pass**, a fresh scratch database applying 0001 through 0026 cleanly.

---

## 2. The 3.10a table, each `Hardcoded` column replaced by its source

Reproduced from `wp3.10a-snapshot-readers.md` §7.2:

| Field              | Was hardcoded | Now sourced from                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `targets`          | `[]`          | `drizzleAllocationTargetsStore(db, clock).listAll(userId)` — `packages/contexts/investments/src/targets.ts`, over `allocation_targets` (migration 0026). Empty when unset — never a default.                                                                                                                                                          |
| `idleCash`         | `null`        | `cashSnapshotHistory` (the DB read) + `idleDaysOf` (pure) + `cashPositionFor` (pure composition) in `src/dwell.ts`, fed into `src/analytics/cash.ts`'s existing `idleCash()`. The earmark half is `@ctx/planning`'s `liveEarmarksByAccount` (WP 4.1, already published — see §7), composed only at the point named in §7, never read by this context. |
| `employerStock`    | `false`       | `drizzleSecurityTagsStore(db, clock).listForMany(userId, securityIds)` — `packages/contexts/investments/src/tags.ts`, over `security_tags` (migration 0026). Set explicitly only; §5's grep is the control that it stays that way.                                                                                                                    |
| `peerExpenseRatio` | `null`        | Unchanged — out of this WP's scope (no comparable-fund table in any Phase 3 source; I2 still fires on the absolute trigger).                                                                                                                                                                                                                          |

---

## 3. The ownership argument for `allocation_targets`

**Claim:** `allocation_targets` is owned by `@ctx/investments`, not `@ctx/planning`, even though the
_questionnaire_ that would suggest a target set (`risk_profile`) is Planning's.

**The arrow it would have violated.** `docs/research/08-system-architecture.md` §1.6 draws
`plan → invest` and `plan → ledger` — arrows point **down**, from Planning to the contexts it reads.
There is no `invest → plan` arrow. `src/analytics/drift.ts`'s `driftAgainstTargets` (WP 3.3) already
takes a target set as a plain argument — it does not know or care where the caller got it — and
`GET /investments/drift` (WP 3.9) is `@ctx/investments`' own route, called on every drift request. Had
`allocation_targets` landed in `packages/contexts/planning/`, every one of those calls would have had
Investments reach **up** into Planning for a number its own analytics module and its own route need on
every invocation — the exact shape of the arrow 08 §1.6 forbids, and the collision it would create with
WP 4.1/4.3's Opus agents (who own `packages/contexts/planning/**` this wave) is the practical cost on top
of the architectural one.

**What Planning still owns.** `risk_profile` (WP 4.1, migration 0020) is the _suggestion_ — a
questionnaire's derived tolerance, never a stored target weight. Nothing in this WP reads `risk_profile`,
and nothing in Planning writes `allocation_targets`. The two are related in a user's head, not in a
foreign key.

**`security_tags`' composite FK.** `(user_id, security_id) REFERENCES securities (user_id, id)`, following
`0025_investments_security_scoping.sql`'s convention exactly (Phase 3 gate C-14) — a tag cannot name
another user's security, structurally, not just by predicate.

---

## 4. I1, I3 and I5 shown firing on the seed

`apps/api/test/db/phase3-advisors.test.ts` → `'I1, I3 and I5 now fire on the seed, and the rules with no
field behind them are exactly the ones still named'`. Run over the real `createInsightsInvestmentsPort`,
**decorated** in the test (not in `domain.ts` — see §7) with the three new readers, over the same seeded
VTI position (100% of investable assets) plus a new `CASH-SWEEP` security seeded with three
`holdings_snapshots` rows twenty, ten and zero days back, all at $12,000, unearmarked.

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
  pnpm exec vitest run apps/api/test/db/phase3-advisors.test.ts

 ✓ the nightly advisor run over a synced portfolio proposes an investing insight with resolvable evidence
 ✓ the real ports render every new scope, and no identifier crosses
 ✓ I1, I3 and I5 now fire on the seed, and the rules with no field behind them are exactly the ones still named
 ✓ market.rates carries the FRED licence sentence verbatim, from the constant

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Inside the third test, each rule's `proposed` count and evidence:

| Rule                  | Advisor id                         | Trigger                                                                                                                                    | `proposed` | Evidence ref example                                                                                              |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| **I1** drift          | `builtin.investing.drift`          | US_EQUITY actual weight drifts from the stored 60/40 target by more than 5pp once CASH dilutes the denominator                             | > 0        | `snapshot:holdings_aggregate.target_allocation[0].weight`, `snapshot:holdings_aggregate.by_asset_class[…].weight` |
| **I3** idle cash      | `builtin.investing.idle_cash`      | $12,000 cash, 20 days at the same level (`idleDaysOf` walked the three seeded snapshots), over the $1,000/2% threshold, `earmarked: false` | > 0        | `snapshot:holdings_aggregate.idle_cash.total`, `…idle_cash.longest_idle_days`                                     |
| **I5** employer stock | `builtin.investing.employer_stock` | VTI tagged `employer_stock` via `drizzleSecurityTagsStore.set`, weight 100% of investable assets, past the 10% threshold                   | > 0        | `snapshot:holdings_aggregate.top_positions[0].employer_stock`                                                     |

The controls preserved (the dispatch's explicit requirement — "the assertion that I4 and I2 fire on the
same run must survive, or the test proves nothing"):

- `builtin.investing.concentration` (I4): `proposed > 0` — unaffected, since CASH is excluded from the
  investable-assets denominator I4 and I5 both use.
- `builtin.investing.expense_ratio` (I2): `proposed > 0` — unaffected; reads `holdings.detail`, which the
  decoration does not touch.
- `builtin.investing.loss_lot` (I6, not named by the original test but added as a second control): `0` —
  VTI's lot is a gain, not a loss; the decoration did not manufacture a loss.

### 4.1 — Why the decoration exists, and what it is not

WP 4.7 owns `packages/contexts/investments/src/{targets,tags,dwell}.ts` and the assertion changes in this
one test file. It does **not** own `apps/api/src/domain.ts`. At this commit,
`createInsightsInvestmentsPort` still hardcodes the three fields exactly as `wp3.10a-snapshot-readers.md`
§7.2 found them — confirmed by reading the function body again before writing this test, not assumed.
So the re-derived test builds a **test-local decorator** — `wrapWithGapFieldSources` — around the _real_
port: it calls the real `base.holdings(input)` (real accounts, real valuation, real liability crossing,
unchanged), then replaces exactly `aggregate.targets`, `aggregate.idleCash` and every position's
`employerStock` with reads through the three new investments functions over the same rows. Every other
field is the base port's own untouched answer. §7 below specifies the identical composition for
`domain.ts`; once the orchestrator applies it, this decorator is redundant with production and the test
can call `createInsightsInvestmentsPort` directly again — recorded as an open item in §9.

**Sabotage, to prove the test is not vacuous:** `wrapWithGapFieldSources` was temporarily made to return
`base` unchanged (no decoration). Re-run:

```
 ❯ I1, I3 and I5 now fire on the seed, and the rules with no field behind them are exactly the ones still named
   AssertionError: builtin.investing.drift should now fire: expected 0 to be greater than 0
 Tests  1 failed | 3 passed (4)
```

Reverted; diffed byte-identical against the pre-sabotage copy; re-run green (4/4).

---

## 5. The employer-tag structural test

`test/tags.test.ts` → `'no code path infers an employer stock tag from a name, a ticker or a payroll
descriptor'`. Statically greps every `.ts` file under `packages/contexts/investments/src/**` (comments
stripped) for the literal tag value `employer_stock`, asserting it appears in exactly one file
(`tags.ts`) — the pattern is `EMPLOYER_STOCK_TRIGGER` in `src/analytics/concentration.ts`, the 10%
_threshold_, deliberately not a counter-example because it never contains the lowercase, underscored
literal the tag value is. Paired with a dynamic check: `classify()` run over a security literally ticked
and named after a real company sets no tag in the store.

```
$ pnpm exec vitest run packages/contexts/investments/test/tags.test.ts
 ✓ no code path infers an employer stock tag from a name, a ticker or a payroll descriptor
 ✓ classifying a security named and ticked after a real company sets no tag
 ✓ sets and lists a tag explicitly
 ✓ setting the same tag twice is idempotent, not a second row
 ✓ a security can carry employer_stock and watchlist at once
 ✓ clearing a tag is idempotent and clearing an absent tag is not an error
 ✓ listForMany reads across several securities in one call
 ✓ exposes a real drizzle-backed store with the same shape
 Tests  8 passed (8)
```

**Sabotage:** a fake `inferEmployerStockTag(name)` function referencing the literal `employer_stock` was
inserted into `classify.ts` (a file the grep does not exempt). Re-run:

```
 ❯ no code path infers an employer stock tag from a name, a ticker or a payroll descriptor
   AssertionError: classify.ts writes the literal tag value 'employer_stock': expected [ 'employer_stock' ] to have a length of +0 but got 1
 Tests  1 failed | 7 passed (8)
```

Reverted; diffed byte-identical; re-run green (8/8).

---

## 6. Every control, sabotaged once, restored byte-identical

| #   | Control                                            | File                                                                 | Sabotage                                                  | Observed                                                              | Restored                |
| --- | -------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------- |
| 1   | Unset target set suppresses drift, never a default | `src/targets.ts` `inMemoryAllocationTargetsStore.listAll`            | Returned a hardcoded 60/40 set for an unknown user        | `targets.test.ts` → 1 failed (`expected [ …(2) ] to deeply equal []`) | `diff` clean; 9/9 green |
| 2   | A set that does not sum to 1.0 is refused          | `assertTargetsSumToOne`                                              | `if (false && …)` around the tolerance check              | 2 failed (the named test + the store round-trip test)                 | `diff` clean; 9/9 green |
| 3   | No code path infers `employer_stock`               | `src/classify.ts`                                                    | Inserted a fake heuristic function containing the literal | `tags.test.ts` → 1 failed                                             | `diff` clean; 8/8 green |
| 4   | An earmarked balance is never idle                 | `src/dwell.ts` `cashPositionFor`                                     | `earmarked: false` unconditionally                        | `dwell.test.ts` → 2 failed                                            | `diff` clean; 8/8 green |
| 5   | I1/I3/I5 actually depend on the new readers        | `apps/api/test/db/phase3-advisors.test.ts` `wrapWithGapFieldSources` | `return base;` before the decoration                      | `phase3-advisors.test.ts` → 1 failed (I1's assertion)                 | `diff` clean; 4/4 green |

Every sabotage was red on the first attempt. Every restoration was verified with `diff` against a
pre-sabotage copy before re-running the suite.

---

## 7. For the orchestrator

### 7.1 — `createInsightsInvestmentsPort`'s composition, specified for `apps/api/src/domain.ts`

This work package does not edit `domain.ts`. The following is the exact composition its `holdings()`
method should apply, replacing the three hardcoded lines (`targets: []` at the line comment "§8 Q9
forbids a default 60/40"; `idleCash: null`; `employerStock: false` in both the `positions` loop and the
`concentration.positions.map` block). It reads both `@ctx/investments` (this WP's new readers) and
`@ctx/planning` (WP 4.1's `liveEarmarksByAccount`, already published), which `createInsightsInvestmentsPort`
may do because it is the composition root (08 §1.3 #9) — neither context reads the other.

```ts
// New imports at the top of apps/api/src/domain.ts:
import {
  cashPositionFor,
  cashSnapshotHistory,
  drizzleAllocationTargetsStore,
  drizzleSecurityTagsStore,
  idleCash,
  type CashPosition,
} from '@ctx/investments';
import { liveEarmarksByAccount } from '@ctx/planning';

// Inside createInsightsInvestmentsPort(database, clock), before `return { async holdings(input) {…`:
const targetsStore = drizzleAllocationTargetsStore(database, clock);
const tagsStore = drizzleSecurityTagsStore(database, clock);

// Inside holdings(input), after `const readById = new Map(…)` and before the
// account_type_mix / crypto_custody blocks (so the tag lookup and the target
// read run once per call, not once per position):
const targets = await targetsStore.listAll(input.userId);
const securityIds = [...new Set(reads.map((read) => read.securityId))];
const tagsBySecurity = await tagsStore.listForMany(input.userId, securityIds);
const employerStockOf = (securityId: string): boolean =>
  tagsBySecurity.get(securityId)?.has('employer_stock') ?? false;

// Idle cash: one CashPosition per account holding cash, dwell from this
// context's own history, earmark from Planning's reader — composed here,
// read by neither context from the other.
const asOfDate = DateOnly.parse(input.asOf);
const earmarksByAccount = await liveEarmarksByAccount(database, input.userId);
const cashPositions: CashPosition[] = await Promise.all(
  [...cashByAccount(set).entries()].map(async ([accountId, cash]) => {
    const history = await cashSnapshotHistory(database, {
      userId: input.userId,
      accountId,
      asOfDate,
      currency: BASE_CURRENCY,
    });
    return cashPositionFor(
      {
        accountId,
        asOfDate,
        cash,
        accountValue: valueByAccount(set).get(accountId) ?? cash,
        earmarkedAmount: earmarksByAccount.get(accountId) ?? Money.zero(BASE_CURRENCY),
      },
      history,
    );
  }),
);
const idle = cashPositions.length === 0 ? null : idleCash(cashPositions, { currency: BASE_CURRENCY });

// In the positions[] loop (replacing `employerStock: false`):
employerStock: employerStockOf(group.read.securityId),

// In the aggregate.positions map (replacing the second `employerStock: false`):
employerStock: employerStockOf(position.securityId),

// In the returned aggregate object:
targets: targets.map((target) => ({ assetClass: target.assetClass, weight: Number(target.targetWeight) })),
idleCash:
  idle === null
    ? null
    : {
        total: idle.idleTotal,
        floor: idle.floor,
        minDays: idle.minDays,
        longestIdleDays: idle.rows.reduce((max, row) => Math.max(max, row.idleDays), 0),
      },
```

`cashByAccount` and `valueByAccount` are `src/analytics/cash.ts` functions already exported through
`@ctx/investments` (WP 3.3); nothing new to import there beyond what is listed above. This is the
identical composition `apps/api/test/db/phase3-advisors.test.ts`'s `wrapWithGapFieldSources` applies —
see §4.1 — so applying it to `domain.ts` and then deleting the test-local decorator (calling
`createInsightsInvestmentsPort` directly again) is a safe, mechanical follow-up.

### 7.2 — `packages/db/test/migrate.test.ts`

Both table names are already present in the working tree's copy of this file (`allocation_targets`,
`security_tags`, alphabetically placed) — confirmed by `git diff` before this WP started. **Not edited by
this WP.** One thing changed underneath it: the attribution comment block above the table list still
says `0023_allocation_targets` and needs updating to `0026_allocation_targets` (§2.1) — flagged as the
orchestrator's, per their own message ("the migrate.test.ts attribution is mine to fix").

### 7.3 — `apps/api/test/phase3-registration.test.ts`

`INVESTMENTS_EVENTS` grew from 5 to 6 (`investments.AllocationTargetsChanged` appended, per the dispatch's
own instruction to add the event to the events file and its exported list). Line 192,
`expect(INVESTMENTS_EVENTS).toHaveLength(5);`, now fails:

```
AssertionError: expected [ …(6) ] to have a length of 5 but got 6
 Tests  1 failed | 13 passed (14)
```

**Not edited by this WP** (RULES: this file is not mine). The fix is `toHaveLength(6)`.

### 7.4 — `EXEMPT_TABLES`

Both `allocation_targets` and `security_tags` added to `apps/api/src/reports/export/registry.ts`'s
`EXEMPT_TABLES` as reasoned deferrals ("exported by WP 4.12"), next to the WP 3.2 investments block.
`apps/api/test/db/export-import.test.ts`'s manifest-completeness check — 6/6 — confirms the registry is
complete with both present.

---

## 8. Check results

```
$ pnpm exec tsc -b --noEmit
(clean)

$ pnpm exec eslint packages/contexts/investments packages/contexts/insights/test packages/db apps/api/src/reports
(clean)

$ pnpm exec eslint apps/api/test/db/phase3-advisors.test.ts
(clean)

$ node scripts/check-numeric-boundaries.ts
check-numeric-boundaries: self-test PASS (8 bad declarations caught, the good fixture clean)
check-numeric-boundaries: PASS — 734 file(s) scanned, 0 violations, 71 exempt identifier(s)

$ pnpm run lint:schema-ownership
schema-ownership: ok — 102 table(s) claimed across 14 package(s), 86 defined.

$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
  pnpm exec vitest run --project investments --project investments-db --project db
 Test Files  33 passed (33)
      Tests  279 passed (279)

$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
  pnpm exec vitest run apps/api/test/db/phase3-advisors.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)

$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
  pnpm exec vitest run apps/api/test/db/export-import.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

Known red, not mine to fix, reported in §7.2–7.3:

```
$ DATABASE_URL=… pnpm exec vitest run apps/api/test/phase3-registration.test.ts
 Tests  1 failed | 13 passed (14)   — INVESTMENTS_EVENTS length pin, 5 → 6
```

`git diff --cached --name-only` — empty (checked before writing this section and again below).

---

## 9. Open items

1. **`domain.ts`'s wiring is specified, not applied.** §7.1 is complete and mechanical; until the
   orchestrator applies it, `createInsightsInvestmentsPort` in production still returns `targets: []`,
   `idleCash: null`, `employerStock: false`, and I1/I3/I5 remain silent outside this WP's test-local
   decoration. This is the load-bearing open item — everything else in this WP is inert without it.
2. **`packages/db/test/migrate.test.ts`'s attribution comment** still names `0023_allocation_targets`
   (§2.1, §7.2) — the orchestrator's, by their own message.
3. **`apps/api/test/phase3-registration.test.ts`'s `INVESTMENTS_EVENTS` pin** needs `5` → `6` (§7.3).
4. **Earmark granularity.** `cash_earmarks` reserves a dollar amount _within_ an account; `CashPosition`
   (WP 3.3) carries one `earmarked: boolean` per account. A non-zero earmark therefore marks the whole
   account's cash position as earmarked rather than splitting it into an earmarked and a genuinely idle
   remainder — stated in `src/dwell.ts`'s `cashPositionFor` doc comment as a judgement call, not hidden.
   A finer split is a real refinement to `IdleCashReport`'s shape that this WP did not build.
5. **I1's known gap, inherited unchanged.** `allocation.ts`'s comment notes a target class the portfolio
   does not hold has no `by_asset_class` row to cite and is skipped rather than reported at a 100% gap —
   pre-existing (wp3.10), not reopened here; `allocation_targets` merely makes it reachable for the first
   time.
6. **The decorator in `phase3-advisors.test.ts` becomes redundant once `domain.ts` is wired** (§4.1) —
   delete it and call `createInsightsInvestmentsPort` directly at that point, so the suite proves
   production rather than a stand-in for it.
7. **`AllocationTargetsChanged`'s consumer, if any, is not built.** WP 4.7 emits it; nothing yet listens.
   Not a defect — `HoldingsUpdated` and friends had the same gap at their own WPs — but worth naming so a
   later phase does not assume a subscriber exists.
