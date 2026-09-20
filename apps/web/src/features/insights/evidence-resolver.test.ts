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
