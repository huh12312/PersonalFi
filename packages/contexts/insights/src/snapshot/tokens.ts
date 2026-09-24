// SPDX-License-Identifier: MIT
/**
 * Pseudonyms, and the digest of what we sent.
 *
 * ## `MERCHANT_<12 hex>` — keyed, stable, one-way
 *
 * 03 §8.3 and decision D22: a merchant crosses the advisor boundary as a
 * pseudonym, never as a name. Three properties are needed at once and they pull
 * against each other:
 *
 *   * **One-way.** `MERCHANT_a7f31c9d0e42` must not be reversible to "Netflix".
 *     A plain hash of the name would be: the space of merchant names is small
 *     enough to enumerate, so an unkeyed digest is a lookup table away from
 *     being the name itself. Hence HMAC with a per-account-holder key.
 *   * **Stable.** The same merchant must produce the same token on every run,
 *     or an advisor cannot say "this is the same vendor as last month" and the
 *     `(advisor_id, key, period)` upsert loses its meaning for every insight
 *     whose key mentions a vendor. Hence a key that is per *user*, not per run.
 *   * **Not stable across users.** Two account holders' snapshots must not share
 *     tokens, or an external advisor holding both learns that they shop at the
 *     same places. Hence the user id inside the key derivation, not beside it.
 *
 * Twelve hex characters is 48 bits. Collisions matter here only within one
 * user's merchant set — a few thousand at the extreme — where 48 bits leaves
 * the birthday probability around 1 in 10^8. A collision would merge two
 * vendors in one snapshot; it would not leak anything, because both sides are
 * already pseudonymous.
 *
 * ## Which refs are tokenised, and which are not
 *
 * | Ref | `builtin` / `local_model` | `external` |
 * | --- | --- | --- |
 * | merchant | token | token |
 * | liability | token | token |
 * | account, category, budget line, series, transaction | the uuid | token |
 *
 * Merchants are tokenised **always** — that is what D22 says and it is the one
 * identifier that is a third party's, not the user's. The rest cross as their
 * own uuids for an in-process advisor because the app is about to render a link
 * back to them and a token it would have to reverse is a token with a reversal
 * table. For an `external` advisor nothing is a uuid, because a uuid is a
 * durable handle into an account the advisor is not supposed to have one for.
 *
 * **`liability` is the second always-tokenised domain, and it is the scope row
 * that says so.** `liabilities.terms`' `drops` column (WP 3.10,
 * `contract/scopes.ts`) begins *"Account ids, provider ids, institution names,
 * card masks and the lender's name"* — `cash.summary`'s does not. A liability
 * is identified by the account it sits on, so `ref('account', id)` would put
 * that account id into a block whose reviewed policy row says it carries none,
 * for every in-process advisor. `LIAB_<12 hex>` is therefore minted for every
 * kind, which is also the shape `wp3.10-advisor-catalog-v2.md` §3 renders and
 * `test/scope-minimization.test.ts` asserts (`/^LIAB_[0-9a-f]{12}$/`).
 *
 * §7.1 asks that this share "one construction and one re-pseudonymisation cost"
 * with `account_ref`, and it does: it is the same keyed digest over
 * `{ key, domain, id }`, differing only in the domain — so the `@core/secretbox`
 * migration below moves both at once, and neither can drift from the other.
 *
 * `builder.ts` is the only caller, which is what keeps that table a table and
 * not an `if` in six places.
 *
 * ## Which hash, and the dependency note behind the choice
 *
 * `eslint.config.js` puts every primitive behind `@core/secretbox` — "the
 * failure this prevents is not a broken cipher, it is the second call site that
 * reuses a nonce, drops the AAD, or compares a tag with `===`" — so `node:crypto`
 * is not importable here. `scripts/eslint-boundaries.js` *does* list
 * `@core/secretbox` in this context's allow-list, but the package is not yet in
 * `@ctx/insights`'s `dependencies`, and adding one is the orchestrator's
 * dependency batch rather than this work package's (docs/CONVENTIONS.md; agents
 * never run `pnpm install`).
 *
 * What is available and is exactly the right shape is `@core/platform`'s
 * `configHash` — documented as SHA-256 over `canonicalJson`, and already the
 * hash `config_snapshots` is keyed on. Hashing `{ key, domain, id }` through a
 * canonical JSON encoding gives an unambiguous, length-delimited message, which
 * is the property a naive `key ‖ id` concatenation lacks: without it,
 * `key='ab', id='c'` and `key='a', id='bc'` would hash the same.
 *
 * That is a keyed hash rather than an HMAC, and the honest statement of the
 * difference is that a prefix-MAC over SHA-256 is length-extendable. Neither
 * half of that reaches this use: tokens are truncated to 48 bits so no full
 * internal state is ever published, and a token authenticates nothing — forging
 * one gains an attacker a string that resolves to no merchant. What the
 * construction *is* relied on for is one-wayness under an unknown key.
 *
 * **Carried for the orchestrator:** add `@core/secretbox` to this package's
 * dependencies in the next batch, and this becomes `sha256` directly. Note that
 * changing the *construction* would re-pseudonymise every merchant and orphan
 * every `MERCHANT_…` already stored in an evidence row — which is why it is
 * worth deciding before Phase 5 rather than after.
 *
 * ## `input_digest`
 *
 * `sha256:` over `canonicalJson(snapshot)` — the platform's own canonicaliser,
 * the one `config_snapshots` already hashes with, so key order and absent
 * properties are handled identically in both places. Stored on `advisor_runs`
 * and on every insight, which is what makes "show me exactly what we sent when
 * this was proposed" answerable a month later without keeping the payload.
 */
import { canonicalJson, configHash } from '@core/platform';

/** What a token stands for. Different domains never collide into each other. */
export type TokenDomain =
  | 'merchant'
  | 'account'
  | 'liability'
  | 'category'
  | 'budget_line'
  | 'series'
  | 'transaction'
  | 'institution';

const PREFIX: Record<TokenDomain, string> = {
  merchant: 'MERCHANT',
  account: 'ACCT',
  liability: 'LIAB',
  category: 'CAT',
  budget_line: 'LINE',
  series: 'SERIES',
  transaction: 'TXN',
  institution: 'INST',
};

/**
 * The domains that are a pseudonym for every advisor kind, not only `external`.
 *
 * A set rather than two `if`s, so "which refs never cross as a uuid?" has one
 * answer and adding a third is a one-line, reviewed diff in the file whose
 * header table already lists them.
 */
const ALWAYS_TOKENISED: ReadonlySet<TokenDomain> = new Set<TokenDomain>(['merchant', 'liability']);

/** Hex characters kept from the HMAC. 48 bits; see the header. */
const TOKEN_HEX = 12;

export interface Tokeniser {
  /** Always tokenised, for every advisor kind. D22. */
  merchant(id: string): string;
  /**
   * A uuid for an in-process advisor, a token for an external one — except for
   * the `ALWAYS_TOKENISED` domains, which are a token for both.
   */
  ref(domain: TokenDomain, id: string): string;
}

/**
 * The per-user token key, as 64 hex characters.
 *
 * The user id is *inside* the hash rather than beside the key, so two account
 * holders' keys differ by a full compression rather than by a prefix — which is
 * what stops an external advisor holding two users' snapshots from learning
 * that they shop at the same places. The label pins the purpose: the same
 * deployment secret used for anything else in this application produces an
 * unrelated key.
 */
export function deriveTokenKey(secret: string, userId: string): string {
  return configHash({ label: 'personalfi/v1|advisor-tokens', userId, secret });
}

export interface TokeniserOptions {
  /** From `deriveTokenKey`. Never the raw deployment secret. */
  readonly key: string;
  /** `true` ⇒ every ref is a token. `false` ⇒ only merchants are. */
  readonly tokeniseEverything: boolean;
}

export function createTokeniser(options: TokeniserOptions): Tokeniser {
  const token = (domain: TokenDomain, id: string): string => {
    const digest = configHash({
      label: 'personalfi/v1|advisor-token',
      key: options.key,
      domain,
      id,
    });
    return `${PREFIX[domain]}_${digest.slice(0, TOKEN_HEX)}`;
  };
  return {
    merchant(id) {
      return token('merchant', id);
    },
    ref(domain, id) {
      if (ALWAYS_TOKENISED.has(domain)) return token(domain, id);
      return options.tokeniseEverything ? token(domain, id) : id;
    },
  };
}

/**
 * `sha256:<64 hex>` over the canonical JSON of whatever we are about to send.
 *
 * `canonicalJson` is named here as well as used, because the digest's whole
 * value is that it is reproducible: the snapshot itself is never stored, so
 * "show me what we sent" is answered by rebuilding it and re-hashing, and that
 * only works if the canonicaliser is pinned rather than incidental.
 */
export function inputDigest(value: unknown): string {
  return `sha256:${configHash({ canonical: canonicalJson(value) })}`;
}
