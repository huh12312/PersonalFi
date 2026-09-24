// SPDX-License-Identifier: MIT
/**
 * 08 §4.2's minimisation rules, checked on the data the rules actually run
 * against.
 *
 * The two named in the dispatch are the first two tests. Both are structural
 * rather than spot checks: `'holdings.aggregate emits no quantity, no cost
 * basis and no account id'` walks the **whole block** looking for a forbidden
 * key anywhere in it, so a field added three levels down in a year's time is
 * caught by the test that already exists rather than by one nobody wrote.
 *
 * The rest of the file is the other half of "minimised": that the *rules*
 * honour what the scopes carry — no raw identifier reaches a sentence, a stale
 * rate is never cited, and the FRED attribution rides with every figure that
 * came from FRED.
 */
import { describe, expect, it } from 'vitest';
import { wp310Catalogue } from '../src/advisors/catalogue.ts';
import { contextOf } from '../src/advisors/support.ts';
import { SCOPE_CATALOGUE, scopeDefinition } from '../src/contract/scopes.ts';
import { requestFor, seedSnapshot } from './advisors/seed.ts';
import { FRED_ATTRIBUTION, PORTFOLIO_SCOPE_KEYS } from './fixtures/portfolio.ts';

/** Every key name anywhere in a value, however deep. */
function keysOf(value: unknown, into: Set<string> = new Set()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      keysOf(child, into);
    }
  }
  return into;
}

describe('scope minimisation', () => {
  it('holdings.aggregate emits no quantity, no cost basis and no account id', async () => {
    const snapshot = await seedSnapshot('drift');
    const block = snapshot.holdings_aggregate;
    expect(block).toBeDefined();

    const keys = keysOf(block);
    // 08 §4.2 and the scope row: "Quantities, cost basis and account linkage —
    // those need `holdings.detail`". The match is on *substring*, so a
    // `quantity_remaining` or an `account_ref` added later is caught too.
    const forbidden = ['quantity', 'cost_basis', 'basis', 'account_id', 'account_ref', 'lot'];
    for (const key of keys) {
      for (const pattern of forbidden) {
        expect(
          key.includes(pattern),
          `holdings.aggregate must not carry '${key}' (matched '${pattern}')`,
        ).toBe(false);
      }
    }

    // And nothing that names an institution, a provider or a mask.
    for (const key of keys) {
      expect(/institution|provider|mask|iban|number/i.test(key), key).toBe(false);
    }

    // The scope row says the same thing in prose, and the two must agree.
    const definition = scopeDefinition('holdings.aggregate');
    expect(definition.drops).toContain('Quantities, cost basis and account linkage');
  });

  it('networth.summary is rounded to $100', async () => {
    const snapshot = await seedSnapshot('drift');
    const block = snapshot.networth_summary;
    expect(block).toBeDefined();
    if (block === undefined) return;

    // 08 §4.2: "rounded to $100". $100 is 10,000 minor units, and the scope
    // row is where the number lives — read from there rather than repeated, so
    // a change to the row moves this test with it.
    const rounding = BigInt(scopeDefinition('networth.summary').minimisation.roundMonetaryToMinor);
    expect(rounding).toBe(10_000n);

    const figures = [
      ['assets', block.assets.minor],
      ['liabilities', block.liabilities.minor],
      ['net_worth', block.net_worth.minor],
      ...block.trend.map((point) => [point.month, point.net_worth.minor] as const),
    ] as const;

    for (const [label, minor] of figures) {
      expect(BigInt(minor) % rounding, `${label} is not a whole hundred: ${minor}`).toBe(0n);
    }

    // The block carries no account, no institution and no provider either.
    for (const key of keysOf(block)) {
      expect(/account|institution|provider|mask/i.test(key), key).toBe(false);
    }
  });

  it('holdings.detail carries a lot age and never a lot date', async () => {
    const snapshot = await seedSnapshot('drift');
    const block = snapshot.holdings_detail;
    expect(block).toBeDefined();

    const keys = keysOf(block);
    expect(keys.has('oldest_lot_days')).toBe(true);
    expect(keys.has('opened_days')).toBe(true);
    // An open date is a timestamp of a decision; the age is what every rule
    // tests against and it fingerprints nothing.
    for (const key of keys) {
      expect(/open_date|opened_at|acquired|purchase_date/i.test(key), key).toBe(false);
      expect(/account_id|institution|provider|mask/i.test(key), key).toBe(false);
    }
  });

  it('liabilities.terms identifies a liability by a token and never by an account', async () => {
    const snapshot = await seedSnapshot('drift');
    const block = snapshot.liabilities_terms;
    expect(block).toBeDefined();
    if (block === undefined) return;

    for (const liability of block.liabilities) {
      // The same shape `cash_summary.accounts[].account_ref` uses: opaque,
      // stable within a snapshot, meaningless outside it.
      expect(liability.liability_ref).toMatch(/^LIAB_[0-9a-f]{12}$/);
    }
    for (const key of keysOf(block)) {
      expect(/account_id|institution|lender|provider|mask|card_number/i.test(key), key).toBe(false);
    }
  });

  it('a quantity crosses as a decimal string and never as a JSON number', async () => {
    const snapshot = await seedSnapshot('drift');
    for (const position of snapshot.holdings_detail?.positions ?? []) {
      // D3 is irreversible: portfolio math multiplies quantity by price and
      // then sums, and a float's error compounds where nobody looks.
      expect(typeof position.quantity, position.symbol).toBe('string');
      for (const lot of position.lots) expect(typeof lot.quantity).toBe('string');
    }
  });

  it('every new scope row states what it drops, and all five now have a reader', () => {
    // WP 3.10 shipped the portfolio four as `sourcedInPhase2: false` because
    // `#blockFor` had no branch for them. WP 3.10a landed the four arms and
    // flipped the four flags in the same change, so the assertion that was
    // "these four are unsourced" is now its opposite — and it is the same
    // claim either way: the flag states whether a reader exists *today*, and a
    // flag that disagreed with the builder would be the silent no-key this
    // whole line of tests exists to catch.
    for (const scope of Object.keys(PORTFOLIO_SCOPE_KEYS)) {
      const definition = SCOPE_CATALOGUE.find((row) => row.scope === scope);
      expect(definition, scope).toBeDefined();
      if (definition === undefined) continue;
      expect(definition.drops.length, scope).toBeGreaterThan(40);
      expect(definition.yields.length, scope).toBeGreaterThan(20);
      expect(definition.sourcedInPhase2, scope).toBe(true);
    }
  });

  it('the FRED attribution rides with every figure taken from FRED', async () => {
    const snapshot = await seedSnapshot('drift');
    expect(snapshot.market_rates?.attribution).toBe(FRED_ATTRIBUTION);

    // 01 §4.3 makes the sentence a licence condition. A rule that prints a
    // published rate is a surface that owes it, and the obligation travels
    // with the data precisely because a surface cannot render an obligation it
    // was never told about (WP 3.4 §4).
    let checked = 0;
    for (const entry of wp310Catalogue()) {
      if (!entry.rule.manifest.requires_scopes.includes('market.rates')) continue;
      for (const insight of entry.rule.evaluate(
        contextOf(requestFor(entry.rule.manifest, snapshot)),
      ).insights) {
        expect(
          insight.caveats,
          `${entry.ruleId} ${insight.key} shows a FRED rate without the attribution`,
        ).toContain(FRED_ATTRIBUTION);
        checked += 1;
      }
    }
    expect(checked, 'no rule exercised the attribution path').toBeGreaterThan(0);
  });

  it('no rule cites a stale rate', async () => {
    const snapshot = await seedSnapshot('drift');
    const rates = snapshot.market_rates?.rates ?? [];
    const staleIndexes = rates
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row.stale)
      .map((entry) => entry.index);
    expect(staleIndexes.length, 'the fixture must contain a stale rate to prove this').toBe(1);

    // A stale price still tells you roughly what you own. A stale *rate* used
    // as the benchmark in a comparison makes the whole comparison wrong by
    // however much rates moved, and the comparison is the entire insight.
    for (const entry of wp310Catalogue()) {
      for (const insight of entry.rule.evaluate(
        contextOf(requestFor(entry.rule.manifest, snapshot)),
      ).insights) {
        for (const row of insight.evidence) {
          for (const index of staleIndexes) {
            expect(
              row.source_ref ?? '',
              `${entry.ruleId} ${insight.key} cites a stale rate`,
            ).not.toContain(`market_rates.rates[${String(index)}]`);
          }
        }
      }
    }
  });
});
