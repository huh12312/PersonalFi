// SPDX-License-Identifier: MIT
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Insight } from '../../api/generated/types.gen.ts';
import { EvidencePanel } from './EvidencePanel.tsx';

function insight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: 'insight_1',
    advisorId: 'builtin.spending.category_creep',
    advisorVersion: '1.0.0',
    key: 'spending.category_creep.dining',
    period: '2026-09',
    type: 'spending.category_creep',
    severity: 'notable',
    severityClamped: false,
    title: 'Dining is creeping up',
    summaryMd: 'Dining is up.',
    confidence: 0.8,
    confidenceBasis: 'rule',
    horizon: 'this_year',
    status: 'pending_review',
    annualizedImpact: { minor: '389700', currency: 'USD' },
    oneTimeImpact: null,
    impactBasis: 'Recent months against the baseline.',
    caveats: [],
    inputDigest: 'sha256:x',
    firstProposedAt: '2026-10-01T00:00:00.000Z',
    lastProposedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: null,
    evidence: [
      {
        position: 0,
        kind: 'metric',
        label: 'A recent month',
        value: null,
        sourceRef: 'snapshot:category_creep.recent.amount.minor',
        resolvedDisplay: '129900',
        href: null,
      },
      {
        position: 1,
        kind: 'metric',
        label: 'Transactions counted',
        value: '12',
        sourceRef: 'snapshot:category_creep.recent.count',
        resolvedDisplay: '12',
        href: null,
      },
    ],
    actions: [],
    bookmarkedAt: null,
    feedback: null,
    feedbackReason: null,
    mentions: [],
    titleSegments: [],
    bodySegments: [],
    contextLine: null,
    ...overrides,
  };
}

describe('EvidencePanel (G5-9, C5-8: the panel prints money as money)', () => {
  it('shows a minor-unit leaf as dollars, not as 129900', () => {
    render(<EvidencePanel insight={insight()} />);
    const values = screen.getAllByTestId('evidence-value').map((node) => node.textContent);
    expect(values).toEqual(['$1,299.00', '12']);
    expect(screen.queryByText('129900')).not.toBeInTheDocument();
  });

  it('with no currency on the insight, labels the raw figure as minor units rather than dollars', () => {
    render(<EvidencePanel insight={insight({ annualizedImpact: null, oneTimeImpact: null })} />);
    expect(screen.getAllByTestId('evidence-value')[0]).toHaveTextContent('129900 minor units');
  });

  it("uses the insight's own currency", () => {
    render(
      <EvidencePanel insight={insight({ annualizedImpact: { minor: '1000', currency: 'EUR' } })} />,
    );
    expect(screen.getAllByTestId('evidence-value')[0]?.textContent).toMatch(/1,299\.00/);
    expect(screen.getAllByTestId('evidence-value')[0]?.textContent).toMatch(/€/);
  });
});
