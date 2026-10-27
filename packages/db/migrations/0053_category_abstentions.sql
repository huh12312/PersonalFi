-- SPDX-License-Identifier: MIT
-- 0053_category_abstentions: the stored working behind "uncategorised"
--                            (WP 11.1; the Inbox's one-line "why").
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only: one new @ctx/categorization table and one index. Nothing is
-- altered, dropped or narrowed, and no existing row is touched. References
-- only `users` (0002).
--
-- When every tier abstains on a transaction that has no assignment yet,
-- `category_assignments` records nothing -- "we don't know" as the first thing
-- ever said about a transaction buys a row there and says nothing, and 0006's
-- source CHECK has no 'none'. That left the residue -- exactly the rows the
-- Inbox shows and WP 11.2 will suggest for -- with no stored working at all, so
-- "why is this uncategorised?" could only be answered by re-deciding today,
-- which answers a different question (0006's own note on `evidence`). This
-- table holds that working: the full `decide()` chain, as data, one row per
-- transaction, rewritten only when the chain changes and deleted the moment an
-- assignment is written. `transaction_id` points into @ctx/ledger and is not a
-- REFERENCES clause, for 0006's reason (decision D8).

CREATE TABLE category_abstentions (
  id             UUID         PRIMARY KEY,
  user_id        UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  transaction_id UUID         NOT NULL,
  -- `{ "chain": [ ...TierOutcome ] }`, the shape category_assignments.evidence has.
  evidence       JSONB        NOT NULL
                              CONSTRAINT category_abstentions_evidence_has_chain
                              CHECK (jsonb_typeof(evidence -> 'chain') = 'array'),
  -- When this working was first recorded; unchanged by a re-run that reaches the same chain.
  decided_at     TIMESTAMPTZ  NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX category_abstentions_transaction_idx
  ON category_abstentions (user_id, transaction_id);
