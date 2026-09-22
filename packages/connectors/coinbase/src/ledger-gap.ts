// SPDX-License-Identifier: MIT
/**
 * **R6, answered.** Deliverable one of WP 3.5, and the reason 3.5 is in Wave A.
 *
 * > R6 — "Coinbase v3 may not expose a full ledger (deposits/withdrawals/
 * > staking/transfers vs. trade fills only). Cost basis and crypto cash flows
 * > could be incomplete. **Prototype against a real Coinbase account early.**
 * > Highest-priority unknown in this memo." — 01, Open risks
 *
 * ## The determination, in one sentence
 *
 * Advanced Trade v3 reconstructs **trades and nothing else**: `/orders/historical/fills`
 * is a trading ledger, `/accounts` is a balance, and there is no endpoint in the
 * v3 brokerage surface that reports a deposit, a withdrawal, a staking reward or
 * an on-chain transfer. Those lived in the v2 `/transactions` Wallet API, which
 * 01 §3.1 records as deprecated in favour of v3 — deprecated with **no
 * replacement for its ledger half**, which is the part R6 suspected and this file
 * measures.
 *
 * ## Why this is a measurement and not an assertion
 *
 * `COINBASE_LEDGER_GAP` below is a table of claims. `probeLedgerGap` is what
 * makes them falsifiable: it calls all five endpoints, records what each
 * answered, and then does the arithmetic that settles the question —
 *
 * ```
 *   for each asset:  residual = balance(now) − Σ (fills that moved it)
 * ```
 *
 * A residual of zero on every asset would mean the fills *do* explain the whole
 * position and R6 was a false alarm. A non-zero residual is a quantity that
 * arrived by a route v3 does not describe, and the verdict follows from the
 * numbers rather than from this comment. Running the probe against the recorded
 * fixtures produces the table in the evidence doc; running it against a live
 * `can_view` key (the smoke test) produces the same shape for a real account.
 *
 * ## What it costs, and the plan of record
 *
 * Cost basis needs an acquisition event per lot: date, quantity, and either a
 * price paid or a fair market value at receipt (07 §6.2, §6.5). v3 supplies
 * that for a **purchase** and for nothing else. So:
 *
 *   * lots acquired by trade → `basis_source = BROKER`, exact;
 *   * lots acquired by transfer-in, staking, airdrop or fork → **no basis from
 *     this connector**, and 04 §5.5's rule applies: `unavailable`, never
 *     gain-from-zero.
 *
 * The fallback is the **Coinbase transaction-history CSV export**, which does
 * carry every one of those rows, and it is written down here as the plan of
 * record rather than left as a hope. §2.3's cut order already puts lot-level
 * crypto basis last; this is the finding that justifies that order.
 */
import { negatedDecimal, sumDecimals } from './amount.ts';
import type { CoinbaseAccount, CoinbaseApiLike, CoinbaseFill } from './api.ts';
import { isConnectorError } from '@connector/port';
import {
  assetCodeOf,
  baseEffectOf,
  isFiatAccount,
  productOf,
  quoteEffectOf,
  totalBalanceOf,
} from './map.ts';
import { COINBASE_MAX_FILLS_PAGE_SIZE, COINBASE_MAX_PAGES } from './provider.ts';

/** The five movements R6 named, plus the one the v0.5 rung cares about. */
export const LEDGER_MOVEMENTS = [
  'deposit',
  'withdrawal',
  'staking_reward',
  'internal_transfer',
  'fiat_on_ramp_buy',
] as const;

export type LedgerMovement = (typeof LEDGER_MOVEMENTS)[number];

/** How much of a movement v3 alone can rebuild. */
export const RECONSTRUCTIBILITY = ['yes', 'partial', 'no'] as const;

export type Reconstructibility = (typeof RECONSTRUCTIBILITY)[number];

export interface LedgerGapRow {
  readonly movement: LedgerMovement;
  /** The v3 endpoint that reports it, or `null` when none does. */
  readonly v3Endpoint: string | null;
  readonly reconstructible: Reconstructibility;
  readonly why: string;
  /** The row type in Coinbase's transaction-history CSV that *does* carry it. */
  readonly csvFallback: string;
  /** What its absence costs the cost-basis engine (WP 3.2). */
  readonly consequence: string;
}

/**
 * The determination. Five rows, one per movement, each falsifiable by the probe.
 *
 * `fiat_on_ramp_buy` is `partial` and it is the interesting row: the *trade* leg
 * is a fill and is exact, while the *funding* leg — the dollars arriving from a
 * bank — has no record at all. That asymmetry is precisely why this connector
 * infers the funding leg from a balance delta (`ledger.ts`) instead of pretending
 * the trade was the whole story. A connector that reported only the fill would
 * show a $5,000 purchase out of thin air; one that reported only the balance
 * change would show $5,000 of spending. Neither is the v0.5 rung.
 */
export const COINBASE_LEDGER_GAP: readonly LedgerGapRow[] = Object.freeze([
  {
    movement: 'deposit',
    v3Endpoint: null,
    reconstructible: 'no',
    why:
      'No v3 brokerage endpoint reports a fiat deposit. `/accounts` shows the resulting balance ' +
      'and `/orders/historical/fills` is trading only. The deposit existed in the v2 ' +
      '`/transactions` ledger, which 01 §3.1 records as deprecated in favour of v3.',
    csvFallback: 'Transaction history CSV, `Transaction Type = Deposit`',
    consequence:
      'Cash inflow is invisible, so an on-ramp would otherwise look like spending. This adapter ' +
      'infers it from the balance delta (ledger.ts) and labels it inferred.',
  },
  {
    movement: 'withdrawal',
    v3Endpoint: null,
    reconstructible: 'no',
    why: 'Same as deposit, in the other direction. `can_transfer` is refused, so we cannot even see the capability that would create one.',
    csvFallback: 'Transaction history CSV, `Transaction Type = Withdrawal`',
    consequence:
      'Cash outflow is invisible. Inferred from the balance delta as a transfer out, never as ' +
      'income and never as a disposal.',
  },
  {
    movement: 'staking_reward',
    v3Endpoint: null,
    reconstructible: 'no',
    why:
      'A staking reward increases a crypto balance with no fill behind it. v3 has no rewards ' +
      'endpoint; the quantity appears in `/accounts` and its receipt instant does not appear ' +
      'anywhere.',
    csvFallback: 'Transaction history CSV, `Transaction Type = Staking Income` / `Rewards Income`',
    consequence:
      'Rev. Rul. 2023-14 (07 §6.5) needs FMV **at receipt** to book ordinary income and to open a ' +
      'lot at that basis. Without a receipt timestamp there is no FMV to look up, so the lot is ' +
      'ESTIMATED with a visible warning — never a silent zero basis.',
  },
  {
    movement: 'internal_transfer',
    v3Endpoint: null,
    reconstructible: 'no',
    why:
      'An on-chain send or receive, and a move between portfolios, change a balance without a ' +
      'fill. v3 exposes portfolio movement only as `POST /portfolios/{uuid}/move_funds`, a write ' +
      'this connector may not call and which reports no history.',
    csvFallback: 'Transaction history CSV, `Transaction Type = Send` / `Receive`',
    consequence:
      'A self-transfer is not taxable but must carry its lots (07 §6.2). Without the event, the ' +
      'destination wallet sees an unexplained quantity and the source wallet an unexplained ' +
      'disposal. This is the single largest source of wrong crypto tax numbers.',
  },
  {
    movement: 'fiat_on_ramp_buy',
    v3Endpoint: '/api/v3/brokerage/orders/historical/fills',
    reconstructible: 'partial',
    why:
      'The trade leg is a fill and is exact — quantity, unit price, fee and instant. The funding ' +
      'leg is a deposit and has no record. A retail one-tap "buy with card" that never touched ' +
      'Advanced Trade produces no fill either, so even the trade leg is conditional on where the ' +
      'order was placed.',
    csvFallback: 'Transaction history CSV, `Transaction Type = Buy` (carries both legs on one row)',
    consequence:
      'Basis for an Advanced Trade purchase is exact. Basis for a retail buy is absent, and the ' +
      'balance-delta inference sees the two legs net to a smaller number than either.',
  },
]);

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export interface EndpointProbe {
  readonly endpoint: string;
  readonly outcome: 'answered' | 'refused';
  /** One line, counts only. No balance and no identifier reaches this string. */
  readonly summary: string;
  /** The `ConnectorError` condition when it refused. */
  readonly condition: string | null;
}

export interface AssetReconciliation {
  readonly asset: string;
  readonly kind: 'fiat' | 'crypto';
  /** The balance `/accounts` reports right now. */
  readonly observed: string;
  /** What the fills add up to, with this package's one sign convention. */
  readonly explainedByFills: string;
  /** `observed − explainedByFills`. Non-zero means v3 cannot account for it. */
  readonly residual: string;
  readonly explained: boolean;
}

export const LEDGER_GAP_VERDICTS = [
  'v3_alone_reconstructs_the_ledger',
  'v3_alone_cannot_reconstruct_the_ledger',
] as const;

export type LedgerGapVerdict = (typeof LEDGER_GAP_VERDICTS)[number];

export interface LedgerGapReport {
  readonly endpoints: readonly EndpointProbe[];
  readonly reconciliation: readonly AssetReconciliation[];
  readonly determination: readonly LedgerGapRow[];
  readonly verdict: LedgerGapVerdict;
  /** How many fills the probe considered, so a zero-fill account is not mistaken for agreement. */
  readonly fillCount: number;
}

/**
 * Try every endpoint, then do the arithmetic.
 *
 * Deliberately tolerant: an endpoint that refuses is *recorded* rather than
 * thrown, because "which of the five does a `can_view` key actually reach?" is
 * itself part of the finding, and a probe that aborted on the first 403 could
 * not answer it. The reconciliation still runs on whatever `/accounts` and
 * `/fills` returned; if either of those refused, the verdict is the pessimistic
 * one, because an unmeasured ledger is not a reconstructed one.
 */
export async function probeLedgerGap(api: CoinbaseApiLike): Promise<LedgerGapReport> {
  const endpoints: EndpointProbe[] = [];

  const permissions = await attempt(endpoints, 'key_permissions', async () => {
    const answer = await api.keyPermissions();
    return {
      value: answer,
      summary:
        `can_view=${String(answer.can_view ?? false)} can_trade=${String(answer.can_trade ?? false)} ` +
        `can_transfer=${String(answer.can_transfer ?? false)}`,
    };
  });

  const accounts = await attempt(endpoints, 'accounts', async () => {
    const page = await api.accounts({ cursor: null, limit: 250 });
    return { value: page.accounts, summary: `${page.accounts.length} wallet(s)` };
  });

  await attempt(endpoints, 'portfolios', async () => {
    const answer = await api.portfolios();
    return { value: answer, summary: `${answer.portfolios.length} portfolio(s)` };
  });

  const fills = await attempt(endpoints, 'orders/historical/fills', async () => {
    const collected: CoinbaseFill[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < COINBASE_MAX_PAGES; page += 1) {
      const answer: Awaited<ReturnType<CoinbaseApiLike['fills']>> = await api.fills({
        cursor,
        limit: COINBASE_MAX_FILLS_PAGE_SIZE,
        startSequenceTimestamp: null,
      });
      collected.push(...answer.fills);
      cursor = answer.cursor === undefined || answer.cursor === '' ? null : answer.cursor;
      if (cursor === null || answer.fills.length === 0) break;
    }
    return { value: collected, summary: `${collected.length} fill(s)` };
  });

  // The ticker is probed against the first crypto wallet there is, so the probe
  // reports whether pricing works at all without inventing a product id.
  const firstCrypto = (accounts ?? []).find((account) => !isFiatAccount(account));
  if (firstCrypto !== undefined) {
    await attempt(endpoints, 'products/{product_id}/ticker', async () => {
      const answer = await api.ticker(`${assetCodeOf(firstCrypto)}-USD`);
      return { value: answer, summary: `${answer.trades?.length ?? 0} recent trade(s)` };
    });
  }

  const reconciliation = reconcile(accounts ?? [], fills ?? []);
  const measured = accounts !== null && fills !== null;
  const everythingExplained = reconciliation.every((row) => row.explained);

  void permissions;
  return {
    endpoints,
    reconciliation,
    determination: COINBASE_LEDGER_GAP,
    verdict:
      measured && everythingExplained
        ? 'v3_alone_reconstructs_the_ledger'
        : 'v3_alone_cannot_reconstruct_the_ledger',
    fillCount: fills?.length ?? 0,
  };
}

/**
 * Per-asset arithmetic: what is there, versus what the trades explain.
 *
 * A fiat wallet is reconciled against the **quote** side of every fill and a
 * crypto wallet against the **base** side, using the same `quoteEffectOf` /
 * `baseEffectOf` the connector itself uses. Sharing those two functions is the
 * point: a probe with its own sign convention could reach a comfortable answer
 * the adapter does not agree with.
 */
export function reconcile(
  accounts: readonly CoinbaseAccount[],
  fills: readonly CoinbaseFill[],
): readonly AssetReconciliation[] {
  const rows: AssetReconciliation[] = [];
  for (const account of accounts) {
    const asset = assetCodeOf(account);
    const fiat = isFiatAccount(account);
    const effects = fills
      .filter((fill) => {
        const product = productOf(fill.product_id);
        return fiat ? product.quote === asset : product.base === asset;
      })
      .map((fill) => String(fiat ? quoteEffectOf(fill) : baseEffectOf(fill)));

    const explained = sumDecimals(effects, 'reconciliation.explained');
    const observed = totalBalanceOf(account);
    const residual = sumDecimals(
      [String(observed), negatedDecimal(String(explained), 'reconciliation.explained')],
      'reconciliation.residual',
    );
    rows.push({
      asset,
      kind: fiat ? 'fiat' : 'crypto',
      observed: String(observed),
      explainedByFills: String(explained),
      residual: String(residual),
      explained: String(residual) === '0',
    });
  }
  return rows;
}

/** Run one probe, record the outcome, and never let it fail the report. */
async function attempt<T>(
  into: EndpointProbe[],
  endpoint: string,
  run: () => Promise<{ value: T; summary: string }>,
): Promise<T | null> {
  try {
    const { value, summary } = await run();
    into.push({ endpoint, outcome: 'answered', summary, condition: null });
    return value;
  } catch (error) {
    into.push({
      endpoint,
      outcome: 'refused',
      summary: isConnectorError(error) ? `${error.kind}` : 'untyped failure',
      condition: isConnectorError(error) ? error.condition : null,
    });
    return null;
  }
}
