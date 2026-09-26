// SPDX-License-Identifier: MIT
/**
 * WP 4.1 exit tests for the risk questionnaire.
 *
 *   * `'two framings of the same question disagree and the score moves
 *     conservative, not to the mean'` — 02 §3's consistency penalty. A
 *     questionnaire that averages an inconsistency launders it.
 *   * `'the consistency penalty is stored and the score is re-derivable from
 *     the stored answers alone'` — `tolerance` is derived, never typed in, and
 *     the derivation reads nothing but the stored document.
 *   * `'tax_bracket_band is a band and the exact income never reaches the
 *     row'` — 08 §4.2: the bracket crosses as a band, never a figure.
 *
 * The bracket schedule below is a **test fixture**, not a source: 07 Appendix
 * A's 2026 single-filer thresholds (Rev. Proc. 2025-32), cited, so the band
 * boundaries can be asserted at the exact income that crosses each one. The
 * production schedule is WP 4.2's (`packages/contexts/planning/data/`), and
 * `taxBracketBand` takes it as an argument precisely so no threshold is
 * inlined in `src/`.
 */
import { Money } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PlanningError } from '../src/errors.ts';
import {
  RISK_DISPOSITIONS,
  RISK_INSTRUMENT,
  RISK_INSTRUMENT_VERSION,
  buildRiskProfileRecord,
  deriveTolerance,
  taxBracketBand,
  toleranceFor,
  type BracketSchedule,
  type RiskAnswers,
  type RiskItemId,
} from '../src/risk-profile.ts';

const usd = (dollars: string): Money => Money.parseAmount(dollars, 'USD');

/** 07 Appendix A, "Income tax (Rev. Proc. 2025-32)", Brackets (single). */
const US_2026_SINGLE: BracketSchedule = {
  taxYear: 2026,
  filingStatus: 'single',
  brackets: [
    { rate: '0.10', over: usd('0') },
    { rate: '0.12', over: usd('12400') },
    { rate: '0.22', over: usd('50400') },
    { rate: '0.24', over: usd('105700') },
    { rate: '0.32', over: usd('201775') },
    { rate: '0.35', over: usd('256225') },
    { rate: '0.37', over: usd('640600') },
  ],
  source: 'Rev. Proc. 2025-32 via docs/research/07-advisory-domain.md Appendix A',
  asOf: '2026-01-01',
};

/** The option id worth `points` on an item (the first one, if several share it). */
function optionWorth(itemId: RiskItemId, points: number | null): string {
  const item = RISK_INSTRUMENT.find((candidate) => candidate.id === itemId);
  const found = item?.options.find((candidate) => candidate.points === points);
  if (found === undefined) throw new Error(`${itemId} has no option worth ${String(points)}`);
  return found.id;
}

type Pair = readonly [stated: number, revealed: number | null];

/** Build an answers document from (stated, revealed) points per disposition. */
function answersOf(pairs: Readonly<Record<(typeof RISK_DISPOSITIONS)[number], Pair>>): RiskAnswers {
  const items = {} as Record<RiskItemId, string>;
  for (const disposition of RISK_DISPOSITIONS) {
    const [stated, revealed] = pairs[disposition];
    items[`${disposition}.stated`] = optionWorth(`${disposition}.stated`, stated);
    items[`${disposition}.revealed`] = optionWorth(`${disposition}.revealed`, revealed);
  }
  return { instrument: RISK_INSTRUMENT_VERSION, items };
}

const pointsArbitrary = fc.integer({ min: 1, max: 5 });
const revealedArbitrary = fc.option(fc.integer({ min: 1, max: 5 }), { nil: null });
const answersArbitrary = fc
  .tuple(
    fc.tuple(pointsArbitrary, revealedArbitrary),
    fc.tuple(pointsArbitrary, revealedArbitrary),
    fc.tuple(pointsArbitrary, revealedArbitrary),
  )
  .map(([drawdown, volatility, identity]) =>
    answersOf({ drawdown, volatility, risk_identity: identity }),
  );

const ANSWERED_AT = new Date('2026-09-26T15:00:00Z');

describe('the risk questionnaire', () => {
  it('every disposition is asked in a stated and a revealed framing', () => {
    for (const disposition of RISK_DISPOSITIONS) {
      const framings = RISK_INSTRUMENT.filter((item) => item.disposition === disposition).map(
        (item) => item.framing,
      );
      expect(framings.sort()).toEqual(['revealed', 'stated']);
    }
    // Points 1..5 are each offered exactly once per item; only a revealed
    // framing may offer "no evidence".
    for (const item of RISK_INSTRUMENT) {
      const points = item.options.map((option) => option.points).filter((p) => p !== null);
      expect([...points].sort()).toEqual([1, 2, 3, 4, 5]);
      const noEvidence = item.options.filter((option) => option.points === null);
      expect(noEvidence.length).toBe(item.framing === 'revealed' ? 1 : 0);
      for (const option of item.options) expect(option.id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('two framings of the same question disagree and the score moves conservative, not to the mean', () => {
    // Says "invest extra while prices are lower" (5); actually sold most of it (1).
    // Consistent at 4 on the other two dispositions.
    const derivation = deriveTolerance(
      answersOf({ drawdown: [5, 1], volatility: [4, 4], risk_identity: [4, 4] }),
    );
    const drawdown = derivation.dispositions.find((row) => row.disposition === 'drawdown');
    expect(drawdown).toMatchObject({ stated: 5, revealed: 1, unpenalised: 6, penalty: 4 });
    // Credited at the conservative framing (1, doubled = 2) — not the mean (3, doubled = 6).
    expect(drawdown?.credited).toBe(2);
    expect(drawdown?.credited).not.toBe(drawdown?.unpenalised);

    expect(derivation.unpenalisedScore).toBe(22);
    expect(derivation.compositeScore).toBe(18);
    expect(derivation.consistencyPenalty).toBe(4);
    // Averaging would have said moderate_aggressive; the penalty lands it on moderate.
    expect(derivation.toleranceIfAveraged).toBe('moderate_aggressive');
    expect(derivation.tolerance).toBe('moderate');
    expect(derivation.explanation.join('\n')).toMatch(
      /more conservative answer, 1, not the average, 3/,
    );

    // Which framing is the conservative one does not matter: the reverse
    // disagreement (says "sell everything", actually bought) is credited the same.
    const reversed = deriveTolerance(
      answersOf({ drawdown: [1, 5], volatility: [4, 4], risk_identity: [4, 4] }),
    );
    expect(reversed.compositeScore).toBe(derivation.compositeScore);
    expect(reversed.consistencyPenalty).toBe(derivation.consistencyPenalty);

    // And as a property over every answer set the instrument admits: each
    // disposition is credited at twice the smaller framing, never at their sum;
    // the penalty is exactly Σ|s − r|; and the score never exceeds what
    // averaging would have given.
    fc.assert(
      fc.property(answersArbitrary, (answers) => {
        const result = deriveTolerance(answers);
        let expectedPenalty = 0;
        for (const row of result.dispositions) {
          expect(row.credited).toBe(2 * Math.min(row.stated, row.revealed));
          expect(row.unpenalised).toBe(row.stated + row.revealed);
          expectedPenalty += Math.abs(row.stated - row.revealed);
          if (row.revealedWasNoEvidence) expect(row.revealed).toBe(Math.min(row.stated, 3));
        }
        expect(result.consistencyPenalty).toBe(expectedPenalty);
        expect(result.compositeScore).toBe(result.unpenalisedScore - result.consistencyPenalty);
        expect(result.compositeScore).toBeLessThanOrEqual(result.unpenalisedScore);
        expect(result.tolerance).toBe(toleranceFor(result.compositeScore));
      }),
      { numRuns: 500 },
    );
  });

  it('the consistency penalty is stored and the score is re-derivable from the stored answers alone', () => {
    const { record } = buildRiskProfileRecord(
      {
        answers: answersOf({ drawdown: [4, 2], volatility: [5, null], risk_identity: [3, 3] }),
        horizonYears: 22,
        liquidityNeed: 'low',
        income: null,
      },
      ANSWERED_AT,
    );
    // Stored: every figure the explanation depends on is a column of the row.
    expect(record.consistencyPenalty).toBe(4);
    expect(record.unpenalisedScore - record.compositeScore).toBe(record.consistencyPenalty);

    // Re-derive from the answers document *as it would come back from JSONB*:
    // serialised, parsed, and nothing else from the row consulted.
    const storedAnswers: unknown = JSON.parse(JSON.stringify(record.answers));
    const again = deriveTolerance(storedAnswers);
    expect(again.tolerance).toBe(record.tolerance);
    expect(again.compositeScore).toBe(record.compositeScore);
    expect(again.unpenalisedScore).toBe(record.unpenalisedScore);
    expect(again.consistencyPenalty).toBe(record.consistencyPenalty);

    // The document is all option ids, so nothing numeric is stored in it at all.
    expect(Object.keys(storedAnswers as object).sort()).toEqual(['instrument', 'items']);
    for (const value of Object.values((storedAnswers as RiskAnswers).items)) {
      expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
    }

    // For every answer set, a stored record re-derives to itself.
    fc.assert(
      fc.property(answersArbitrary, (answers) => {
        const built = buildRiskProfileRecord(
          { answers, horizonYears: 10, liquidityNeed: 'medium', income: null },
          ANSWERED_AT,
        ).record;
        const rederived = deriveTolerance(JSON.parse(JSON.stringify(built.answers)));
        expect([
          rederived.tolerance,
          rederived.compositeScore,
          rederived.consistencyPenalty,
        ]).toEqual([built.tolerance, built.compositeScore, built.consistencyPenalty]);
      }),
      { numRuns: 200 },
    );

    // A document that is not re-derivable is refused, never partially scored.
    const refusals: unknown[] = [
      { ...record.answers, instrument: 'risk-v0' },
      { instrument: RISK_INSTRUMENT_VERSION, items: { 'drawdown.stated': 'hold' } },
      { ...record.answers, extra: 1 },
      {
        instrument: RISK_INSTRUMENT_VERSION,
        items: { ...record.answers.items, 'drawdown.stated': 'not_an_option' },
      },
      {
        instrument: RISK_INSTRUMENT_VERSION,
        items: { ...record.answers.items, 'drawdown.stated': 4 },
      },
    ];
    for (const document of refusals) {
      expect(() => deriveTolerance(document)).toThrow(PlanningError);
    }
  });

  it('tax_bracket_band is a band and the exact income never reaches the row', () => {
    const income = usd('84000.00');
    const answers = answersOf({ drawdown: [4, 4], volatility: [3, 3], risk_identity: [3, 4] });
    const { record } = buildRiskProfileRecord(
      {
        answers,
        horizonYears: 22,
        liquidityNeed: 'low',
        income: { taxableIncome: income, schedule: US_2026_SINGLE },
      },
      ANSWERED_AT,
    );

    // A band: two whole-percent rates, and the published scope's own example shape.
    expect(record.taxBracketBand).toBe('22-32');
    expect(record.taxBracketBand).toMatch(/^\d{1,2}-\d{1,2}$/);

    // The income is not in the row — not as minor units, not as dollars, not
    // under any key. `record` is exactly what `insertRiskProfile` writes.
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain(income.minor.toString());
    expect(serialised).not.toContain('84000');
    expect(serialised).not.toContain('84,000');
    expect(serialised.toLowerCase()).not.toContain('income');
    expect(Object.keys(record).sort()).toEqual([
      'answeredAt',
      'answers',
      'compositeScore',
      'consistencyPenalty',
      'horizonYears',
      'id',
      'liquidityNeed',
      'taxBracketBand',
      'tolerance',
      'unpenalisedScore',
    ]);

    // Nothing about the row varies with the income inside a band: every
    // income in the middle band gives the same record, bar id and time.
    const strip = (value: typeof record): unknown => ({ ...value, id: '', answeredAt: '' });
    fc.assert(
      fc.property(fc.bigInt({ min: 5_040_001n, max: 25_622_500n }), (minor) => {
        const other = buildRiskProfileRecord(
          {
            answers,
            horizonYears: 22,
            liquidityNeed: 'low',
            income: { taxableIncome: Money.of(minor, 'USD'), schedule: US_2026_SINGLE },
          },
          ANSWERED_AT,
        ).record;
        expect(strip(other)).toEqual(strip(record));
      }),
      { numRuns: 200 },
    );

    // The boundaries, at the income that crosses each one. "22% > $50,400":
    // exactly $50,400.00 is still the 12% bracket.
    const bands: readonly [string, string][] = [
      ['0.00', '10-12'],
      ['12400.00', '10-12'],
      ['12400.01', '10-12'],
      ['50400.00', '10-12'],
      ['50400.01', '22-32'],
      ['105700.01', '22-32'],
      ['201775.01', '22-32'],
      ['256225.00', '22-32'],
      ['256225.01', '35-37'],
      ['640600.01', '35-37'],
      ['5000000.00', '35-37'],
    ];
    for (const [dollars, band] of bands) {
      expect(taxBracketBand(usd(dollars), US_2026_SINGLE), dollars).toBe(band);
    }

    // Declining to give an income is a null band, never a guessed one.
    const declined = buildRiskProfileRecord(
      { answers, horizonYears: 22, liquidityNeed: 'low', income: null },
      ANSWERED_AT,
    ).record;
    expect(declined.taxBracketBand).toBeNull();

    // A negative income or a currency the schedule is not in is refused.
    expect(() => taxBracketBand(usd('-1.00'), US_2026_SINGLE)).toThrow(PlanningError);
    expect(() => taxBracketBand(Money.of(100n, 'EUR'), US_2026_SINGLE)).toThrow(PlanningError);
    // So is an income smuggled onto the answers document: refused, not stored.
    expect(() =>
      buildRiskProfileRecord(
        {
          answers: { ...answers, income: '84000' } as unknown as RiskAnswers,
          horizonYears: 22,
          liquidityNeed: 'low',
          income: null,
        },
        ANSWERED_AT,
      ),
    ).toThrow(PlanningError);
  });
});
