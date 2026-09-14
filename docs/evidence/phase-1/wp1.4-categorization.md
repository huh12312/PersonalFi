<!-- SPDX-License-Identifier: MIT -->

# WP 1.4 — Categorization & Rules: the taxonomy, the decision order, the rules engine

Scope: `@ctx/categorization` — the two-level taxonomy and its seeder, descriptor
normalisation and merchant clustering, the PFC v2 and MCC provider maps, the
rules engine, the naive-Bayes classifier, the six-tier decision function, the
service write paths, migration `0006_categorization.sql`, and the golden
accuracy set that Phase 1's exit criterion is measured against.

Repo `/home/chris/Projects/PersonalFi`, branch `main`. Node 26, pnpm, Postgres
18 on `127.0.0.1:5433`. Every count below is from a command run against this
working tree.

---

## Summary

| Deliverable                                                  | Where                                            |
| ------------------------------------------------------------ | ------------------------------------------------ |
| Two-level taxonomy, 22 top-level / 153 rows, `kind` per node | `src/taxonomy.ts`                                |
| Idempotent per-user seeder (taxonomy + PFC map + MCC)        | `src/seed-taxonomy.ts`                           |
| Descriptor cleaning, fingerprinting, merchant clustering     | `src/normalize/`                                 |
| PFC v2 map — 18 primary, 127 detailed                        | `src/pfc-map.ts`                                 |
| MCC table                                                    | `src/mcc-codes.ts`                               |
| Rule conditions/actions, zod-validated on write **and** read | `src/rules/schema.ts`, `src/rules/match.ts`      |
| Naive-Bayes classifier with an abstention floor              | `src/classifier.ts`                              |
| The six-tier decision function, pure                         | `src/engine.ts`                                  |
| Service write paths (categorize, confirm, rules, explain)    | `src/service.ts`                                 |
| Schema                                                       | `packages/db/migrations/0006_categorization.sql` |
| Golden accuracy set and its harness                          | `test/golden-harness.ts`, `test/golden.test.ts`  |

---

## 1. The taxonomy

**153 rows: 22 top-level categories and 131 leaves**, flattened from
`TAXONOMY` by `FLAT_TAXONOMY` (`src/taxonomy.ts`). Two levels, enforced by a
`CHECK` on `categories.parent_id` rather than by a second table — see
`OWNERSHIP.md` for why `category_groups` does not exist.

Every node carries a `kind` (`income` | `transfer` | `investment` | `expense` |
`other`), which is what keeps money out of the wrong total: a spend report sums
`expense`, and a category that drifted from `transfer` to `expense` would
double-count every card payment. `seeding.test.ts` repairs that drift on re-seed
for exactly this reason.

Top level, with `kind` and leaf count:

| Key                 | Kind       | Leaves |
| ------------------- | ---------- | ------ |
| `income`            | income     | 8      |
| `transfers`         | transfer   | 9      |
| `investments`       | investment | 5      |
| `housing`           | expense    | 5      |
| `utilities`         | expense    | 6      |
| `groceries`         | expense    | 5      |
| `dining`            | expense    | 6      |
| `transport`         | expense    | 8      |
| `travel`            | expense    | 5      |
| `shopping`          | expense    | 11     |
| `home`              | expense    | 6      |
| `health`            | expense    | 8      |
| `personal_care`     | expense    | 5      |
| `entertainment`     | expense    | 6      |
| `subscriptions`     | expense    | 5      |
| `education`         | expense    | 4      |
| `family`            | expense    | 7      |
| `insurance`         | expense    | 5      |
| `fees_and_services` | expense    | 7      |
| `debt`              | expense    | 6      |
| `giving_and_taxes`  | expense    | 4      |
| `uncategorised`     | other      | 0      |

`uncategorised` is a top-level node with no children and is the only key the
engine may return without having decided anything. `isAssignableKey()` rejects
it and rejects every parent: **only leaves are assignable**, asserted in
`taxonomy.test.ts`, in `golden.test.ts` for every rule and every error, and in
`service.test.ts` for the rule-builder ("refuses to build a rule pointing at a
category that is not a leaf").

### Our own labels, where they differ from the provider's

The taxonomy is not Plaid's shape, and four of the differences are deliberate
enough to be worth naming because the provider map has to bridge them:

- **Coffee is not restaurants.** `dining.coffee` is its own leaf; PFC v2 has no
  coffee code and sends `FOOD_AND_DRINK_RESTAURANT`.
- **Software and cloud storage are not electronics.** `subscriptions.software`
  and `subscriptions.cloud_storage`; PFC sends
  `GENERAL_MERCHANDISE_ELECTRONICS` for both iCloud and Adobe.
- **Gyms file under the body, not the software.** `personal_care.fitness`, not
  a subscription.
- **Mortgage principal is debt, not housing.** `debt.mortgage` rather than
  `housing.rent`, so Phase 4's payoff modelling has the principal series.

---

## 2. The decision order

One pure function, `decide()` (`src/engine.ts`). Six tiers, strict order, and
**every tier records what it said whether it won or not** — that trace is what
`explainAssignment` reads back, which is why the engine is a separate module
from the service.

| #   | Tier               | Beats everything below because                                     |
| --- | ------------------ | ------------------------------------------------------------------ |
| 1   | `user`             | The user said so. Absolute; nothing overrides an explicit edit.    |
| 2   | `rule`             | The user said so in advance, and generally.                        |
| 3   | `merchant_default` | A locked merchant is intent; a learned one is this user's history. |
| 4   | `provider`         | Plaid's enrichment: good, general, and not about _this_ user.      |
| 5   | `classifier`       | A guess from this user's own confirmations, or an abstention.      |
| 6   | `none`             | Honest ignorance. Better than a wrong answer in a budget.          |

Tier 1 is **observed, not evaluated**: the user's category lives in
`@ctx/ledger`'s `transactions.user_category_id`, this context does not own that
column, and `decide()` returns immediately when it is set rather than producing
a competing answer.

Two invariants hold the order in place:

- `shouldReplace(stored, fresh)` — a re-run may never _demote_ a decision. A
  transaction categorised by a rule does not silently fall back to the
  classifier because the rule was disabled; the previous answer stands until
  something retracts it. Equal tiers may replace each other, which is what makes
  editing a rule take effect. `stored === 'user'` is replaceable only by `user`.
- `decide()` is pure, so running it five times gives the same answer five times.
  Idempotence is the pair of those two facts, not a flag.

The classifier abstains below `confidenceFloor` (0.6). Learned merchant defaults
need `merchantSupportThreshold` (3) confirmations before they apply; a _locked_
default applies at once because it is intent rather than inference.

---

## 3. Accuracy: the golden set

### How the labels were derived

`@core/seed`'s `SeedMerchant.category` is, in its own words, "a loose hint, not
a taxonomy" — twelve strings chosen before this context existed. They cannot be
the ground truth, and not only because they are coarser: **they cut across**
ours. The seed files Netflix, Spotify, iCloud and Adobe all under
`subscriptions`, while this taxonomy puts the first two under Entertainment and
the second two under Subscriptions. Grading against the seed's strings would
mark two correct answers wrong.

So the labels are **derived and hand-checked**, one per merchant, written out in
`GROUND_TRUTH` (`test/golden-harness.ts`) so they can be argued with. 32
merchants, each mapped to one leaf. Judgement calls are documented inline
(Costco as groceries not general merchandise; REI as hobbies; State Farm as
auto insurance).

Three properties keep the set honest, each asserted:

- **Every seed merchant is labelled** — if `@core/seed` grows a merchant and
  nobody labels it, the graded set silently shrinks and every rate below is
  computed over a different denominator. `dataset.merchantCount === GROUND_TRUTH.size`.
- **The split is temporal, not random.** First 70% of history by date trains,
  last 30% is graded: 617 train / 265 test. A random split leaks the same
  merchant with near-identical descriptors onto both sides.
- **The engine is handed the raw descriptor**, never the seed's `canonicalName`,
  and the merchant id it groups on is `fingerprint(cleanDescriptor(raw))` —
  **not** the seed's `merchantId`. Handing over the seed's id would give the
  merchant-memory tier a perfect grouping for free. Every wrongly-split cluster
  costs accuracy here exactly as it would in the app.

100 rows are excluded from grading: transactions with no merchant (internal
transfers, refunds, interest, fees). They are `@ctx/ledger`'s transfer-pairing
problem and have their own Phase 1 criterion; grading them here would measure
its heuristic and report the number as ours. The excluded count is reported
alongside every metric so the denominator is never mistaken for the whole set.

Provider codes are **synthetic** (`SYNTHETIC_PFC`), because the seed carries no
provider categories. They therefore measure _our mapping table_, not Plaid's
enrichment. They are deliberately not one-to-one with the labels: four are
coarser than the truth, so the provider tier is _expected_ to miss them.

### Results

`n = 265` graded test rows, 100 excluded, 32 merchants, seed 1.

| Configuration         | n   | correct | precision | recall | abstain | Decided by                          |
| --------------------- | --- | ------- | --------- | ------ | ------- | ----------------------------------- |
| `classifier-only`     | 265 | 237     | 0.9875    | 0.8943 | 0.0943  | classifier 240                      |
| `provider-only`       | 265 | 234     | 0.8830    | 0.8830 | 0.0000  | provider 265                        |
| `rules-off`           | 265 | 265     | 1.0000    | 1.0000 | 0.0000  | merchant 263, provider 2            |
| `provider-off`        | 265 | 265     | 1.0000    | 1.0000 | 0.0000  | rule 27, merchant 236, classifier 2 |
| `merchant-memory-off` | 265 | 258     | 0.9736    | 0.9736 | 0.0000  | rule 27, provider 238               |
| **`full`**            | 265 | 265     | 1.0000    | 1.0000 | 0.0000  | rule 27, merchant 236, provider 2   |

Leave-one-merchant-out (each merchant removed from training entirely, then
graded on its own transactions cold):

| Configuration          | n   | correct | precision | recall | abstain |
| ---------------------- | --- | ------- | --------- | ------ | ------- |
| `classifier-only` cold | 265 | 25      | 0.1678    | 0.0943 | 0.4377  |
| `provider-off` cold    | 265 | 43      | 0.2722    | 0.1623 | 0.4038  |
| `provider-only` cold   | 265 | 234     | 0.8830    | 0.8830 | 0.0000  |
| **`full` cold**        | 265 | 258     | 0.9736    | 0.9736 | 0.0000  |

### Read this before quoting the headline

**`full` = 100% is a tautology, and must not be quoted as an accuracy claim.**

`evaluate()` builds each merchant default out of `entry.expectedKey` — the
answer key — and keys it on a fingerprint of the descriptor. Ground truth here
is a pure function of the merchant, and the seed's descriptor families converge
to one fingerprint per merchant. So for any merchant present in `train`, the
merchant-default tier returns the label **by construction**. It is a dictionary
lookup of the answers, and it decides 236 of 265 rows. That is not a bug in the
engine — in production a merchant default is learned from the user's own
confirmations and is _supposed_ to be right — but it is a hard limit on what
this dataset can prove. Every configuration with merchant memory switched on
(`rules-off`, `provider-off`, `full`) is saturated for the same reason.

This is pinned by a test (`the merchant-memory tautology`) so that nobody later
reads `1.0000` as a measurement. If the harness is ever changed to stop deriving
merchant defaults from the labels, that test fails and this section comes down.

**The gate therefore rests on the configurations that cannot leak**, and they
clear it comfortably:

- `classifier-only` **0.8943** — the classifier generalising from its own split.
- `provider-only` **0.8830** — the PFC map. Its 31 errors are the four codes
  deliberately made coarser than the truth (Philz 9, Costco 8, iCloud 7,
  Adobe 7), which is the entire argument for having tiers above the provider.
- `merchant-memory-off` **0.9736** — rules + classifier + provider, merchant
  memory off. Its only residual error is Adobe (7 rows).
- `full` on a **cold merchant** **0.9736** — the honest full-stack figure and
  the strongest evidence in the file.

All four are asserted `>= 0.85`, not merely printed.

### The gate was sabotage-tested

A gate nobody has watched fail is not a gate. Forcing `matchProviderCategory`
to ignore the detailed code (primary-only matching) destroys the provider tier
outright — `provider-only` falls to **0.0000**:

| Gate                                    | Under sabotage             |
| --------------------------------------- | -------------------------- |
| `full stack >= 85%` (the original gate) | **still passed** at 0.9925 |
| `honest configurations >= 85%` (added)  | failed                     |
| `cold merchant >= 85%` (added)          | failed                     |

The original full-stack assertion is **structurally incapable** of detecting the
total failure of a tier, because merchant memory absorbs the loss. That is why
the three assertions above were added. Sabotage reverted; `git diff` on
`src/pfc-map.ts` is empty.

### Other properties asserted

- **A cold stack categorises nothing.** No rules, no merchant memory, no
  provider, untrained classifier → `abstainRate === 1` and `decided === 0`. If
  that number is not 1.0, some tier is inventing an answer.
- **Precision >= recall** with the full stack: a categoriser that abstains
  rather than guessing wrong is the one a user keeps trusting.
- **Never returns a non-leaf**, across every configuration's error list.

---

## 4. Events

Ids and counts, never rows (`src/events.ts`). A consumer that wants the
assignments re-reads them, which is also how it picks up whatever the user has
changed since — a payload snapshot would be stale on arrival.

| Event                                   | Aggregate     | Carries                                                                         |
| --------------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| `categorization.AssignmentsChanged`     | `transaction` | `transactionIds`, `count`, `bySource`, `trigger`, `ruleId`                      |
| `categorization.RuleApplied`            | `rule`        | `ruleId`, `runId`, `retroactive`, `matchedCount`, `changedCount`                |
| `categorization.MerchantDefaultLearned` | `merchant`    | `merchantProfileId`, `ledgerMerchantId`, `categoryId`, `supportCount`, `locked` |

`bySource` exists so a budget can show an honest confidence without re-reading
every row to count tiers. `trigger` (`sync` | `rule_apply` | `confirm` |
`backfill` | `model_retrain`) lets a replay tell a sync apart from a rule change.
A **preview never emits `RuleApplied`** — nothing happened.
`MerchantDefaultLearned` fires at the moment the support threshold is crossed,
not on every confirmation: telling the user once is the difference between the
app feeling like it learned and the app feeling like it nags.

All three are exported as `CATEGORIZATION_EVENTS` so the composition root cannot
register two of them and forget the third.

---

## 5. Root `vitest.config.ts` entries needed

WP 1.4 does not own the root config (WP 1.2 and WP 1.5 are appending to it
concurrently; two agents editing one array is a guaranteed conflict). The two
entries below are needed verbatim in the root `projects` array, alongside
`ledger` / `ledger-db`. `packages/contexts/categorization/vitest.config.ts` is a
package-local stand-in so the suites can be run in the meantime, and **should be
deleted once these land**.

```ts
{
  test: {
    name: 'categorization',
    root: 'packages/contexts/categorization',
    include: ['src/**/*.test.ts', 'test/golden.test.ts'],
    environment: 'node',
  },
},
{
  test: {
    name: 'categorization-db',
    root: 'packages/contexts/categorization',
    include: ['test/**/*.test.ts'],
    exclude: ['test/golden.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
},
```

The golden set sits in the **unit** project despite living under `test/`: it
needs a fixture directory, not a Postgres, so the Phase 1 accuracy gate runs in
`just test-unit` on a laptop with nothing up.

### `scripts/eslint-boundaries.js`

Also not owned by WP 1.4. `@core/testkit` and `@core/seed` are devDependencies
of this package, imported only from `test/`. `@ctx/ledger` and `@ctx/connections`
solved this with a per-context `LAYERS` entry naming both packages; this package
needs the same:

```js
'@ctx/categorization': ['@core/kernel', '@core/platform', '@core/db', '@core/testkit', '@core/seed'],
```

Until it lands, three `eslint-disable-next-line personalfi/layer-imports`
directives in `test/harness.ts` stand in for it — deliberately confined to that
one file so landing the policy entry is a three-line deletion.
`reportUnusedDisableDirectives: 'error'` will fail the build if whoever lands it
forgets to remove them, which is the behaviour we want.

---

## 6. Proposed `@ctx/ledger` hook for the rule tier

**Not applied — WP 1.4 does not own `packages/contexts/ledger`.** Proposed here
as a precise diff for whoever does.

`resolveEffective()` currently resolves `categoryId` straight from the overlay,
and its own header says why the rule tier is missing:

> 04 §2.2 states a three-tier order with a rule result between the two. WP 1.4
> (Categorization) owns rules and there is no rule layer yet; the seam is the
> overlay, which a rule writes to with its own provenance. Deliberately _not_
> pre-built: a resolution tier with no producer is a tier nobody can test.

There is now a producer. The tier can be built, and it belongs between user
intent and provider truth, matching `decide()`'s order exactly.

```diff
--- a/packages/contexts/ledger/src/types.ts
+++ b/packages/contexts/ledger/src/types.ts
@@ export interface TransactionOverlay {
   readonly userNote: string | null;
   readonly userExcluded: boolean;
   /** Opaque. `@ctx/categorization` owns categories; the ledger stores the id. */
   readonly userCategoryId: string | null;
   readonly userMerchantName: string | null;
 }
+
+/**
+ * The rule tier's answer for one transaction: 04 §2.2's middle tier.
+ *
+ * Opaque here in exactly the way `userCategoryId` is — the id is one of
+ * `@ctx/categorization`'s `categories.id` values and the ledger never
+ * interprets it. Supplied by the caller (the composition root reads
+ * `category_assignments`), never queried from here: `resolveEffective` is pure
+ * and a resolution function that can do I/O is one that will eventually do I/O
+ * on the read path for 50,000 rows.
+ */
+export interface RuleResolution {
+  readonly ruleCategoryId: string | null;
+}
+
+/** No rule matched. The state every row resolves in until one does. */
+export const NO_RULE: RuleResolution = Object.freeze({ ruleCategoryId: null });
```

```diff
--- a/packages/contexts/ledger/src/effective.ts
+++ b/packages/contexts/ledger/src/effective.ts
@@ export function resolveEffective(
 export function resolveEffective(
   fact: TransactionFact,
   overlay: TransactionOverlay,
+  rule: RuleResolution = NO_RULE,
 ): EffectiveTransaction {
@@
-    categoryId: overlay.userCategoryId,
+    // Tier order, and the only place that knows it: an explicit user edit, then
+    // a rule the user wrote in advance, then nothing. The provider's own
+    // category is deliberately absent — `@ctx/categorization` owns that mapping
+    // and writes its result to `category_assignments`, so surfacing it here
+    // would be a second place that decides what a transaction is.
+    categoryId: overlay.userCategoryId ?? rule.ruleCategoryId,
     note: blankToNull(overlay.userNote),
```

The default parameter keeps all existing call sites compiling and behaviour
identical until a caller passes a resolution, so this is additive. The three
writers that call `resolveEffective` (`apply.ts` ×3, `overlay.ts` ×1) each need
to decide whether to thread one through; the read paths use the stored
projection and are unaffected until a backfill re-runs.

`read.ts:380` ("every row whose stored projection might have drifted") is the
existing mechanism for that backfill, and is the reason this can land without a
migration.

---

## 7. Verification

| Check                                                 | Result                                  |
| ----------------------------------------------------- | --------------------------------------- |
| `pnpm typecheck`                                      | clean, repo-wide                        |
| `pnpm exec eslint packages/contexts/categorization`   | clean                                   |
| `pnpm exec prettier --check` on owned paths           | clean                                   |
| `node scripts/check-schema-ownership.ts`              | ok — 94 tables, 14 packages, 41 defined |
| Migration `0006` on a fresh database (`--project db`) | 10 passed; all nine tables present      |
| `categorization` (unit + golden)                      | **252 passed**, 7 files                 |
| `categorization-db`                                   | **56 passed**, 3 files                  |

Run the package's suites with:

```
pnpm exec vitest run --config packages/contexts/categorization/vitest.config.ts
```

`categorization-db` skips itself when `DATABASE_URL` is unset. Scratch databases
are named `personalfi_catg_<suite>_<unique>` — unique rather than per-suite,
because two runs of one suite (a watch rerun, two agents on one machine) would
otherwise race each other's `DROP DATABASE`.

Migration `0006` stores both confidence columns as `NUMERIC`, not `REAL`:
`service.test.ts` asserts a confidence round-trips as a bounded decimal rather
than a float artefact, because a budget that shows "83.00000001% confident" has
told the user something false about how sure it is.

---

## 8. Deferred

- **Root `vitest.config.ts` and `scripts/eslint-boundaries.js` entries** —
  §5. Owned by concurrent work packages; the package-local vitest config and the
  three lint directives in `test/harness.ts` are the stand-ins and both are
  self-deleting once the entries land.
- **The `resolveEffective` rule tier** — §6. Proposed, not applied.
- **A golden set that can actually measure merchant memory.** §3: the current
  set cannot, because its labels are per-merchant. Measuring that tier honestly
  needs either a dataset where one merchant legitimately maps to several
  categories (Amazon as groceries _and_ electronics), or real user
  confirmations. Until then `merchant-memory-off` and the cold-merchant figure
  are the numbers to watch, and the tautology test keeps `full` from being
  mistaken for one.
- **Real provider categories.** `SYNTHETIC_PFC` measures our mapping table, not
  Plaid's enrichment. The WP 1.3 Plaid adapter is the first chance to grade the
  provider tier against codes we did not write.
- **MCC tier.** `mcc_codes` is seeded and `decide()` accepts an `mcc`, but no
  seed transaction carries one, so the tier is exercised only by unit tests and
  contributes nothing to the metrics above.
- **Rule actions beyond `set_category`.** `IMPLEMENTED_ACTIONS` gates the
  others; `rules.actions` validates them on write so the schema does not need to
  change when they arrive.
- **Classifier retraining cadence.** `retrainClassifier` is manual and
  `classifier_versions` keeps exactly one active model per user; deciding when
  to call it belongs with the job scheduler.
