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
import { SCOPE_CATALOGUE, scopeDefinition, type AdvisorScope } from '../src/contract/scopes.ts';
import { SnapshotBuilder } from '../src/snapshot/builder.ts';
import { emptyPorts, inMemoryPlanningPort } from '../src/snapshot/ports.ts';
import { deriveTokenKey } from '../src/snapshot/tokens.ts';
import { DateOnly, Money } from '@core/kernel';
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

/** Every primitive value anywhere in a value, however deep. */
function leavesOf(value: unknown, into: unknown[] = []): readonly unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) leavesOf(item, into);
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) leavesOf(child, into);
    return into;
  }
  into.push(value);
  return into;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
/** A month or a day: `2026-09`, `2026-09-19`. A bare year is what may cross. */
const DATE_FINER_THAN_A_YEAR = /\d{4}-\d{2}/u;

describe('scope minimisation — the planning scopes (WP 4.9)', () => {
  it('plan.projection emits no balance, no account id and no date finer than a year', async () => {
    const snapshot = await seedSnapshot('drift');
    const block = snapshot.plan_projection;
    expect(block).toBeDefined();
    if (block === undefined) return;

    // Keys: the dispatch's three exclusions, by substring, anywhere in the block,
    // plus the two that would be income and spending by another name.
    for (const key of keysOf(block)) {
      expect(
        /balance|account|institution|provider|mask|scenario|run_id|birth|date|income|spend/iu.test(
          key,
        ),
        `plan.projection must not carry '${key}'`,
      ).toBe(false);
    }
    // Values: no identifier and no date finer than a year.
    for (const leaf of leavesOf(block)) {
      if (typeof leaf !== 'string') continue;
      expect(UUID.test(leaf), leaf).toBe(false);
      expect(DATE_FINER_THAN_A_YEAR.test(leaf), leaf).toBe(false);
    }
    // The only money in the block is the projected band, rounded to $1,000 by
    // the scope row — read from the row, so the test moves with it.
    const rounding = BigInt(scopeDefinition('plan.projection').minimisation.roundMonetaryToMinor);
    expect(rounding).toBe(100_000n);
    for (const band of [block.terminal.p5, block.terminal.p50, block.terminal.p95]) {
      if (band === null) continue;
      expect(BigInt(band.minor) % rounding, band.minor).toBe(0n);
    }
    // Every ratio is a decimal string — a success probability is never a JSON number.
    expect(typeof block.success_probability).toBe('string');
    expect(typeof block.success_target).toBe('string');
    for (const leaf of [
      block.guardrail?.withdrawal_rate,
      block.rmd?.tax_deferred_share,
      block.social_security?.claim_factor,
    ]) {
      expect(typeof leaf).toBe('string');
    }
    // Ages and years are whole numbers; nothing else numeric crosses except the
    // path count.
    expect(Number.isInteger(block.ages.current)).toBe(true);
    expect(Number.isInteger(block.as_of_year)).toBe(true);
  });

  it('goals.list and risk.profile carry no id, no account and no date — for every kind', async () => {
    const goalId = '01930000-0000-7000-8000-00000000900d';
    const fundingAccount = '01930000-0000-7000-8000-0000000000a1';
    const ports = {
      ...emptyPorts(),
      planning: inMemoryPlanningPort({
        goals: [
          {
            id: goalId,
            name: 'House deposit',
            target: Money.of(2_000_000n, 'USD'),
            monthsRemaining: 12,
            fundedRatio: '0.1',
            status: 'off_track',
            requiredMonthly: Money.of(150_000n, 'USD'),
            plannedMonthly: Money.of(50_000n, 'USD'),
          },
        ],
        riskProfile: {
          tolerance: 'moderate',
          horizonYears: 20,
          taxBracketBand: '22-24',
          liquidityNeed: 'medium',
        },
      }),
    };
    const refs = new Set<string>();
    for (const kind of ['builtin', 'local_model', 'external'] as const) {
      const built = await new SnapshotBuilder(ports).build({
        userId: '01930000-0000-7000-8000-0000000000ee',
        kind,
        grantedScopes: ['goals.list', 'risk.profile'] as AdvisorScope[],
        today: DateOnly.parse('2026-09-19'),
        baseCurrency: 'USD',
        tokenKey: deriveTokenKey('wp-4-9-minimisation', '01930000-0000-7000-8000-0000000000ee'),
      });
      const text = JSON.stringify(built.snapshot);
      // The goal's id never crosses — not for a built-in either. "No ids cross."
      expect(text, kind).not.toContain(goalId);
      expect(text, kind).not.toContain(fundingAccount);
      expect(UUID.test(text), kind).toBe(false);
      const goal = built.snapshot.goals_list?.goals[0];
      expect(goal?.goal_ref, kind).toMatch(/^GOAL_[0-9a-f]{12}$/u);
      refs.add(goal?.goal_ref ?? '');

      for (const key of keysOf(built.snapshot)) {
        expect(
          /account|funded_from|earmark|date|note|answers|penalty|income|score/iu.test(key),
          `${kind} carries '${key}'`,
        ).toBe(false);
      }
      for (const leaf of leavesOf(built.snapshot)) {
        if (typeof leaf === 'string') expect(DATE_FINER_THAN_A_YEAR.test(leaf), leaf).toBe(false);
      }
    }
    // One pseudonym for all three kinds: stable, so an insight key is stable,
    // and never the id, so no kind learns it.
    expect(refs.size).toBe(1);
  });

  it('a risk profile with no band is absent, never given one', async () => {
    const ports = {
      ...emptyPorts(),
      planning: inMemoryPlanningPort({
        riskProfile: {
          tolerance: 'moderate',
          horizonYears: 20,
          taxBracketBand: null,
          liquidityNeed: 'medium',
        },
      }),
    };
    const built = await new SnapshotBuilder(ports).build({
      userId: '01930000-0000-7000-8000-0000000000ee',
      kind: 'builtin',
      grantedScopes: ['risk.profile'] as AdvisorScope[],
      today: DateOnly.parse('2026-09-19'),
      baseCurrency: 'USD',
      tokenKey: deriveTokenKey('wp-4-9-minimisation', '01930000-0000-7000-8000-0000000000ee'),
    });
    // WP 4.1's note for this arm: declined income means no band, and the
    // contract's band is required — so no block, rather than an invented band.
    expect(built.snapshot.risk_profile).toBeUndefined();
    expect(built.emittedScopes).toEqual([]);
  });

  it('the three planning scope rows state what they drop, and all three have a reader', () => {
    for (const scope of ['goals.list', 'risk.profile', 'plan.projection'] as const) {
      const definition = scopeDefinition(scope);
      expect(definition.drops.length, scope).toBeGreaterThan(40);
      expect(definition.sourcedInPhase2, scope).toBe(true);
    }
    expect(scopeDefinition('plan.projection').drops).toMatch(/no date finer than a/u);
  });
});
