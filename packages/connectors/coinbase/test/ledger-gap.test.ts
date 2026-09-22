// SPDX-License-Identifier: MIT
/**
 * **Deliverable one: the R6 ledger-gap prototype.**
 *
 * WP 3.5's scope opens with it — "*Deliverable one is the R6 ledger-gap
 * prototype, reported to the orchestrator before any connector code is written:
 * does Advanced Trade v3 alone reconstruct a cost-basis-capable ledger, or do
 * deposits, withdrawals and staking rewards exist only in the deprecated v2
 * `/transactions`?*" — and Wave A's note says why the answer has to arrive
 * early: if v3 has the gap, "WP 3.2's lot engine has one fewer source to
 * satisfy", and that is a scope change 3.2 must have *before* it starts.
 *
 * This file is the prototype, run hermetically against recorded shapes. The
 * live half is `smoke.test.ts`, which runs the identical probe against a real
 * `can_view` key and skips honestly when there is none.
 */
import { describe, expect, it } from 'vitest';
import { probeLedgerGap, COINBASE_LEDGER_GAP, LEDGER_MOVEMENTS } from '../src/ledger-gap.ts';
import { CoinbaseClient } from '../src/client.ts';
import { clientHarness } from './harness.ts';

function probe(): ReturnType<typeof probeLedgerGap> {
  const { client } = clientHarness();
  return probeLedgerGap(client);
}

describe('R6: what Advanced Trade v3 alone can reconstruct', () => {
  it('reaches all five read-only endpoints with a can_view key', async () => {
    const report = await probe();
    expect(report.endpoints.map((entry) => entry.endpoint)).toEqual([
      'key_permissions',
      'accounts',
      'portfolios',
      'orders/historical/fills',
      'products/{product_id}/ticker',
    ]);
    for (const entry of report.endpoints) {
      expect(entry.outcome, `${entry.endpoint} was refused`).toBe('answered');
    }
    // The summaries are the "what did each one return" column of the evidence
    // table, and they carry counts rather than balances on purpose.
    expect(report.endpoints[0]?.summary).toBe('can_view=true can_trade=false can_transfer=false');
    expect(report.endpoints[1]?.summary).toBe('4 wallet(s)');
    expect(report.endpoints[3]?.summary).toBe('2 fill(s)');
  });

  /**
   * The measurement that settles R6.
   *
   * If the fills explained the balances, every residual would be zero and the
   * risk would be a false alarm. They do not, and the residuals are exactly the
   * movements v3 has no endpoint for.
   */
  it('leaves a residual on every asset that fills cannot explain', async () => {
    const report = await probe();
    const byAsset = new Map(report.reconciliation.map((row) => [row.asset, row]));

    // 980.00 observed − (−9,032.50 spent on two buys) = 10,012.50 of deposits
    // that v3 never reported.
    expect(byAsset.get('USD')).toMatchObject({
      kind: 'fiat',
      observed: '980',
      explainedByFills: '-9032.5',
      residual: '10012.5',
      explained: false,
    });
    // 0.35 held, 0.10 bought: 0.25 arrived some other way — a transfer in.
    expect(byAsset.get('BTC')).toMatchObject({
      kind: 'crypto',
      observed: '0.35',
      explainedByFills: '0.1',
      residual: '0.25',
      explained: false,
    });
    // 2.05 held, 2.00 bought: 0.05 of staking rewards, with no receipt instant
    // and therefore no FMV to book income at (07 §6.5).
    expect(byAsset.get('ETH')).toMatchObject({
      kind: 'crypto',
      observed: '2.05',
      explainedByFills: '2',
      residual: '0.05',
      explained: false,
    });
    // An empty wallet reconciles trivially, which is the control: the method
    // does not simply always disagree.
    expect(byAsset.get('DOGE')).toMatchObject({ residual: '0', explained: true });
  });

  it('returns the pessimistic verdict, because an unexplained quantity is an unreconstructed ledger', async () => {
    const report = await probe();
    expect(report.verdict).toBe('v3_alone_cannot_reconstruct_the_ledger');
    expect(report.fillCount).toBe(2);
  });

  it('names every movement, how far v3 gets and what the CSV fallback carries', async () => {
    const report = await probe();
    expect(report.determination.map((row) => row.movement)).toEqual([...LEDGER_MOVEMENTS]);

    const byMovement = new Map(COINBASE_LEDGER_GAP.map((row) => [row.movement, row]));
    expect(byMovement.get('deposit')?.reconstructible).toBe('no');
    expect(byMovement.get('withdrawal')?.reconstructible).toBe('no');
    expect(byMovement.get('staking_reward')?.reconstructible).toBe('no');
    expect(byMovement.get('internal_transfer')?.reconstructible).toBe('no');
    // The only one v3 gets anywhere with, and only half of it: the trade leg is
    // exact and the funding leg does not exist.
    expect(byMovement.get('fiat_on_ramp_buy')).toMatchObject({
      reconstructible: 'partial',
      v3Endpoint: '/api/v3/brokerage/orders/historical/fills',
    });

    // Every row has to name a fallback. "We cannot do this" without "and here
    // is what can" is a finding that leaves 3.2 with nothing to plan against.
    for (const row of COINBASE_LEDGER_GAP) {
      expect(row.csvFallback, `${row.movement} names no CSV fallback`).toMatch(/CSV/);
      expect(row.consequence.length).toBeGreaterThan(40);
    }
  });

  /**
   * The probe must survive a refusal, because *which* endpoints a key reaches is
   * part of the finding. A probe that threw on the first 403 could not report it.
   */
  it('records a refused endpoint instead of abandoning the report', async () => {
    const { client } = clientHarness({
      failures: {
        portfolios: { status: 403, body: { error: 'PERMISSION_DENIED', message: 'nope' } },
      },
    });
    const report = await probeLedgerGap(client);
    const portfolios = report.endpoints.find((entry) => entry.endpoint === 'portfolios');
    expect(portfolios).toMatchObject({ outcome: 'refused', condition: 'INSUFFICIENT_SCOPE' });
    // The rest of the probe still ran.
    expect(report.reconciliation.length).toBe(4);
  });

  /**
   * And it must not reach the comfortable answer when it measured nothing: a key
   * that cannot read `/accounts` has not proved v3 sufficient, it has proved
   * nothing.
   */
  it('does not report success when it could not measure', async () => {
    const { client } = clientHarness({
      failures: {
        accounts: { status: 403, body: { error: 'PERMISSION_DENIED', message: 'nope' } },
      },
    });
    const report = await probeLedgerGap(client);
    expect(report.reconciliation).toEqual([]);
    expect(report.verdict).toBe('v3_alone_cannot_reconstruct_the_ledger');
  });

  it('is the same probe the live smoke runs, over the same CoinbaseClient', () => {
    // A prototype that only exists against fixtures is a belief, not a finding.
    // `probeLedgerGap` takes the `CoinbaseApiLike` that `CoinbaseClient`
    // implements, so the hermetic run and the live run differ only in the
    // transport underneath.
    const { client } = clientHarness();
    expect(client).toBeInstanceOf(CoinbaseClient);
    expect(typeof client.keyPermissions).toBe('function');
    expect(typeof client.fills).toBe('function');
  });
});
