<!-- SPDX-License-Identifier: MIT -->

# WP 2.6 — Insights platform: the Advisor contract

Scope: `packages/contracts/advisor/**` and the version constants in
`packages/contracts/src/index.ts`; `@ctx/insights` `src/**`, `schema/**`,
`test/**`; migration `packages/db/migrations/0012_insights.sql`; this package's
eight names in `packages/db/test/migrate.test.ts`.

The 16-line placeholder `advisor.schema.json` became a bundle index over three
normative documents; `ADVISOR_CONTRACT_VERSION` went `0.1.0` → **`1.0.0`**. On
top of it: `SnapshotBuilder` with the 08 §4.2 scope catalogue, the advisor
registry, the seven-step validation pipeline, `pending_review` persistence, the
30/90/permanent dismissal ladder, the alert budget, and kill switches 1–3.

Repo `/home/chris/Projects/PersonalFi`, branch `main`, tree at `dba93bd` with a
clean working tree. Node v26.8.1, pnpm, vitest 5, Postgres on `127.0.0.1:5433`.
Every number below came from a command run against this tree.

**This work package ships no advisors.** There is no rule catalogue in it:
`createAdvisorRegistry([])` is a complete, working registry that proposes
nothing, which is what the app runs until WP 2.7's twenty built-ins arrive.
What is here is everything those rules will be judged by — and, in Phase 5, a
local model, and in Phase 6 a sidecar.

---

## Summary

| Deliverable                                                           | Where                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Three normative JSON Schema documents + a bundle index                | `packages/contracts/advisor/{advisor,v1/*}.schema.json`                  |
| The zod definitions those are emitted from                            | `src/contract/{snapshot,request,response,manifest}.ts`                   |
| Emitter + byte-for-byte parity with the published files               | `src/contract/json-schema.ts`, `test/contract-parity.test.ts`            |
| The 08 §4.2 scope catalogue, as data                                  | `src/contract/scopes.ts`                                                 |
| One assembler, iterating grants                                       | `src/snapshot/builder.ts`                                                |
| Read ports over ledger / budgeting / recurring + fakes                | `src/snapshot/ports.ts`                                                  |
| Merchant pseudonyms and `input_digest`                                | `src/snapshot/tokens.ts`                                                 |
| The seven-step pipeline; the only constructor of a writable insight   | `src/validate/pipeline.ts`                                               |
| Exact decimal, ref resolution, derivations, numerals, markdown, links | `src/validate/{decimal,evidence,derivations,numerals,markdown,links}.ts` |
| Registration as the review point                                      | `src/registry.ts`                                                        |
| Eight tables, constraints, indexes                                    | `packages/db/migrations/0012_insights.sql`                               |
| Query surface for those tables                                        | `schema/{advisors,insights}.ts`                                          |
| Rows in, rows out                                                     | `src/store.ts`                                                           |
| Policy: switches, snapshot, invoke, validate, suppress, write         | `src/service.ts`                                                         |
| Cooldown ladder / alert budget / kill switches, pure                  | `src/policy/{cooldown,alert-budget,kill-switches}.ts`                    |
| Feed, evidence panels, advisor health                                 | `src/read.ts`                                                            |
| Seven events, edge-triggered                                          | `src/events.ts`                                                          |
| Event → job, deduped; nightly fan-out                                 | `src/consumer.ts`, `src/jobs.ts`                                         |

---

## 1. The contract, and its two version numbers

`ADVISOR_CONTRACT_VERSION = '1.0.0'` (`packages/contracts/src/index.ts`) is the
**artefact** version: it moves when anything in the published schema changes,
additive or not, so a reader can tell two checkouts apart.

`contract_version` on the wire is a **single integer** — `1` — because 08 §4.4
says so ("a single integer, negotiated at registration … we support N and N-1
simultaneously"). An advisor pins a major and must refuse anything it does not
understand; a patch to the schema must never force a sidecar redeploy, which is
exactly what putting `'1.0.0'` on the wire would do.

`test/contract-parity.test.ts` asserts the major equals the semver's leading
component, so the two cannot silently disagree.

### The four documents

| Document                  | `$id`                                     | What it pins                                                                                                                                      |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advisor.schema.json`     | `…/contracts/advisor/advisor.schema.json` | The bundle index: the three `$ref`s, `supportedContractVersions`, and the seven prose rules an implementer must satisfy                           |
| `v1/request.schema.json`  | `…/advisor/v1/request.schema.json`        | `AdvisorRequest`, with `AdvisorSnapshot` inlined — every block, every minimisation-shaped field                                                   |
| `v1/response.schema.json` | `…/advisor/v1/response.schema.json`       | `Insight[]`: `requires_review: {"const": true}`, no `status` property, `additionalProperties: false`, four action kinds, `evidence` `minItems: 1` |
| `v1/manifest.schema.json` | `…/advisor/v1/manifest.schema.json`       | What an advisor declares at registration: scopes, capabilities, severity ceiling, limits, egress allow-list                                       |

**Direction of generation.** 08 §4.4 wants the JSON Schema normative and the TS
types generated from it. Doing that literally needs a code generator _and_ a
runtime JSON Schema validator (Ajv) in the dependency graph; this work package
may not add a dependency (docs/CONVENTIONS.md's seven-day `minimumReleaseAge`
and licence gate; the orchestrator owns the batch). zod 4 ships
`z.toJSONSchema`, so the build inverts the direction and keeps the property:
`test/contract-parity.test.ts` re-emits every document and compares it **byte
for byte** with the checked-in file. A zod edit not reflected in the published
schema fails; a hand-edit of the published schema fails too. _Carried:_ if Ajv
lands in a later batch, validate the wire with Ajv against these files and keep
zod for internal shapes — the files do not change, only the validator does.

---

## 2. The scope catalogue (08 §4.2)

`src/contract/scopes.ts` is the table as data, ordered by sensitivity. The
interesting column is **drops**.

| Scope                  | Sens. | Key                    | Yields                                                                                                  | Drops                                                                                          | `external`? | Sourced in Phase 2 |
| ---------------------- | ----- | ---------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- | ------------------ |
| `networth.summary`     | 1     | `networth_summary`     | Assets, liabilities, net worth, 12-month trend                                                          | Every account, institution and provider id; figures **rounded to $100**                        | yes         | yes                |
| `cash.summary`         | 2     | `cash_summary`         | Total cash, account count, blended APY, emergency-fund months, per-account balance + APY                | Institution names, account names, masks, provider ids, account numbers                         | yes         | yes                |
| `cashflow.monthly`     | 3     | `cashflow_monthly`     | Income/expense by category by month, ≤24 months                                                         | Every individual transaction; no merchant appears at all                                       | yes         | yes                |
| `budgets.status`       | 3     | `budgets_status`       | Per-line assigned/activity/available, overspend split cash vs credit, Ready-to-Assign                   | User-written line names and notes                                                              | yes         | yes                |
| `recurring.list`       | 4     | `recurring_list`       | Streams: tokenised vendor, cadence, typical amount, next due, confidence, observed range, price changes | Merchant **names** (tokenised); the individual charges behind the stream                       | yes         | yes                |
| `goals.list`           | 4     | `goals_list`           | Goal name, target, horizon, progress                                                                    | The accounts funding the goal, and any note                                                    | yes         | **no** (Phase 4)   |
| `risk.profile`         | 4     | `risk_profile`         | Tolerance, horizon, tax-bracket **band**, liquidity need                                                | Exact income — the bracket crosses as a band                                                   | yes         | **no**             |
| `market.watchlist`     | 4     | `market_watchlist`     | Symbols tracked                                                                                         | Any position or holding behind a symbol                                                        | yes         | **no**             |
| `holdings.aggregate`   | 5     | `holdings_aggregate`   | Asset-class weights, top-N by weight, account-type mix                                                  | Quantities, cost basis, account linkage                                                        | yes         | **no** (Phase 3)   |
| `holdings.detail`      | 6     | `holdings_detail`      | Quantity, cost basis, lot ages, unrealised P&L                                                          | Account ids and institution names, still                                                       | yes         | **no**             |
| `transactions.summary` | 7     | `transactions_summary` | Counts + sums by category; top merchants                                                                | Descriptions entirely; merchants tokenised; **no date finer than a month**                     | yes         | yes                |
| `institutions.names`   | 8     | `institutions_names`   | The institutions linked                                                                                 | Nothing further — the scope exists to make the otherwise-unconditional strip an explicit grant | **no**      | **no**             |
| `transactions.raw`     | 9     | `transactions_raw`     | Date, bucketed amount, tokenised merchant, category                                                     | Raw descriptors, account identity, and **exact amounts** — a band crosses instead (03 §8.3)    | **no**      | yes                |

Three properties fall out of it being a table rather than prose:

- **An ungranted scope has no code path.** `SnapshotBuilder.build` loops over the
  _effective grant_, not over sources, so an ungranted scope produces no key
  rather than a key someone forgot to delete.
- **`transactions.raw` is refused to `external` by a row, not an `if`.**
  `externalAllowed: false` is read in one place (`scopesPermittedForKind`), and
  the ceiling is applied to the _grant_, so the request the advisor receives does
  not even claim the scope.
- **A granted-but-unsourced scope emits no key either.** `sourcedInPhase2: false`
  covers the four Phase 3/4 scopes. Never an empty block: an advisor cannot tell
  "empty" from "none" and would happily reason about zero.

### One real snapshot, every identifier stripped

Built by `SnapshotBuilder` over the in-memory ports, `today = 2026-09-19`,
`kind: 'builtin'`, all thirteen scopes granted. `emittedScopes` is seven — the
four Phase 3/4 scopes and `institutions.names` produced no key.

```
grantedScopes: networth.summary, cash.summary, cashflow.monthly, budgets.status,
               recurring.list, holdings.aggregate, transactions.summary, transactions.raw
emittedScopes: networth.summary, cash.summary, cashflow.monthly, budgets.status,
               recurring.list, transactions.summary, transactions.raw
inputDigest:   sha256:124e987ac5a341ec9a7b5d63c5eb03391667777a0eee37c6bca6131a17b95f71
```

```jsonc
{
  "networth_summary": {
    "as_of": "2026-09-19",
    // Input assets were 1_662_350 minor; rounded to a multiple of $100.
    "assets": { "minor": "1660000", "currency": "USD" },
    "liabilities": { "minor": "380000", "currency": "USD" },
    "net_worth": { "minor": "1280000", "currency": "USD" },
    "trend": [
      { "month": "2026-07", "net_worth": { "minor": "1190000", "currency": "USD" } },
      { "month": "2026-08", "net_worth": { "minor": "1240000", "currency": "USD" } },
      { "month": "2026-09", "net_worth": { "minor": "1280000", "currency": "USD" } },
    ],
  },
  "cash_summary": {
    "as_of": "2026-09-19",
    "total": { "minor": "1662350", "currency": "USD" },
    "account_count": 2,
    "blended_apy": 0.03707101392606852,
    "emergency_fund_months": 2.7,
    "accounts": [
      {
        "account_ref": "a1",
        "type": "checking",
        "balance": { "minor": "212350", "currency": "USD" },
        "apy": 0,
      },
      {
        "account_ref": "a2",
        "type": "savings",
        "balance": { "minor": "1450000", "currency": "USD" },
        "apy": 0.0425,
      },
    ],
  },
  "budgets_status": {
    "period_start": "2026-09-01",
    "period_end": "2026-10-01",
    "period_kind": "CALENDAR_MONTH",
    "currency": "USD",
    "ready_to_assign": { "minor": "15000", "currency": "USD" },
    "elapsed": 0.6,
    "lines": [
      {
        "line_ref": "l1",
        "category_ref": "c1",
        "category_slug": "food.dining",
        "kind": "CATEGORY",
        "assigned": { "minor": "40000", "currency": "USD" },
        "activity": { "minor": "-42310", "currency": "USD" },
        "available": { "minor": "-2310", "currency": "USD" },
        "cash_overspend": { "minor": "2310", "currency": "USD" },
        "credit_overspend": { "minor": "0", "currency": "USD" },
        "needed_this_period": { "minor": "40000", "currency": "USD" },
        "underfunded": { "minor": "2310", "currency": "USD" },
      },
    ],
  },
  "recurring_list": {
    "as_of": "2026-09-19",
    "currency": "USD",
    "streams": [
      {
        "series_ref": "s1",
        "merchant_ref": "MERCHANT_1154fb18cad7", // never a name (D22)
        "cadence": "MONTHLY",
        "type": "SUBSCRIPTION",
        "status": "ACTIVE",
        "user_confirmed": true,
        "confidence": 0.94,
        "typical_amount": { "minor": "1899", "currency": "USD" },
        "next_due_date": "2026-10-01",
        "periods_per_year": 12,
        "eligible_for_impact": true,
        "price_changes": [
          {
            "effective_date": "2026-06-01",
            "direction": "INCREASE",
            "previous_amount": { "minor": "1599", "currency": "USD" },
            "new_amount": { "minor": "1899", "currency": "USD" },
            "annual_impact": { "minor": "3600", "currency": "USD" },
          },
        ],
      },
    ],
  },
  "transactions_summary": {
    "from_month": "2025-10",
    "to_month": "2026-09",
    "currency": "USD", // no date finer than a month
    "top_merchants": [
      {
        "merchant_ref": "MERCHANT_1154fb18cad7",
        "count": 12,
        "total": { "minor": "22788", "currency": "USD" },
      },
      {
        "merchant_ref": "MERCHANT_aaca3417e7be",
        "count": 9,
        "total": { "minor": "118400", "currency": "USD" },
      },
    ],
  },
  "transactions_raw": {
    "from_date": "2026-06-21",
    "to_date": "2026-09-19",
    "currency": "USD",
    "rows": [
      // The exact amount (1899) is *not* in this block. A band crosses.
      {
        "transaction_ref": "t1",
        "date": "2026-09-01",
        "merchant_ref": "MERCHANT_1154fb18cad7",
        "category_slug": "entertainment.streaming",
        "amount_bucket": "10-50",
        "direction": "outflow",
      },
      {
        "transaction_ref": "t2",
        "date": "2026-09-04",
        "merchant_ref": "MERCHANT_aaca3417e7be",
        "category_slug": "food.dining",
        "amount_bucket": "50-200",
        "direction": "outflow",
      },
    ],
  },
}
```

The same ports, same grants, `kind: 'external'`:

```
grantedScopes: networth.summary, cash.summary, cashflow.monthly, budgets.status,
               recurring.list, holdings.aggregate, transactions.summary
emittedScopes: networth.summary, cash.summary, cashflow.monthly, budgets.status,
               recurring.list, transactions.summary
inputDigest:   sha256:aec9f8773a61338e718e858e08f14dc40ee07563593a2f290cc6605e9daacb7d

"transactions_raw": null            // the grant itself no longer names the scope
"accounts": [
  { "account_ref": "ACCT_dff9b5be54df", … },   // a uuid for builtin, a token here
  { "account_ref": "ACCT_14b5b9c68a80", … }
]
```

Merchants are tokenised for **every** kind (D22). Accounts, categories, budget
lines, series and transactions cross as their own uuids for `builtin` and
`local_model` — the app is about to render a link back to them, and a token we
would then have to reverse is a token with a reversal table — and as tokens for
`external`, because a uuid is a durable handle into an account an external
advisor is not supposed to have one for.

**Derived figures obey the scope that sourced them.**
`cash.summary.emergency_fund_months` is cash ÷ monthly expense, and the expense
half is `cashflow.monthly`'s data, so the field is `null` unless
`cashflow.monthly` was _also_ granted. Asserted by
`'emergency_fund_months is null unless cashflow.monthly was also granted'`.

---

## 3. The no-invented-numbers rule

02-phase-2-dispatch.md §5 names the risk: _an advisor invents a number_. The
built-ins are deterministic today, so today these checks cost nothing and prove
little — which is exactly why they exist now. The contract they guard is the
one Phase 5's local model and Phase 6's sidecar will use, and a defence added
after the first non-deterministic advisor is a defence designed around whatever
that advisor happened to do.

**The rule, stated precisely.** Every numeral a human will read must be
traceable to a value in the snapshot **we** sent, or to arithmetic **we**
re-computed. An advisor may narrate a finding; it may not introduce a figure.

Three mechanisms, none of them a model:

1. **Ref resolution** (`validate/evidence.ts`). `evidence[].source_ref` is a
   path into the snapshot object the builder produced. It resolves, or the
   insight is rejected. The resolution is against the emitted object and
   **never** against the database — going back to the database would make a ref
   citing data the advisor never received _resolve_, which is the exact
   fabrication the check exists to catch. `__proto__`, `constructor` and
   `prototype` are refused as segments before any lookup happens.
2. **Declared arithmetic** (`validate/derivations.ts`). Taken literally, the
   rule would forbid _"$18.99 a month is $227.88 a year"_ — `227.88` is nowhere
   in the snapshot. So an advisor may declare a `derivation`: an expression, the
   `source_ref` inputs it stands on, and the value it claims. A recursive-descent
   parser over a five-token grammar (no `eval`, no `Function`) evaluates it in
   exact scale-6 `bigint` decimal, half-even, and compares. **Literals are not
   free**: only the twenty units in `DERIVATION_LITERALS` are accepted, and an
   expression must reference at least one input — which closes the
   `$0 * 0 + 4999` hole, where an advisor references an input, computes nothing
   from it, and launders a literal as the answer.
3. **The numeral trace** (`validate/numerals.ts`). URLs are stripped; snapshot
   _string_ literals (`2026-10-01`, `MERCHANT_a7f3…`, `food.dining`) are masked
   whole, longest first, so their digits are not torn into numerals that each
   have to be traced; every remaining numeral must equal a candidate under one of
   six enumerated renderings (`v`, `|v|`, `v×100`, `|v|×100`, `v÷100`,
   `|v|÷100`, at the numeral's own decimal places, half-even). It is deliberately
   **not** "within 1%": a tolerance lets a fabricated number pass by being close
   to a real one, which is the failure mode of every plausible hallucination.

The fields read are every one a human sees — `title`, the rendered
`summary_md`, `impact.basis`, evidence labels **and values**, action labels and
rationales, caveats — plus the impact money itself, which the UI renders on its
own outside any prose. They are collected in one function
(`markdown.renderableStrings`), because the likeliest way this check goes wrong
is for the list to live at the call site and fall behind the schema.

**A worked example, from the fixture.** Snapshot holds `"1899"`. Body says _"At
$18.99 a month, this subscription costs $227.88 a year."_ `18.99` traces to
`1899 ÷ 100`. `227.88` traces to the derivation `$0 * 12` → `22788`, ÷ 100.
Change one digit — `$227.99` — and the insight is rejected at step 7 with
`numeral_not_in_snapshot`.

### The seven steps, with a rejected payload per step

`validate/pipeline.ts`. Steps 1–3 reject the **response** (there is nothing
partial worth keeping when the envelope is wrong); steps 4–7 reject the
**insight** (one bad figure should cost one insight, not the run) and are
counted per step on `advisor_runs.rejections`.

| #   | Step          | A payload it refuses                                                                                                  | Verdict                                           |
| --- | ------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | `transport`   | a 200 KiB body against `max_response_bytes: 1024`                                                                     | `transport / response_too_large`                  |
| 2   | `schema`      | `{…, "status": "accepted"}`, or `requires_review: false`, or `evidence: []`, or `proposed_actions[0].kind: "execute"` | `schema / schema_violation`                       |
| 3   | `envelope`    | `request_id` that does not echo the request's                                                                         | `envelope / request_id_mismatch`                  |
| 3   | `envelope`    | two insights sharing `(key, period)` in one response                                                                  | `envelope / duplicate_insight_key`                |
| 4   | `capability`  | `confidence_basis: "deterministic"` from an `external` advisor                                                        | `capability / deterministic_reserved_for_builtin` |
| 4   | `capability`  | an `impact` from an advisor whose manifest says `produces_impact: false`                                              | `capability / impact_not_claimed`                 |
| 5   | `evidence`    | `source_ref: "snapshot:budgets_status.lines[0].available"` when `budgets.status` was not granted                      | `evidence / source_ref_unresolvable`              |
| 5   | `evidence`    | `value: "WEEKLY"` beside a ref that resolves to `"MONTHLY"`                                                           | `evidence / evidence_value_disagrees`             |
| 5   | `evidence`    | `url: "https://evil-example.com/…"` against an allow-list of `["example.com"]`                                        | `evidence / link_host_not_allowed`                |
| 6   | `derivations` | `$0 * 12` claiming `49900` when we compute `22788`                                                                    | `derivations / derivation_value_mismatch`         |
| 6   | `derivations` | `$0 * 0 + 4999`                                                                                                       | `derivations / derivation_forbidden_literal`      |
| 7   | `numerals`    | `"…costs $227.99 a year."`                                                                                            | `numerals / numeral_not_in_snapshot`              |
| 7   | `numerals`    | `"At $18.99 a month<img src=x onerror=…>"`                                                                            | `numerals / markdown_html_tag`                    |

**Totality and determinism.** `test/validation-totality.test.ts` is a
`fast-check` property over arbitrary JSON — including `__proto__`,
`constructor`, `1e400`, `NaN`, cyclic objects — asserting that
`validateResponse` always returns a verdict, never throws, returns the _same_
verdict twice, and never accepts an insight from random data. Each primitive
(`resolveSourceRef`, `evaluateDerivation`, the numeral trace, markdown,
`checkLink`, the decimal parser) carries its own totality property. A validator
that crashes on a payload has not rejected it — it has taken the worker down and
left the run in `started`; and a validator whose answer depends on iteration
order is one whose refusals cannot be reproduced from the stored
`input_digest`.

---

## 4. Sabotage record

Every control below was broken once, the named test was run, and the result was
**red on the first try**. All twelve were restored and the suites are green
(§7). No control in this work package has a PASS that was never observed
failing.

| #   | Control sabotaged           | How                                                            | Test                                                                  | Result  |
| --- | --------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- | ------- |
| S1  | numeral trace               | `checkNumerals` short-circuited to `null`                      | `'an insight whose number is absent from the snapshot is rejected'`   | **red** |
| S2  | ref resolution              | `resolveEvidence`'s `!resolution.ok` branch made unreachable   | `'an evidence ref that does not resolve is rejected'`                 | **red** |
| S2b | ref resolution              | same                                                           | `'an insight citing a path we did not send is rejected'`              | **red** |
| S3  | `requires_review`           | `z.literal(true)` → `z.boolean()`                              | `'no advisor return value produces status other than pending_review'` | **red** |
| S4  | strictness                  | `InsightSchema` `z.strictObject` → `z.object`                  | `'no advisor return value produces status other than pending_review'` | **red** |
| S5  | grant-driven build          | builder loops `SCOPE_CATALOGUE` instead of the effective grant | `'an ungranted scope yields no key in the snapshot'`                  | **red** |
| S6  | per-kind ceiling            | `scopesPermittedForKind` ignores `externalAllowed`             | `'transactions.raw is never emitted for an external advisor'`         | **red** |
| S7  | kill switch 3               | `decideRun`'s `quarantinedAt` branch removed                   | `"a quarantined advisor's output never reaches pending_review"`       | **red** |
| S8  | upsert identity             | `first_proposed_at` added to the conflict branch               | `'a nightly re-run updates the row rather than inserting'`            | **red** |
| S9  | ladder rung 3               | `PERMANENT_AFTER_DISMISSALS` 3 → 4                             | `'a third dismissal suppresses permanently'`                          | **red** |
| S10 | suppression at propose time | `service.ts`'s `isSuppressed` filter bypassed                  | `'cooldown ladder 30/90/permanent'`                                   | **red** |
| S11 | request echo                | envelope's `request_id` comparison bypassed                    | `'a response that does not echo request_id is dropped'`               | **red** |

Each sabotage was applied to the source file, the single test was run by name,
and the file was restored from a copy taken immediately before the edit.

### Re-observed at `dba93bd`, independently

The two load-bearing anti-fabrication controls were broken again at the landing
commit, by a session that did not write them, to check that the table above is a
record of something that still happens rather than of something that once did.
Both were **red on the first try**; `git diff --quiet` was clean afterwards.

**S1 — number traceability.** `untraceableNumerals` (`validate/numerals.ts`)
made to return `[]` unconditionally, so no numeral is ever traced. The fixture
body carries `$227.99` where the derivation computes `22788`:

```
$ pnpm exec vitest run --project insights \
    -t 'an insight whose number is absent from the snapshot is rejected'

+       "summary_md": "At $18.99 a month, this subscription costs $227.99 a year.",
+       "title": "A monthly subscription adds up",
+       "type": "subscription.annual_cost",
+     },
+     "severity": "notable",
+     "status": "pending_review",
+   },
+ ]

 ❯ test/no-fabricated-numbers.test.ts:86:29
     84|     expect(broken.ok).toBe(true);
     85|     if (!broken.ok) return;
     86|     expect(broken.accepted).toEqual([]);
       |                             ^

 Test Files  1 failed | 6 skipped (7)
      Tests  1 failed | 76 skipped (77)
```

The invented figure was **accepted** and reached `status: pending_review`. That
is the whole failure mode the control exists for, and the test sees it.

**S2 — evidence resolution.** Both `unknown_key` / `missing_path` returns in
`resolveSourceRef` (`validate/evidence.ts:116,119`) replaced with
`{ ok: true, value: 0 }`, so a ref into a scope we never sent resolves:

```
$ pnpm exec vitest run --project insights \
    -t 'an evidence ref that does not resolve is rejected'

 ❯ test/evidence-resolution.test.ts:85:37
     83|       expect(outcome.ok, ref).toBe(true);
     84|       if (!outcome.ok) continue;
     85|       expect(outcome.accepted, ref).toEqual([]);
       |                                     ^

 Test Files  1 failed | 6 skipped (7)
      Tests  1 failed | 76 skipped (77)
```

Note what the sabotage had to do to pass: it had to invent a _value_ (`0`) for a
path that does not exist. There is no way to weaken this check that does not
amount to fabricating data on the advisor's behalf, which is the argument for
resolving against the emitted snapshot and never against the database.

Restored:

```
$ git checkout -- packages/contexts/insights/src/validate/{numerals,evidence}.ts
$ git diff --quiet && git status --porcelain
  (no output — tree clean)
```

---

## 5. The kill-switch matrix (08 §4.6)

Level 4 (drop the sidecar's compose profile) is Phase 5/6, where there is a
sidecar to drop.

| #   | Switch                    | Where it lives                                     | Who turns it                               | Scope             | Survives a restart | Refusal recorded as                          |
| --- | ------------------------- | -------------------------------------------------- | ------------------------------------------ | ----------------- | ------------------ | -------------------------------------------- |
| 1   | `ADVISORS_ENABLED`        | configuration (`InsightsSettings.advisorsEnabled`) | operator                                   | every advisor     | yes — it is config | `advisor_runs.refusal = 'advisors_disabled'` |
| —   | `module.insights`         | `MODULE_FLAGS`                                     | operator                                   | the whole context | yes — a flag row   | `… = 'module_disabled'`                      |
| 2   | `advisors.enabled`        | a column, **defaulting to `FALSE`**                | the user                                   | one advisor       | yes — a row        | `… = 'advisor_disabled'`                     |
| 3   | `advisors.quarantined_at` | a column + `quarantine_reason`                     | the app (breaker), cleared only by a human | one advisor       | yes — a row        | `… = 'advisor_quarantined'`                  |

**Any one is enough, and the check happens in one place.** `decideRun`
(`policy/kill-switches.ts`) takes all four inputs and returns a single verdict;
`service.ts` calls it once and there is no second place that asks "is this
advisor enabled?". The reason recorded is the **broadest** one that applies —
"everything is off" and "this one advisor is quarantined" are very different
operational situations.

**The refusal happens before the snapshot exists.** A refused run has
`input_digest IS NULL` and `proposed_count = 0`, enforced by
`advisor_runs_refused_sent_nothing`. So _"a quarantined advisor's output never
reaches `pending_review`"_ is true for a stronger reason than "we drop its
output": there is no output, and the advisor was never handed data.

**A refused run still gets a row.** An absence of rows is also what a broken
scheduler looks like, so "advisors are off" is observable rather than inferred.

**The breaker trips on two things.** Five consecutive failed runs
(`CONSECUTIVE_FAILURE_LIMIT`), _and_ a single run in which the validator refused
≥50% of ≥4 proposals (`REJECTION_QUARANTINE_RATE` / `_FLOOR`). The second
matters more than it looks: an advisor that times out is obviously broken, and
one that returns beautifully-formed JSON in which every number is invented is
worse and never throws. A quarantine does not decay — an advisor that recovered
on its own after five bad nights is an advisor nobody looked at.

**The app is usable with advisors off.** `'the feed is empty and the app is
usable with advisors off'` asserts that `listInsights` answers with an empty
list rather than throwing; a feed that threw when advisors were off would take
the dashboard down with them.

---

## 6. Registration lines

None of these files is owned by this work package. The orchestrator applies them
at the wave boundary (02-phase-2-dispatch.md §4).

### `apps/api/src/platform.ts` — `MODULE_FLAGS`

```ts
{
  key: 'module.insights',
  description:
    'Insights / Advisory: the Advisor contract, the snapshot builder, the ' +
    'validation pipeline and the review queue. Off means no advisor runs, no ' +
    'consumer, no schedule — and a feed that answers with an empty list.',
  defaultEnabled: false,   // flipped true at the wave boundary, after 2.7 lands
}
```

### `apps/api/src/domain.ts` — the three adapters

```ts
import {
  type BudgetPort,
  type LedgerPort as InsightsLedgerPort,
  type RecurringPort,
} from '@ctx/insights';

/** Over @ctx/ledger's readers. Read-only: the port has no write method. */
export function createInsightsLedgerPort(
  database: LedgerDatabase,
  clock: Clock,
): InsightsLedgerPort { /* listAccounts, netWorthTrend, monthlyCashflow,
                           categorySpend, topMerchants, listTransactions */ }

/** Over @ctx/budgeting's getPeriod/listPeriods. `null` when no budget exists. */
export function createInsightsBudgetPort(database: BudgetingDatabase): BudgetPort { … }

/** Over @ctx/recurring's listSeries. merchantId crosses; no descriptor does. */
export function createInsightsRecurringPort(database: RecurringDatabase): RecurringPort { … }
```

`InsightsAccount`, `InsightsBudgetLine`, `InsightsRecurringStream` and
`InsightsTransaction` carry **only what a snapshot block can hold** — no
`institutionName`, no `descriptor`, no user-written line name. Adding one would
be a visible diff in `src/snapshot/ports.ts` _and_ in `src/contract/snapshot.ts`,
reviewed twice, rather than a field that leaks because it was already in scope.

### `apps/api/src/modules.ts` — `appModules`

```ts
{
  flagKey: 'module.insights',
  events: INSIGHTS_EVENTS,                       // 7 definitions
  consumers: [createInsightsConsumer({ registry })],
  jobs: insightsJobs({ database, dependencies: insightsDependencies, clock }),
  schedules: async (userId: string): Promise<void> => {
    await registerNightlySchedule(database, { userId, timezone: options.timezone }, clock);
  },
}
```

where

```ts
const insightsRegistry = createAdvisorRegistry([]); // WP 2.7 supplies the catalogue
const insightsDependencies: InsightsDependencies = {
  registry: insightsRegistry,
  ports: {
    ledger: createInsightsLedgerPort(database, clock),
    budget: createInsightsBudgetPort(database),
    recurring: createInsightsRecurringPort(database),
  },
  settings: {
    advisorsEnabled: config.ADVISORS_ENABLED, // kill switch 1
    moduleEnabled: true, // resolved per user by the flag service
    timeZone: options.timezone,
    baseCurrency: config.BASE_CURRENCY,
    tokenSecret: config.ADVISOR_TOKEN_SECRET, // stable for the life of the install
  },
};
```

`registerNightlySchedule` declares `insights.nightly` at `15 4 * * *` **local**
(08 §3.7 — never the container's `TZ`), 04:15 rather than 03:15 so the advisors
run _after_ the nightly sync has landed and the budget actuals consumer has
caught up. Advice computed from a snapshot taken before the night's transactions
arrived is advice about yesterday.

**The consumer's filter is derived from the registry**, not hardcoded: the union
of `BASE_EVENT_TYPES` (ledger/budgeting/recurring) and every registered
advisor's declared triggers. Adding an advisor in WP 2.7 that wants
`budgeting.ThresholdCrossed` requires no edit to `consumer.ts`.

**The consumer enqueues, it does not run.** An advisor run takes up to five
minutes and does its own two-transaction dance; doing it inside the pump's
transaction would stall every event behind it. The enqueue carries
`dedupeKey: 'insights.run:<advisorId>'`, so a 2,000-transaction backfill
produces one run per advisor rather than two thousand.

### `apps/api/src/routes/insights.ts`

The plan assigns this route file to WP 2.6's _Owns_ list; it is **not** built
here, because `packages/contracts/openapi/openapi.json` is a shared file this
work package may not touch and a route without a regenerated OpenAPI document
fails `check-openapi-drift`. Everything the route needs is exported:
`insightFeed`, `listInsights`, `advisorHealth`, `reviewInsight`, `runAdvisor`,
`listAdvisors`, `setAdvisorEnabled`, `clearQuarantine`, `grantScopes`,
`revokeScopes`, `SCOPE_CATALOGUE`. **Carried to the orchestrator** as the one
open item in §8.

---

## 7. Tests

```
$ DATABASE_URL=… pnpm exec vitest run --project insights --project insights-db --project db
 Test Files  10 passed (10)
      Tests  104 passed (104)
```

| Project       | File                                 | Tests | What it pins                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insights`    | `test/contract-parity.test.ts`       | 5     | Byte equality with `advisor/v1/*`; the bundle index; both version numbers; the published response schema has no `status` and no `execute`/`transfer`/`trade`                                                                                          |
| `insights`    | `test/evidence-resolution.test.ts`   | 9     | `'an insight citing a path we did not send is rejected'`, `'an evidence ref that does not resolve is rejected'`, `'an insight with empty evidence is rejected'`, label disagreement, link allow-list, prototype segments                              |
| `insights`    | `test/no-fabricated-numbers.test.ts` | 11    | `'every numeral in a rendered body appears in inputs_snapshot'`, `'an insight whose number is absent from the snapshot is rejected'`, caveats/title/basis/rationale, impact figures, derivation mismatch, the literal allow-list, the markdown subset |
| `insights`    | `test/snapshot-scopes.test.ts`       | 13    | `'an ungranted scope yields no key in the snapshot'`, `'transactions.raw is never emitted for an external advisor'`, unsourced scopes, tokenisation per kind, $100 rounding, amount bands, digest determinism, cross-user token separation            |
| `insights`    | `test/pending-review.test.ts`        | 10    | `'no advisor return value produces status other than pending_review'`, the four action kinds, strictness, `request_id` echo, the `deterministic` reservation, severity clamping, narrator rules, duplicate keys, the byte limit                       |
| `insights`    | `test/alert-budget.test.ts`          | 17    | 5/20/$50, the no-impact exception, one-time at half weight, stable ordering, the 30/90/permanent rungs, snooze vs dismiss, the three kill switches, both breaker triggers                                                                             |
| `insights`    | `test/validation-totality.test.ts`   | 11    | `fast-check`: total, deterministic, never accepts random JSON; per-primitive totality                                                                                                                                                                 |
| `insights-db` | `test/db/persistence.test.ts`        | 10    | `pending_review` on the row, the `reviewed_at` constraint, `"a quarantined advisor's output never reaches pending_review"`, each switch independently, off-by-default, re-registration, the rejection-rate breaker, usable-with-advisors-off          |
| `insights-db` | `test/db/dedupe-cooldown.test.ts`    | 7     | `'a nightly re-run updates the row rather than inserting'`, period separation, `'a third dismissal suppresses permanently'`, `'cooldown ladder 30/90/permanent'`, snooze, the earned-permanence constraint, reopen                                    |
| `db`          | `packages/db/test/migrate.test.ts`   | 10    | The eight new table names, alphabetical; `user_id` on every one; no float, no naked `TIMESTAMP`                                                                                                                                                       |

Scratch databases: `personalfi_wp_ins_persist`, `personalfi_wp_ins_switches`,
`personalfi_wp_ins_cooldown`.

```
$ node scripts/check-schema-ownership.ts
schema-ownership: ok — 95 table(s) claimed across 14 package(s), 65 defined.
```

### The table list

`packages/db/test/migrate.test.ts` carries the exact alphabetical list. This
work package added its eight — `advisor_runs`, `advisors`, `insight_actions`,
`insight_dismissals`, `insight_evidence`, `insight_feedback`, `insights`,
`snapshot_grants` — beside WP 2.4's four (`delivery_attempts`,
`notification_channels`, `notification_outbox`, `notification_rules`), each in
its alphabetical slot rather than appended, with the per-migration attribution
comment block above it. All twelve are present and the suite is green. The
`db` project also asserts `user_id` on every one of the eight, no float column,
and no naked `TIMESTAMP`.

### The whole pipeline

```
$ just check          # typecheck → lint → check-proxy-routes → test

typecheck exit=0
lint exit=0
check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api …
 Test Files  141 passed | 1 skipped (142)
      Tests  1820 passed | 2 skipped (1822)
 (apps/web) Test Files  15 passed (15)
            Tests  85 passed (85)
```

Green in full, with nothing skipped that this work package owns. `just check` is
not `just verify` — the gate standard (02 §5.7) is explicit that only `just
verify`, run at the landing commit, predicts CI, and it needs docker and a
network. That run is the orchestrator's.

---

## 8. What WP 2.7 implements against, and what is carried

### WP 2.7

A built-in rule is an `Advisor`:

```ts
export interface Advisor {
  readonly manifest: AdvisorManifest; // scopes, capabilities, triggers, limits
  run(request: AdvisorRequest, signal: AbortSignal): Promise<unknown>;
}
```

and is registered with `createAdvisorRegistry([...])`. Nothing in
`@ctx/insights` knows built-ins exist; `registry.assertRegistered` refuses a
manifest that is malformed, asks for a scope its kind may not hold, or claims
egress it has no path for.

Concretely, WP 2.7 needs:

- **`kind: 'builtin'`, `capabilities.deterministic: true`.** The pipeline
  refuses `confidence_basis: 'deterministic'` to anything else, and
  `advisors_deterministic_is_builtin` refuses the row.
- **`egress_allowlist: []`.** A builtin has no network path, so it cannot link
  out and `checkLink` refuses every URL it emits.
- **Every insight cites.** `evidence` is `minItems: 1` at the type level and
  every `source_ref` must resolve into the snapshot. The §5 exit criterion —
  "every built-in advisor produces resolvable evidence refs" — is
  `test/catalog.test.ts`'s to assert and this pipeline's to enforce.
- **Every `$`-figure is a derivation.** An annualisation is
  `{ expression: '$0 * 12', inputs: ['snapshot:recurring_list.streams[N].typical_amount.minor'], value: '…' }`.
  If a formula needs a constant outside `DERIVATION_LITERALS`, adding it is a
  reviewed diff in `validate/derivations.ts` with a stated reason — which is
  exactly the review that should be forced.
- **Ranking and the impact ceiling are WP 2.7's.** `policy/alert-budget.ts`'s
  `rank()` is the knowable subset (impact × confidence, severity-dominant) and is
  exported so WP 2.7 can replace the body without touching a caller. The 07 §3.2
  formula's `actionability` and `dismiss_rate` terms need the catalogue and the
  feedback table.
- **`narrates_only`** exists for Phase 5's local model and is enforced against
  `knownFindingTypes`: a narrator that emits a `type` nobody else found is
  introducing a finding and is rejected.

### Carried

1. **`apps/api/src/routes/insights.ts` is not built** (see §6). It needs the
   OpenAPI regeneration that is a shared-file step.
2. **`@core/secretbox` is not a dependency of `@ctx/insights`**, though
   `scripts/eslint-boundaries.js` already allows it. Merchant pseudonyms
   therefore use `@core/platform`'s `configHash` (documented SHA-256 over
   `canonicalJson`) rather than `sha256`/HMAC. `src/snapshot/tokens.ts`'s header
   states the security argument in full: the construction is a keyed hash, not an
   HMAC, and length-extension does not reach this use because tokens are
   truncated to 48 bits and authenticate nothing. **Changing the construction
   later re-pseudonymises every merchant and orphans every `MERCHANT_…` already
   stored in an evidence row**, so the dependency decision is worth making before
   Phase 5 rather than after.
3. **`fast-check` is not declared** in `@ctx/insights`'s devDependencies. It
   resolves from the workspace root today (as it does for `@core/kernel` before
   its own declaration was added), and `test/validation-totality.test.ts` passes;
   the honest fix is one line in the next dependency batch.
4. **A `local_model` advisor has never run.** `narrates_only` and the
   `knownFindingTypes` rule are asserted against a stub, not against a model.
   Phase 5 is where that claim gets its first real exercise.
5. **`ADVISOR_TOKEN_SECRET` has no config entry yet.** `InsightsSettings` takes
   it as a string; `packages/config` is not this work package's to edit.
