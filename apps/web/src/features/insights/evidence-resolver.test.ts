// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  citedSourceRefs,
  displayValueOf,
  resolveEvidenceRef,
  UnresolvedEvidenceRefError,
  type EvidenceRefLike,
} from './evidence-resolver.ts';

function evidence(overrides: Partial<EvidenceRefLike> = {}): EvidenceRefLike {
  return {
    sourceRef: 'snapshot:recurring_list.streams[0].typical_amount',
    label: 'Typical amount',
    value: '$18.99',
    resolvedDisplay: '$18.99',
    ...overrides,
  };
}

describe('resolveEvidenceRef', () => {
  it('finds the row whose sourceRef matches exactly', () => {
    const rows = [evidence({ sourceRef: 'snapshot:a' }), evidence({ sourceRef: 'snapshot:b' })];
    expect(resolveEvidenceRef(rows, 'snapshot:b')).toBe(rows[1]);
  });

  it('throws UnresolvedEvidenceRefError when no row in THIS insight cites the ref — never invents one', () => {
    const rows = [evidence({ sourceRef: 'snapshot:a' })];
    expect(() => resolveEvidenceRef(rows, 'snapshot:does_not_exist')).toThrow(
      UnresolvedEvidenceRefError,
    );
  });

  it('never falls back across insights: a ref present in one array is still unresolved against another', () => {
    const thisInsightsEvidence = [evidence({ sourceRef: 'snapshot:mine' })];
    // A ref that is real, but not on *this* insight, must still fail —
    // resolving it would mean showing a number this insight never cited.
    expect(() => resolveEvidenceRef(thisInsightsEvidence, 'snapshot:someone_elses')).toThrow(
      UnresolvedEvidenceRefError,
    );
  });

  it('the thrown error names the unresolved ref', () => {
    expect(() => resolveEvidenceRef([], 'snapshot:x.y[0]')).toThrow(/snapshot:x\.y\[0\]/);
  });
});

describe('displayValueOf', () => {
  it('prefers the server-resolved display', () => {
    expect(displayValueOf(evidence({ resolvedDisplay: '$18.99', value: '18.99' }))).toBe('$18.99');
  });

  it('falls back to the raw value when there is no resolved display', () => {
    expect(displayValueOf(evidence({ resolvedDisplay: null, value: 'MONTHLY' }))).toBe('MONTHLY');
  });

  it('renders an em dash rather than a fabricated number when both are null', () => {
    expect(displayValueOf(evidence({ resolvedDisplay: null, value: null }))).toBe('—');
  });
});

describe('displayValueOf — a minor-unit leaf is printed as money (G5-9, C5-8)', () => {
  const MINOR = 'snapshot:category_creep.recent.amount.minor';

  it("prints 129900 as $1,299.00 in the insight's currency, not as 129900", () => {
    // The gate's walk: the row's value is null and the resolved display is the leaf.
    const row = evidence({ sourceRef: MINOR, value: null, resolvedDisplay: '129900' });
    expect(displayValueOf(row, { currency: 'USD' })).toBe('$1,299.00');
  });

  it("is exact for every magnitude and honours the currency's own minor-unit scale", () => {
    const at = (minor: string, currency: string) =>
      displayValueOf(evidence({ sourceRef: MINOR, value: null, resolvedDisplay: minor }), {
        currency,
      });
    expect(at('5', 'USD')).toBe('$0.05');
    expect(at('100', 'USD')).toBe('$1.00');
    expect(at('123456789', 'USD')).toBe('$1,234,567.89');
    expect(at('-4500', 'USD')).toBe('−$45.00');
    expect(at('1299', 'JPY')).toBe('¥1,299');
  });

  it('with no currency to print it in, the raw figure says it is minor units — never bare dollars', () => {
    const row = evidence({ sourceRef: MINOR, value: null, resolvedDisplay: '129900' });
    expect(displayValueOf(row)).toBe('129900 minor units');
    expect(displayValueOf(row, { currency: null })).toBe('129900 minor units');
  });

  it('leaves every other row alone: a count, a percent, a date, a ref that is not a leaf of minor units', () => {
    const currency = { currency: 'USD' };
    expect(
      displayValueOf(
        evidence({ sourceRef: 'snapshot:x.count', value: '3', resolvedDisplay: '3' }),
        currency,
      ),
    ).toBe('3');
    expect(
      displayValueOf(
        evidence({ sourceRef: 'snapshot:x.rate', value: null, resolvedDisplay: '4.5%' }),
        currency,
      ),
    ).toBe('4.5%');
    // `.minor` but not a whole number: not a minor-unit figure, shown as resolved.
    expect(
      displayValueOf(
        evidence({ sourceRef: MINOR, value: null, resolvedDisplay: '$1,299.00' }),
        currency,
      ),
    ).toBe('$1,299.00');
    // A whole number on a ref that does not end in `.minor` is not money.
    expect(
      displayValueOf(
        evidence({ sourceRef: 'snapshot:x.total', value: null, resolvedDisplay: '129900' }),
        currency,
      ),
    ).toBe('129900');
  });
});

describe('citedSourceRefs', () => {
  it('collects every non-null sourceRef', () => {
    const rows = [
      evidence({ sourceRef: 'snapshot:a' }),
      evidence({ sourceRef: 'snapshot:b' }),
      evidence({ sourceRef: null }),
    ];
    expect(citedSourceRefs(rows)).toEqual(new Set(['snapshot:a', 'snapshot:b']));
  });
});
