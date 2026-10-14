// SPDX-License-Identifier: MIT
/**
 * What the price refresh should price: every security the holder has a
 * position in today (WP 10.5).
 *
 * `@ctx/integrations`' refresh job deliberately does not query holdings — it
 * prices the `RefreshPlan` it is handed, and it may not read this context's
 * tables (08 §1.3 #11, and `personalfi/layer-imports` forbids the import). So
 * the plan is built by the composition root, and the composition root reads the
 * positions through this function rather than through its own SQL over
 * `holdings` and `securities`, which are this context's tables.
 *
 * ## "Current" means the `holdings` table, and non-zero means non-zero
 *
 * `holdings` holds one row per (account, security): the position as of the
 * last sync that reported it, replaced by each later one (WP 3.2). That is the
 * position today; `holdings_snapshots` is the history. A row whose quantity is
 * zero is a position that was closed — Plaid still reports a sold-out lot for a
 * while, and a sell can leave a zero row behind — and pricing it would spend a
 * provider request on something the holder does not own. A short position is
 * negative and still held, so the predicate is `<> 0`, not `> 0`.
 *
 * One entry per **security**, not per holding: a fund held in two accounts is
 * one request, not two. The currencies its positions are held in travel with
 * it, because the planner needs them for the FX pairs.
 *
 * The cost is one read. Nothing here is per-security.
 */
import { sql } from 'drizzle-orm';
import type { SecurityType } from '../schema/index.ts';
import type { InvestmentsExecutor } from './store.ts';

/** One security the holder has a non-zero position in, as the planner needs it. */
export interface PricingPosition {
  readonly securityId: string;
  /** `securities.type` — what `PROVIDER_FOR_KIND` routes on (D17). */
  readonly type: SecurityType;
  readonly name: string | null;
  readonly ticker: string | null;
  /** ISO-10383, when the security was established on a MIC-qualified ticker. */
  readonly mic: string | null;
  readonly figi: string | null;
  /** `chain_contract` securities only. `contract = 'native'` is a chain's own coin (WP 3.1). */
  readonly chain: string | null;
  readonly contract: string | null;
  /** The security's own quote currency, when a provider stated one. */
  readonly currency: string | null;
  /** The distinct currencies its non-zero positions are held in, sorted. */
  readonly positionCurrencies: readonly string[];
  /** How many accounts hold it. */
  readonly accounts: number;
}

interface PricingPositionRow extends Record<string, unknown> {
  security_id: string;
  type: SecurityType;
  name: string | null;
  ticker: string | null;
  mic: string | null;
  figi: string | null;
  chain: string | null;
  contract: string | null;
  currency: string | null;
  position_currencies: readonly string[] | string;
  accounts: number | string;
}

/**
 * Every security with a non-zero position, across every account the holder has.
 *
 * `user_id` is a predicate on **both** tables rather than trusted to ride the
 * join, the same rule `readHoldings` in the api states: a join predicate is not
 * an authorisation predicate.
 */
export async function readPricingPositions(
  db: InvestmentsExecutor,
  userId: string,
): Promise<readonly PricingPosition[]> {
  const result = await db.execute<PricingPositionRow>(sql`
    SELECT s.id                                  AS security_id,
           s.type,
           s.name,
           s.ticker,
           s.mic,
           s.figi,
           s.chain,
           s.contract,
           s.currency,
           array_agg(DISTINCT btrim(h.currency) ORDER BY btrim(h.currency)) AS position_currencies,
           count(DISTINCT h.account_id)          AS accounts
      FROM holdings h
      JOIN securities s
        ON s.id = h.security_id
       AND s.user_id = ${userId}::uuid
     WHERE h.user_id = ${userId}::uuid
       AND h.quantity <> 0
     GROUP BY s.id, s.type, s.name, s.ticker, s.mic, s.figi, s.chain, s.contract, s.currency
     ORDER BY s.ticker NULLS LAST, s.id
  `);
  return result.rows.map((row) => ({
    securityId: row.security_id,
    type: row.type,
    name: row.name,
    ticker: row.ticker,
    mic: row.mic,
    figi: row.figi,
    chain: row.chain,
    contract: row.contract,
    currency: row.currency === null ? null : row.currency.trim(),
    positionCurrencies: currenciesOf(row.position_currencies),
    accounts: Number(row.accounts),
  }));
}

/** `node-postgres` parses a `text[]` into an array; a `bpchar[]` can arrive as `{EUR,USD}`. */
function currenciesOf(value: readonly string[] | string): readonly string[] {
  const list =
    typeof value === 'string'
      ? value
          .replace(/^\{|\}$/gu, '')
          .split(',')
          .filter((entry) => entry.length > 0)
      : value;
  return list.map((entry) => entry.trim().toUpperCase());
}
