-- SPDX-License-Identifier: MIT
-- 0027_wallet_addresses_seal_descriptor: seal `wallet_addresses.descriptor`
--                                         with SecretBox (Phase 3 gate C-13,
--                                         docs/evidence/phase-3/
--                                         gate-security-review.md §4.1(c);
--                                         closed in
--                                         docs/evidence/phase-4/
--                                         wp4.12c-gate-conditions.md).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Why this is "low" and why it is sealed anyway
-- ---------------------------------------------------------------------------
--
-- 0016's own header argued `descriptor` is not a credential — an xpub or a
-- `0x...` address is public information a block explorer would show anyone —
-- and that argument is still correct as far as it goes. What it understates:
-- an xpub is the complete past *and future* transaction history of a wallet,
-- and a plaintext database dump or backup hands that over for every wallet
-- ever linked, forever, for the cost of nothing (the connector re-reads the
-- descriptor on every sync, so sealing it costs no read path a plaintext
-- column would have been cheaper for). The gate accepted the residual as
-- Low and named it anyway (G3-16/§4.1(c) item (i)); this migration is that
-- acceptance closed rather than carried.
--
-- ---------------------------------------------------------------------------
-- Expand only. Backfill and contract are separate releases.
-- ---------------------------------------------------------------------------
--
-- `docs/CONVENTIONS.md`'s own migration discipline: "add a nullable column,
-- backfill in a job, switch reads, switch writes, drop the old column later."
-- This migration is step one:
--
--   * `descriptor_sealed BYTEA` — a SecretBox storage envelope, nullable.
--     `apps/api/src/domain.ts`'s `WalletAddressStore` (the wallet descriptor
--     sealing binding; that same file's `WALLET_DESCRIPTOR_SEAL_REF` names
--     the AAD, since `@ctx/investments` does not depend on `@core/secretbox`
--     — see that file's own header for why the AAD policy lives there
--     rather than in the table's owning context) writes this column and
--     leaves `descriptor` NULL on every write it performs *once a
--     `SecretBox` is available to it*.
--   * `descriptor` becomes nullable rather than dropped: existing rows keep
--     their plaintext value exactly as it was, unsealed, until this store
--     next writes that row (a re-link, a scan-state repair that goes through
--     `put`, or any future backfill job). **No backfill job runs here or is
--     scheduled by this migration** — a plain SQL migration cannot call
--     `SecretBox` (it is application-layer cryptography, keyed by a KEK this
--     process does not hold at migration time), so an existing installation's
--     wallets remain plaintext at rest until the row is next written. This is
--     the backfill note the condition's own text asks for, not a backfill.
--   * The CHECK below only guarantees one representation is present, so a
--     row can never end up silently empty. It does not and cannot guarantee
--     which representation is the current one for any given row.
--
-- Contract (dropping `descriptor` once every row has been resealed) is a
-- later migration, in a later release, per the same discipline — and it also
-- depends on the composition root actually threading a `SecretBox` into
-- `createWalletRpcRuntime` at both call sites (`apps/api/src/app.ts`,
-- `apps/api/src/worker.ts`), which is **not done by this migration or by
-- `domain.ts`'s change alone** — see `docs/evidence/phase-4/
-- wp4.12c-gate-conditions.md` §1 "For the orchestrator".

ALTER TABLE wallet_addresses
  ADD COLUMN descriptor_sealed BYTEA;

ALTER TABLE wallet_addresses
  ALTER COLUMN descriptor DROP NOT NULL;

ALTER TABLE wallet_addresses
  ADD CONSTRAINT wallet_addresses_descriptor_has_a_representation CHECK (
    descriptor IS NOT NULL OR descriptor_sealed IS NOT NULL
  );

COMMENT ON COLUMN wallet_addresses.descriptor IS
  'Public: an xpub/ypub/zpub or a 0x address, in the clear. Legacy: present only on a row this store has not resealed yet (0027, C-13). NULL once descriptor_sealed carries the value.';

COMMENT ON COLUMN wallet_addresses.descriptor_sealed IS
  'SecretBox storage envelope over the same value descriptor used to carry in the clear (0027, C-13). AAD names (wallet_addresses, descriptor_sealed, id) — see apps/api/src/domain.ts''s WALLET_DESCRIPTOR_SEAL_REF. NULL until a SecretBox is threaded into the composition root and this row has been written since.';
