// SPDX-License-Identifier: MIT
/**
 * The cursor this adapter issues, which is **ours and not Coinbase's**.
 *
 * ## Why an adapter is minting its own cursor at all
 *
 * The port's cursor contract assumes a provider delta stream — Plaid's
 * `/transactions/sync` — and Advanced Trade v3 has none for cash movements. It
 * has no cash-movement endpoint at all: that is the R6 finding (`ledger-gap.ts`).
 * What it *does* have is a balance, right now, per wallet.
 *
 * So the only honest delta is the one between two of our own observations, and
 * the cursor is the earlier observation: a **watermark**. `ledger.ts` subtracts
 * the trades that happened in between and reports the residual as the cash
 * movement v3 will not tell us about. That residual is the fiat on-ramp, and it
 * is the whole reason `syncTransactions` returns anything.
 *
 * ## What that costs, stated plainly
 *
 * **The first sync emits nothing.** A watermark cannot describe money that
 * arrived before we started watching, and inventing a deposit for the opening
 * balance would put a five-figure phantom transfer in the ledger on day one.
 * This is also why `capabilities()` does not declare `historical_backfill`: the
 * flag would tell the orchestrator to ask for 730 days of a ledger that does not
 * exist. The CSV export is the documented way to get that history, and
 * `ledger-gap.ts` says so as the plan of record rather than as a hope.
 *
 * ## The encoding is boring on purpose
 *
 * `cb1.` plus base64url of a JSON object with **sorted keys**. Sorted because
 * the conformance suite requires that a sync past the end returns *exactly* the
 * cursor it was given, and an object whose key order depends on insertion order
 * would fail that by one byte the day a wallet is added.
 *
 * Nothing secret is in it. It carries wallet uuids and fiat balances, which the
 * orchestrator already stores in `sync_state` next to the accounts themselves —
 * but it carries no key name, no token and no JWT, and `log-hygiene.test.ts`
 * asserts that by scanning the cursor along with everything else.
 */
import { ConnectorError, cursorOf, type Cursor } from '@connector/port';

export const COINBASE_CURSOR_PREFIX = 'cb1.';

export interface CoinbaseWatermark {
  /** The instant these balances were observed, as an ISO-8601 UTC string. */
  readonly at: string;
  /** Fiat wallet uuid → total balance, as a decimal string, at `at`. */
  readonly fiat: Readonly<Record<string, string>>;
}

/**
 * Encode a watermark as an opaque cursor.
 *
 * The uuid keys are sorted and the two top-level fields are written in a fixed
 * order, so the same observation always produces the same bytes.
 */
export function encodeWatermark(watermark: CoinbaseWatermark): Cursor {
  const fiat: Record<string, string> = {};
  for (const uuid of Object.keys(watermark.fiat).sort()) {
    fiat[uuid] = watermark.fiat[uuid] ?? '0';
  }
  const json = JSON.stringify({ at: watermark.at, fiat });
  return cursorOf(`${COINBASE_CURSOR_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`);
}

/**
 * Decode a cursor the orchestrator handed back.
 *
 * Anything this adapter did not issue is `CURSOR_EXPIRED`, whose default
 * `restart` is `from_null` — a full re-observation, healed by the idempotent
 * upsert, never by deleting data (the port's cursor-contract rule 4). That is
 * also the right answer for a cursor written by an *older* encoding: refusing to
 * guess is what stops a format change silently producing a phantom transfer for
 * the whole balance.
 */
export function decodeWatermark(cursor: Cursor | string): CoinbaseWatermark {
  const text = String(cursor);
  if (!text.startsWith(COINBASE_CURSOR_PREFIX)) throw expired('prefix');
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(text.slice(COINBASE_CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    );
  } catch {
    throw expired('encoding');
  }
  if (typeof parsed !== 'object' || parsed === null) throw expired('shape');
  const record = parsed as Record<string, unknown>;
  const at = record['at'];
  const fiat = record['fiat'];
  if (typeof at !== 'string' || Number.isNaN(new Date(at).getTime())) throw expired('at');
  if (typeof fiat !== 'object' || fiat === null || Array.isArray(fiat)) throw expired('fiat');

  const balances: Record<string, string> = {};
  for (const [uuid, value] of Object.entries(fiat as Record<string, unknown>)) {
    if (typeof value !== 'string') throw expired('balance');
    balances[uuid] = value;
  }
  return { at, fiat: balances };
}

/**
 * `CURSOR_EXPIRED`, with the *reason* and nothing else.
 *
 * The cursor itself is deliberately not in the context. It is not a secret, but
 * it is a record of the user's balances, and `sync_runs.last_error` is rendered
 * in the UI and copied into bug reports.
 */
function expired(reason: string): ConnectorError {
  return ConnectorError.fromCondition(
    'CURSOR_EXPIRED',
    'this cursor was not issued by the coinbase adapter, or was issued by an older encoding',
    { redactedContext: { reason }, restart: 'from_null' },
  );
}
