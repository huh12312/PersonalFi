<!-- SPDX-License-Identifier: MIT -->

# WP 5.3 — The narrator: grounded narration only

_Status: IN PROGRESS (written incrementally; sections fill as the work lands)._

Base: `d20ae99` on `main`. Contract 1.4.0 → **1.5.0**. Migration **0031**.

## 0. Log (as it happens)

- Started 2026-09-30. Read the dispatch §1–§6; the code survey follows.
- Survey facts that shaped the design (measured, not assumed):
  - The `drift` seed's full snapshot (every scope, through the real `SnapshotBuilder`) is **30,066
    bytes** of JSON; WP 5.2's adapter refuses any rendered prompt over **20,000 bytes**
    (`maxPromptBytes`, sized for `num_ctx` 8192), and this host's pinned model evaluates a prompt at
    **~7.4 tokens/s** (wp5.2 §12 item 7). A narrator handed the snapshot its grant would describe
    cannot run at all on the seed, and would spend ~13 minutes reading one it could.
  - `SourceRefSchema` (`contract/response.ts`, not this package's file) accepts only `snapshot:` and
    `external:` refs, so a narration cannot _cite_ a `finding:` ref without a response-schema change
    this package does not own. The `finding:` namespace is therefore where a narration's citations
    are _resolved_, not a string it writes (design item 3).
  - `@ctx/insights` may not import `@advisor/local-model`; the narrator is a factory over an
    `Advisor['run']`-shaped port the composition root binds.

## 1. Design, decided before code

1. **A narrator's request carries the findings envelope and an empty snapshot.** For a
   `narrates_only` advisor the service builds `snapshot: {}` and fills `findings`; `granted_scopes`
   is the narrator's effective grant (what the findings were laundered against, and what WP 5.1's
   query shape hashes), and `advisor_runs.emitted_scopes` is the union of the included findings'
   source scopes — the data categories that actually reached the model, a subset of the grant by
   construction. Two reasons, both measured above: minimisation (the narrow trace makes every
   snapshot figure unusable to the narrator, so sending them is exposure with no purpose) and the
   prompt budget. The validator does **not** rely on the snapshot being empty — every narrator test
   below puts the full `drift` snapshot in the request, so the narrow trace is tested against the
   thing it must refuse.
2. **The laundering rule.** A finding enters only if its source run's `emitted_scopes` ⊆ the
   narrator's effective grant. A finding whose `run_id` is gone (pruned, `SET NULL`) has no provable
   source scopes and is excluded — fail closed.
3. **1:1 and the `finding:` namespace.** A narration carries its finding's `key`, `type` and
   `period`; step 4 resolves it with `resolveFindingRef(findings, 'finding:<key>')` and requires the
   type and period to agree. Its evidence rows cite the finding's own `snapshot:` refs, and step 5
   resolves each **through the finding** (`finding:<key>` → the envelope row with that `source_ref`),
   never through a snapshot; value agreement is exact after formatting, not containment.
4. **The narrow trace.** For a `narrates_only` advisor step 7's candidates are the numerals the
   narrated finding itself rendered — its evidence values, its own title/summary/impact-basis prose
   (text the builtin already passed step 7 with), its impact display strings and its derived values
   — matched **verbatim** (same digits, same decimals, same percent-ness), with no `×100`/`÷100`/`|v|`
   renderings. A narrator may quote the finding; it may not reformat, round, or import.
5. **Capability (step 4) for a narrator, all refusals:** not `model` confidence basis, any impact,
   any proposed action, any derivation, a severity above its finding's.
6. **Linked, never ranked.** A narration row carries `narrates_insight_id`; `listInsights` (and so
   the feed, the dashboard slice and anything reading through it) excludes every row with it set; a
   narration emits no `InsightProposed`. A rejected narration writes nothing: the builtin row is
   never touched by a narrator run.

## 2. The trace context, before and after

Computed from the code (`validate/numerals.ts`'s `traceContext`/`untraceableNumerals` against
`findingTraceContext`/`untraceableInFinding`), over the `drift` seed's full snapshot through the real
`SnapshotBuilder`, for the subscription price-rise finding (`subscription.price_increase…`, summary
_"A subscription went from $15.99 to $18.99 on 2026-06-01 — about $36.00 more a year."_), 2026-09-30:

| | Before: snapshot-wide (every advisor, and a narrator until WP 5.3) | After: narrow (a `narrates_only` advisor) |
| --- | --- | --- |
| Candidate values | **168** distinct numeric values in the snapshot (30,066 bytes), each under **6 renderings** (`v`, `\|v\|`, `×100`, `\|v\|×100`, `÷100`, `\|v\|÷100`) at the numeral's own decimals; 299 string literals masked | **3** figures, verbatim: `15.99`, `18.99`, `36.00` — the finding's own rendered numerals (evidence values, title/summary/basis, impact display strings, re-computed derivation values); dates and pseudonyms masked whole in both the finding and the narration |
| Integers 1–100 a narrator could write and pass | **49** | **0** |
| Integers 1–9,999 | **119** | **0** |
| Money `$0.01`–`$999.99` (at cents) | **281** | **3** (`$15.99`, `$18.99`, `$36.00`) |
| Percentages `0.1%`–`100.0%` (one decimal) | **76** | **0** |
| `$5,400.00` (August's income, §1's misattribution) | passes (`540000 ÷ 100`) | refused, `numeral_not_in_finding` |
| `2026` alone (a date's year lifted out) | passes (measured: some snapshot value renders to it) | refused — the date is quotable only as the date |

Across all 38 laundered `drift` findings the narrow context holds **1–7 figures per finding (median
4)**. What a narrator gains in exchange for the 168×6: nothing it needs — it is quoting a finding,
and every figure the finding showed the holder is available to it exactly as shown. Matching is
verbatim: `$36` does not stand for `$36.00`, `5,400` does not stand for `5,400.00`, and no rescaling is
tried (`test/narrator.test.ts`'s first case holds both the misattribution and the rounding).

The first version of `findingTraceContext` harvested figures from the finding's texts _without_
masking dates first, so `2026`, `-06` and `-01` were loose candidates; found while computing this
table and fixed before it was written (dates and pseudonyms are now masked in the finding's texts
before harvesting — the same vocabulary the narration is masked with).

## 5. The laundering rule's table

A finding enters a narrator's request only if **every scope its source run emitted** (the run's
`advisor_runs.emitted_scopes`, not its manifest's request) is in the narrator's effective grant.
`launderFindings` is pure; `assembleFindings` feeds it from the database.

| Finding (built-in) | Its source run emitted | Narrator's effective grant | Enters? | Why |
| --- | --- | --- | --- | --- |
| `cash.yield_spread` | `cash.summary`, `market.rates` | `cash.summary`, `market.rates` | **yes** | ⊆ |
| `cash.yield_spread` | `cash.summary`, `market.rates` | `cash.summary` | no — `scope_not_granted: market.rates` | subset, not overlap |
| `investing.expense_ratio` | `holdings.detail` | `cash.summary`, `market.rates` | no — `scope_not_granted: holdings.detail` | the §3 WP 5.3 case: a cash narrator never reads positions through a finding |
| any, `insights.run_id` pruned (`SET NULL`) | unknown | anything | no — `source_run_unknown` | fail closed |
| `spending.duplicate_charge`, `subscriptions.duplicate_service`, `spending.uncategorised` | include `transactions.raw` | the narrator's full bound (`NARRATOR_SCOPES`) | **never** | the manifest does not ask for `transactions.raw`, so no grant can admit it (and the built-ins read 14 scopes; the manifest ceiling is 13) |
| `cash.account_count` (DB test) | `cash.summary` | `recurring.list` | no — the run completes with 0 proposals and **0 model calls** | the service short-circuits an empty envelope |

The table's first three rows and the fifth are `test/narrator.test.ts` →
`'a finding whose source scopes the narrator was not granted never enters its request'`; the sixth is
`test/db/narration-link.test.ts`'s third case, through the real service. Sabotage C (§7) removes the
subset check and both go red.

## 3. The §1 finding, reproduced red first (2026-09-30, before any validator change)

Contract 1.5.0 and the pure envelope builder (`advisors/local/findings.ts`) in place; `validate/`
untouched — step 7 still the snapshot-wide trace, step 4 knowing only `knownFindingTypes`.
`test/narrator.test.ts` run with the full `drift` snapshot in the narrator's request:

```
× a narration may use only the figures of the finding it narrates: a real snapshot value from elsewhere is rejected
  AssertionError: expected [ 'accepted' ] to deeply equal [ 'numerals:numeral_not_in_finding' ]
× a narration of a finding the builtins did not make is rejected
  AssertionError: expected [ 'accepted' ] to deeply equal [ 'capability:narration_finding_mismatch' ]
× a narrator cannot claim deterministic, carry impact, propose an action or rise above its finding's severity
  AssertionError: capability:narration_basis_not_model: expected [ 'accepted' ] …
✓ a finding whose source scopes the narrator was not granted never enters its request   (new function; nothing to be red against)
```

The first line is 05 §1 exactly: a narration of the subscription price rise that says _"about
$5,400.00 more a year"_ — `$5,400.00` being August's income (`cashflow_monthly.months[14].income`,
`"540000"` minor units), a real figure under the wrong label — passes all seven steps, because
`540000 ÷ 100` renders `5400.00`. The faithful control (only `$15.99`, `$18.99`, the date) was
accepted in the same run, so the red is the trace and not a harness that refuses everything. The
second red is the 1:1 gap: a known `type` under a key the built-ins never used was accepted.

## 7. Sabotage log (recorded as run; each restored by editing the text back, confirmed by `sha256sum -c` against the pre-sabotage hashes and `grep -c SABOTAGE` = 0)

| # | Sabotage | Observed | First try |
| --- | --- | --- | --- |
| A | **The narrow trace widened back to the snapshot** — `checkNumerals`' `if (finding !== null)` made `if (finding !== null && false)`, so a narrator is traced snapshot-wide under six renderings again | `test/narrator.test.ts` → `× a narration may use only the figures of the finding it narrates…` — `expected [ 'accepted' ] to deeply equal [ 'numerals:numeral_not_in_finding' ]`: the §1 fabricated-but-traceable `$5,400.00` passes; 1 failed / 3 passed | red |
| B | **The 1:1 key check removed** — `narratedFindingFor` resolves by `type` alone (`findings.find(entry => entry.type === narration.type)`) instead of `finding:<key>` | `× a narration of a finding the builtins did not make is rejected` — `expected [ 'accepted' ] …`: a narration under the key `…2026-06-01.second`, a finding the built-ins never made, passes (it cites the real finding's refs and quotes only its figures, so no later step catches it); 1 failed / 3 passed | red |

## 4. Linked, never ranked — migration 0031 and the write path

`packages/db/migrations/0031_insight_narrations.sql`: `insights_narration_target_idx UNIQUE (user_id,
id)` (the composite FK's target — named for this migration, deliberately not the
`<table>_user_id_idx` shape 0028 used, so a later migration following that precedent for
`insights` cannot collide by name); `insights.narrates_insight_id UUID` with
`insights_narration_same_user FOREIGN KEY (user_id, narrates_insight_id) REFERENCES insights
(user_id, id) ON DELETE CASCADE`; `insights_narration_not_self` CHECK; the partial index
`insights_narrates_idx` for the card's lookup. References only `insights` (0012). No new table, so
no export-bundle registration and no schema-ownership row (the column is on a table `@ctx/insights`
already owns). Drizzle: `schema/insights.ts` gains `narratesInsightId` and the two indexes.

The write (`service.ts`, the narrator branch of transaction 2): the narration is upserted through the
ordinary `upsertInsight` (it passed the same seven steps) and linked in the same transaction by
`advisors/local/link.ts`'s `linkNarration`, whose `UPDATE … WHERE EXISTS` requires the finding to
exist, be the same user's, and not itself be a narration — otherwise the narration row is deleted
in-transaction and not counted. No `InsightProposed` is emitted for it. The read: `listInsights`
gains `narrates_insight_id IS NULL`, so the feed, the dashboard slice (`insightFeed`) and WP 5.6's
Brief (which assembles through `listInsights`, `src/brief/assembly.ts`'s header) never see a
narration as a row of its own; `narrationsFor(executor, userId, findingIds)` is the card's read — the
newest narration per finding, **only while it is at least as new as its finding** (a finding the
built-in re-proposed since is shown with its template text until a new narration is accepted).

`test/db/narration-link.test.ts` (real `runAdvisor`, real switches/approval/barrier, the real
`local.narrator` over a recorded-reply model port), 3/3 green:

- `'a narration never takes a feed, dashboard or Brief slot of its own'` — one model call, carrying
  the envelope and `snapshot: {}`; the narration row links to its finding; `listInsights` (the
  Brief's source) returns only the finding; no slice of `insightFeed` contains the narration; asking
  `listInsights` for the narrator's advisor id returns `[]`; zero `InsightProposed` for it;
  `narrationsFor` carries it; `advisor_runs.granted_scopes = emitted_scopes = ['cash.summary']`,
  `llm_model = fake-model@sha256:…`, `llm_prompt_hash = sha256:…`.
- `'a rejected narration leaves the builtin's text in place and the run records the step'` — a good
  narration, then a week later the built-in re-proposes and the model fabricates `7`: exactly two
  model calls in total (**no retry**), the run `completed` with `rejected_count 1` and
  `rejections = [{ step: 'numerals', reason: 'numeral_not_in_finding', … }]`, the built-in's
  title/summary byte-identical to just before, no new narration row, and the card offers no
  narration (the week-old wording is older than the re-proposed finding).
- (additional) `'a narrator whose grant does not cover a finding's source scopes is never called'`
  — narrator granted `recurring.list`, the only finding built from `cash.summary`: run `completed`,
  0 proposed, **0 model calls**, `emitted_scopes = []`, no `llm_prompt_hash` (no prompt was made).

`insights-db` whole project after the change: 10 files / 39 tests green (WP 5.1's kill-ladder,
local-lane, payload-preview and breaker suites run the same path with a non-narrator `local_model`
advisor, unchanged).

### The `migrate.test.ts` attribution block for 0031 (for the orchestrator — WP 5.6 owns that file this wave)

No table is added, so the alphabetical table list does not change. Insert between the 0030 and 0034
blocks:

```ts
      // 0031_insight_narrations: no new table. insights gains
      //   narrates_insight_id (WP 5.3: a narration — alternative wording a
      //   narrates_only advisor wrote — links to the finding it narrates and
      //   is never ranked; NULL is a finding), a user-scoped composite FK
      //   (user_id, narrates_insight_id) → insights (user_id, id) ON DELETE
      //   CASCADE over the UNIQUE index insights_narration_target_idx it
      //   creates, a not-self CHECK and a partial index for the card's lookup.
      //   references only 0012-era insights (05 §4).
```
| C | **The laundering rule removed** — `launderFindings`' `if (ungranted.length > 0)` made `if (false && …)`, so a finding enters whatever scopes built it | `test/narrator.test.ts` → `× a finding whose source scopes the narrator was not granted never enters its request` — `expected [ …(2) ] to deeply equal [ 'cash.yield_spread.acct-checking' ]`: the `holdings.detail` expense-ratio finding is admitted to a narrator granted `cash.summary` + `market.rates`. And through the real service: `test/db/narration-link.test.ts` → `× a narrator whose grant does not cover a finding's source scopes is never called` — `expected 1 to be +0`: the `recurring.list`-granted narrator was handed the `cash.summary` finding and the model was called | red (both) |
| D | **A retry loop added** — `runNarratorEval` re-asks the model (up to 3 more calls) for any request whose narrations were not all accepted, and keeps the later verdict | `test/eval-harness.test.ts` → `× the harness counts first-attempt acceptance per step, and a scripted one-in-ten fabricator reads 90%` — `expected 31 to be 27` (four extra calls). The same sabotaged harness run directly over the same 20 drift findings: **steps 1–7 read `40/40 = 100%`** where the first-attempt truth is `36/40 = 90%`; restored, the same script reads `27` calls and `0.9`. The retry launders exactly the rate the criterion measures | red |

## 6. The evaluation harness, `redactDigits`, and the cases

**The harness** (`src/advisors/local/eval.ts`, CLI `scripts/advisor-eval.ts`): one model call per
request, one verdict per finding, `passedThrough` 0–7 per narration; the report gives the cumulative
count through each step and the first-attempt rates for steps 1–5 and 1–7 side by side. A reply
failing steps 1–3 fails every finding it carried at that step; a finding the reply skipped is
`no_narration` (passed 1–3, nothing for step 4); a thrown adapter error is `model_error` (passed 0);
narrations under keys nobody asked for are counted as `extras` and never stand in for a missing
one. Re-running a chunk never retries: `--finalise` keeps the **first** line recorded for each
request index.

`test/eval-harness.test.ts` (3 cases; the third runs once the recorded file exists):
`'the harness counts first-attempt acceptance per step, and a scripted one-in-ten fabricator reads
90%'` — 20 real `drift` findings, every one alone and then in threes (27 requests, 40 narrations),
the tenth narration each time inventing `$9,999.99`: exactly 27 calls, `passedThrough =
[40,40,40,40,40,40,40,36]`, steps 1–5 `40/40`, steps 1–7 `36/40 = 0.9`, failures `{
numerals:numeral_not_in_finding: 4 }`. Sabotage D (§7) is this test going red.

**`redactDigits`, implemented** (`advisors/local/findings.ts`'s header has the full argument): the
only holder-written free text that crosses any scope is a goal name; the narrator reads it only
through the envelope (its snapshot is empty); so for a `local_model`/`external` reader every digit
run in a cited goal name (`snapshot:goals_list.goals[n].name`) is stripped — from that evidence
value and from every place the finding quoted it — before the envelope is built, gated on
`scopeDefinition('goals.list').minimisation.redactDigits`. **Not closed, named:** `SnapshotBuilder`
(not this package's) still emits goal names unredacted to any advisor that receives the `goals.list`
block itself; no production `local_model` advisor does, and Phase 6's `external` advisor must not
until the builder reads the flag (Needs the orchestrator, item 4).

**The cases** (`scripts/advisor-eval.fixtures.ts`): the correctness seed's `drift` (38 findings)
and `tight` (7), and WP 4.13's scale seed (`generatePhase4Scale(1)`, 11 findings: crypto exchange
custody, eight crypto missing-basis positions `SCL188`–`SCL195`, two goal-pace findings) — **56
distinct findings**, every one laundered against the narrator's bound (the three
`transactions.raw` findings of `drift` never enter) and redacted for a `local_model` reader. The
scale adapter's assumptions (USD positions only, `crypto`/`us_equity` labels, no cost basis, a
simplified goal pace) are in its header. Plan: every finding alone, then in pairs — **84 requests,
112 narrations**.

## 8. The live evaluation (in progress — written as it runs)

**Setup, 2026-09-30.** Seven empty placeholder files created in `secrets/` for the optional
provider keys (`tiingo_api_key fred_api_key coingecko_api_key openfigi_api_key coinbase_key_name
coinbase_private_key etherscan_api_key`; none existed before). `docker compose --profile local-llm up
-d --wait ollama` — **only `ollama`**: the eval needs nothing else, and every other service would
be load on the measurement. Host: 8 logical CPUs, 22 GiB RAM; load average 2.29 at start. The eval
runs inside the `worker` image on the `llm` network with the repository bind-mounted read-only:

```sh
docker compose run --rm --no-deps --entrypoint node \
  -v "$PWD":/repo:ro -v /tmp/wp53/out:/out -w /repo worker \
  --experimental-strip-types scripts/advisor-eval.ts --live \
  --endpoint http://ollama:11434 --model qwen2.5:7b-instruct-q4_K_M \
  --digest sha256:845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e \
  --out /out/live.jsonl --from <n> --budget-ms 540000
```

(`docker compose run` also created an empty `personalfi_pgdata` volume, because `worker` declares
it; nothing wrote to it.)

**Calibration request (12:31Z, recorded in a separate file and not counted):** one finding alone —
**247 s** wall (the model's cold load included), prompt 2,431 B / 598 tokens, **522 generated
tokens**, refused at **step 2** (`schema_violation`): the reply wrote `"confidence": 100`. Two
consequences, both acted on before the counted run:

1. WP 5.2's `NARRATION_FORMAT` states `confidence` as `minimum 0, maximum 1`, and Ollama's
   structured-output grammar does not enforce numeric bounds — so the format could not prevent it,
   and the validator (correctly) did. The narrator now supplies its own reply format,
   `advisors/local/format.ts`'s `NARRATOR_REPLY_FORMAT`, passed as the adapter's `format` option
   (WP 5.2 built the option for exactly this): `confidence` an **enum** of `0.5…0.9`, evidence rows
   1–3 with `kind` never `external`, no caveats, no actions, no derivations, `impact` all-null. The
   validator is unchanged by it and runs regardless — a convenience, never a control (wp5.2 §2).
2. The model restated all four evidence rows and the finding's own prose (522 tokens at ≈2.5
   tokens/s). Capping evidence at three rows and caveats at zero is also what keeps a narration
   inside the time a lane run is allowed (§8's timing below).
3. **Calibration run 2 (12:40Z, four requests, not counted):** with the reply format in place, 2 of 4
   accepted; the other two were `no_narration` — the model wrote the finding's **derivation id**
   (`monthly_subscriptions`, `excess_over_cushion`) where the finding's `key` belonged, so the
   narration named no finding (the validator counted it as an extra, refused at step 4). The
   envelope's `derived` was `[{ id, value }]`; a narrator declares no derivation and has no use for
   the ids, and the dispatch asks for derived _values_. **`derived` is now values only**
   (`["63298"]`), contract 1.5.0 regenerated before commit (it has never shipped), and the counted
   run restarted from request 0 with the final request shape. Single-finding wall times in these
   four: 107–170 s at load 4.7–7.1 (model warm).

Three calibration requests in total (5 narrations) preceded the counted run, each changing the
_request shape or reply format_ — never the validator, and never by re-asking: the counted run
below begins from request 0 on the final shape, and its first attempt at each request is the only
one recorded (`--finalise` ignores any later line for an index already present).
