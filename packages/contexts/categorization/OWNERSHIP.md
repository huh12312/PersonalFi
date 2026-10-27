# `@ctx/categorization` — table ownership

Categorization & Rules.

The taxonomy, the rules engine, merchant normalisation, and the classifier. Decides a
category for every transaction through one pure function with six ordered tiers, and
records which tier decided, how sure it was, and what every other tier said.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

## Depends on

- Platform
- Ledger (by event and by read model only — never by import, never by SQL)

## Tables

Everything migration `0006_categorization.sql` creates is claimed here, in the order
the migration creates it.

### Built (migration 0006)

- `categories`
- `provider_category_map`
- `mcc_codes`
- `merchant_profiles`
- `rules`
- `rule_runs`
- `category_assignments`
- `classifier_examples`
- `classifier_versions`

### Built (migration 0053, WP 11.1)

- `category_abstentions`

## Notes on the names

Four claims from the original sketch are gone, because the built schema answers the
same need with fewer tables and leaving a stale claim here would reserve a name
nobody intends to use:

- `category_groups` → **`categories.parent_id`**. A group _is_ a top-level category;
  a separate table would mean two things to rename, two things to reorder, and a join
  on every picker. The two-level limit is a `CHECK`, not a second table.
- `rule_conditions`, `rule_actions` → **`rules.conditions` / `rules.actions` (jsonb)**.
  A rule is read whole and written whole. There is no query that wants "rules whose
  third condition mentions an amount", so normalising would buy a three-way join on
  the sync path plus a window in which an edit leaves half a rule behind. The safety
  a relational shape would have bought is bought instead by `conditionsSchema` and
  `actionsSchema` (`src/rules/schema.ts`), validated on write _and_ on read — which
  is strictly stronger, since they reject an amount range whose minimum exceeds its
  maximum and no `CHECK` split across two child tables would catch that.
- `merchant_aliases` → **`merchant_profiles.descriptor_patterns` (jsonb)**. The alias
  corpus is a property of one merchant and is only ever read alongside it.
- `categorization_feedback` → **`category_assignments.confirmed_at` plus the retained
  history**. Feedback is not a separate fact: it is a user confirming or replacing a
  decision this table already holds. A second table would have meant two places to
  look for "what did the user actually say", and they would drift.

Two names are new since the sketch:

- `merchant_profiles` is this context's half of the merchant record. `@ctx/ledger`
  owns `merchants` (identity, normalised key, display name) and its header asks this
  context to "extend this table by migration rather than owning a second one". A side
  table keyed on `merchants.id` is the only form of that extension the ownership check
  permits: a migration in this package adding a column to a table `@ctx/ledger` owns is
  precisely the reach-around the check exists to stop.
- `rule_runs` exists because "that rule changed 900 transactions last Tuesday" is
  unanswerable after the fact unless it was recorded at the time, and because a
  preview count that disagrees with the later apply count is a signal worth seeing.

## What this context does **not** own

- `merchants`, `transactions`, `transaction_splits` — `@ctx/ledger`. Read through its
  published read models; never joined to in SQL written here.
- `transactions.user_category_id` — `@ctx/ledger`'s overlay column, holding one of our
  `categories.id` values opaquely. It is tier 1 of the decision order and this context
  only ever _reads_ it; the ledger's `setTransactionOverlay` is what writes it.

`category_assignments.transaction_id`, `merchant_profiles.ledger_merchant_id` and
`rules.created_from_transaction_id` all point into `@ctx/ledger` and none of them is a
`REFERENCES` clause — the same call `@ctx/ledger` made in the other direction, and for
the same reason (decision D8).
