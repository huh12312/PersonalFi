// SPDX-License-Identifier: MIT
/**
 * Step 7: every number a human will read came from somewhere we can point at.
 *
 * 02-phase-2-dispatch.md §5 names the risk plainly — *an advisor invents a
 * number* — and notes that the built-ins are deterministic today, so today this
 * check costs nothing and proves little. That is exactly why it exists now: the
 * contract it guards is the one Phase 5's local model and Phase 6's sidecar
 * will use, and a defence added after the first non-deterministic advisor is a
 * defence designed around whatever that advisor happened to do.
 *
 * **Sabotage record.** `'an insight whose number is absent from the snapshot is
 * rejected'` was run once with `checkNumerals` short-circuited to `null`, and
 * was red on the first try. Restored. Recorded in
 * docs/evidence/phase-2/wp2.6-insights.md §4.
 */
import { describe, expect, it } from 'vitest';
import type { Insight } from '../src/contract/response.ts';
import { validateResponse } from '../src/validate/pipeline.ts';
import {
  collectNumericCandidates,
  extractNumerals,
  maskLiterals,
  renderingsOf,
  stripUrls,
  traceContext,
  untraceableNumerals,
} from '../src/validate/numerals.ts';
import { parseDecimal } from '../src/validate/decimal.ts';
import { renderedText } from '../src/validate/markdown.ts';
import { baseSnapshot, fixture } from './fixtures.ts';

const LIMITS = { timeoutMs: 30_000, maxInsights: 20, maxResponseBytes: 131_072 };

function validate(bundle: ReturnType<typeof fixture>) {
  return validateResponse({
    request: bundle.request,
    manifest: bundle.manifest,
    limits: LIMITS,
    body: bundle.response,
  });
}

describe('no fabricated numbers', () => {
  it('every numeral in a rendered body appears in inputs_snapshot', () => {
    // The fixture's body is "At $18.99 a month, this subscription costs
    // $227.88 a year." `18.99` is `1899` minor units ÷ 100; `227.88` is the
    // declared derivation's computed `22788` ÷ 100. Neither figure is a literal
    // anywhere in the snapshot and both are traceable, which is the whole point
    // — a rule that only allowed literal snapshot values would forbid most of
    // what useful advice is.
    const outcome = validate(fixture());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected).toEqual([]);

    const accepted = outcome.accepted[0];
    expect(accepted).toBeDefined();
    const context = traceContext({
      snapshot: baseSnapshot(),
      derived: [...(accepted?.derived.values() ?? [])].flatMap((value) => {
        const parsed = parseDecimal(value);
        return parsed === null ? [] : [parsed];
      }),
    });
    const body = renderedText(accepted?.insight.summary_md ?? '');
    expect(untraceableNumerals(body, context)).toEqual([]);
    // And the body really does contain numerals, so the assertion above is not
    // vacuously true on an empty list.
    expect(extractNumerals(body).map((numeral) => numeral.normalized)).toEqual(['18.99', '227.88']);
  });

  it('an insight whose number is absent from the snapshot is rejected', () => {
    // One digit changed. `227.99` is close to a real figure, which is the shape
    // every plausible hallucination has — and is why the check is exact
    // equality under six enumerated renderings rather than a tolerance.
    const broken = validate(
      fixture({
        insight: {
          summary_md: 'At $18.99 a month, this subscription costs $227.99 a year.',
        },
      }),
    );
    expect(broken.ok).toBe(true);
    if (!broken.ok) return;
    expect(broken.accepted).toEqual([]);
    expect(broken.rejected[0]?.step).toBe('numerals');
    expect(broken.rejected[0]?.reason).toBe('numeral_not_in_snapshot');
    expect(broken.rejected[0]?.detail).toContain('227.99');
  });

  it('a fabricated figure in a caveat or an impact basis is caught too', () => {
    // The likeliest way this check goes wrong is for the list of fields it
    // reads to fall behind the schema, so each non-obvious one is asserted.
    const cases: readonly [string, Partial<Insight>][] = [
      ['caveats', { caveats: ['Assumes the price holds for all 13 months.'] }],
      [
        'impact.basis',
        {
          impact: {
            annualized: null,
            one_time: null,
            basis: 'Roughly $500 a year.',
            derivation_id: null,
          },
        },
      ],
      ['title', { title: 'You spend $9,412 a year on this' }],
      [
        'action rationale',
        {
          proposed_actions: [
            {
              kind: 'suggest_only',
              label: 'Review',
              rationale_md: 'Cancelling saves $312 annually.',
              url: null,
            },
          ],
        },
      ],
    ];
    for (const [field, insight] of cases) {
      const outcome = validate(fixture({ insight }));
      expect(outcome.ok, field).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.accepted, field).toEqual([]);
      expect(outcome.rejected[0]?.step, field).toBe('numerals');
    }
  });

  it('an impact figure that no derivation produced is rejected', () => {
    // The headline number the UI renders on its own, outside any prose. It is
    // traced explicitly rather than by happening to appear in `basis`.
    const outcome = validate(
      fixture({
        insight: {
          impact: {
            annualized: { minor: '49900', currency: 'USD' },
            one_time: null,
            basis: 'The monthly charge, multiplied by the periods in a year.',
            derivation_id: 'annualised',
          },
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected[0]?.step).toBe('numerals');
  });

  it('a derivation that does not produce the value it claims is rejected', () => {
    // Step 6, and the hole "declare your arithmetic" would otherwise have: the
    // advisor says `$0 * 12 = 49900`, we compute `22788`, and the claim loses.
    const outcome = validate(
      fixture({
        insight: {
          derivations: [
            {
              id: 'annualised',
              expression: '$0 * 12',
              inputs: ['snapshot:recurring_list.streams[0].typical_amount.minor'],
              value: '49900',
              note: null,
            },
          ],
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected[0]?.step).toBe('derivations');
    expect(outcome.rejected[0]?.reason).toBe('derivation_value_mismatch');
  });

  it('a literal smuggled through an expression is rejected', () => {
    // `$0 * 0 + 4999` references an input, computes nothing from it, and
    // launders a literal as the answer. The literal allow-list is what closes
    // it: `4999` is not a unit and there is no way to build it.
    const outcome = validate(
      fixture({
        insight: {
          derivations: [
            {
              id: 'annualised',
              expression: '$0 * 0 + 4999',
              inputs: ['snapshot:recurring_list.streams[0].typical_amount.minor'],
              value: '4999',
              note: null,
            },
          ],
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rejected[0]?.reason).toBe('derivation_forbidden_literal');
  });

  it('markdown outside the permitted subset is rejected', () => {
    for (const [name, summary] of [
      ['html', 'At $18.99 a month<img src=x onerror=alert(1)>.'],
      ['entity', 'At $18.99 a month &lt;script&gt;.'],
      ['heading', '# At $18.99 a month'],
      ['table', '| a | b |'],
      ['javascript scheme', 'See [this](javascript:alert(1)) at $18.99 a month.'],
    ] as const) {
      const outcome = validate(fixture({ insight: { summary_md: summary } }));
      expect(outcome.ok, name).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.accepted, name).toEqual([]);
      expect(outcome.rejected[0]?.reason, name).toMatch(/^markdown_/);
    }
  });
});

describe('the numeral extractor itself', () => {
  it('does not tear a snapshot literal into figures that must be traced', () => {
    // `2026-10-01` is a value we sent. It is not a claim that `2026`, `10` and
    // `1` are figures, and masking it whole — longest first — is what stops it
    // becoming three untraceable numerals.
    const literals = ['2026-10-01', '2026-10', 'MERCHANT_a7f31c9d0e42'];
    const masked = maskLiterals('Next charge 2026-10-01 for MERCHANT_a7f31c9d0e42.', literals);
    expect(extractNumerals(masked)).toEqual([]);
  });

  it('leaves a bare numeric string for the numeric check', () => {
    // `1899` is money in minor units, not a formatted literal. Masking it as a
    // string would let an advisor print any figure that also appears verbatim
    // in the snapshot without it having to be *this* figure.
    expect(maskLiterals('1899', ['1899'])).toBe('1899');
  });

  it("does not demand that a URL's digits be in the snapshot", () => {
    expect(extractNumerals(stripUrls('See https://example.com/2024/guide for more.'))).toEqual([]);
  });

  it('enumerates six renderings and not a tolerance', () => {
    const value = parseDecimal('1899');
    expect(value).not.toBeNull();
    if (value === null) return;
    expect(renderingsOf(value, 2)).toContain('18.99');
    // A figure 1% away from a real one is not a rendering of it.
    expect(renderingsOf(value, 2)).not.toContain('19.18');
  });

  it('harvests both JSON numbers and numeric strings from the snapshot', () => {
    const candidates = collectNumericCandidates(baseSnapshot()).map((value) => value.toString());
    // `1899` as a string (money, minor units) and `0.0425` as a JSON number.
    expect(candidates).toContain((1899n * 1_000_000n).toString());
    expect(candidates).toContain('42500');
  });
});
