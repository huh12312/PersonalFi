// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  formatAmountModelLabel,
  formatCadenceLabel,
  formatDuplicateGroupLabel,
  formatNextDue,
  formatStatusLabel,
  formatStreamTypeLabel,
  formatUncertaintyDays,
  inferAmountModelLabel,
  isDormantStatus,
} from './cadence-format.ts';

describe('formatCadenceLabel', () => {
  it.each([
    ['WEEKLY', 'Weekly'],
    ['BIWEEKLY', 'Every 2 weeks'],
    ['SEMIMONTHLY', 'Twice a month'],
    ['MONTHLY', 'Monthly'],
    ['BIMONTHLY', 'Every 2 months'],
    ['QUARTERLY', 'Quarterly'],
    ['SEMIANNUAL', 'Twice a year'],
    ['ANNUAL', 'Yearly'],
  ])('formats %s as %s', (code, label) => {
    expect(formatCadenceLabel(code)).toBe(label);
  });

  it('falls back to "Irregular" for an unrecognised code rather than throwing', () => {
    expect(formatCadenceLabel('SOMETHING_NEW')).toBe('Irregular');
  });
});

describe('formatAmountModelLabel / formatStreamTypeLabel', () => {
  it('labels every amount model', () => {
    expect(formatAmountModelLabel('FIXED')).toBe('Fixed amount');
    expect(formatAmountModelLabel('VARIABLE')).toBe('Varies');
    expect(formatAmountModelLabel('IRREGULAR')).toBe('Irregular amount');
  });

  it('labels every stream type', () => {
    expect(formatStreamTypeLabel('SUBSCRIPTION')).toBe('Subscription');
    expect(formatStreamTypeLabel('LOAN_PAYMENT')).toBe('Loan payment');
  });
});

describe('inferAmountModelLabel', () => {
  it('reads "Fixed amount" off an identical observed range, never a dedicated field the wire does not send', () => {
    expect(inferAmountModelLabel('1899', '1899')).toBe('Fixed amount');
  });

  it('reads "Varies" off a range that actually varies', () => {
    expect(inferAmountModelLabel('4500', '5200')).toBe('Varies');
  });
});

describe('formatStatusLabel / isDormantStatus', () => {
  it('phrases dormancy as a question, never an accusation', () => {
    expect(formatStatusLabel('LIKELY_CANCELED')).toBe("Haven't seen a charge in a while");
    expect(formatStatusLabel('LIKELY_CANCELED')).not.toMatch(/cancel/i);
    expect(formatStatusLabel('CANCELED')).not.toMatch(/you cancelled/i);
  });

  it('flags exactly the three dormant rungs', () => {
    expect(isDormantStatus('EARLY_DETECTION')).toBe(false);
    expect(isDormantStatus('ACTIVE')).toBe(false);
    expect(isDormantStatus('AT_RISK')).toBe(true);
    expect(isDormantStatus('LIKELY_CANCELED')).toBe(true);
    expect(isDormantStatus('CANCELED')).toBe(true);
    expect(isDormantStatus('MIGRATED')).toBe(false);
  });
});

describe('formatNextDue', () => {
  it('reports no upcoming charge when there is no next due date', () => {
    expect(formatNextDue(null)).toBe('No upcoming charge expected');
  });

  it('formats a single point date with no band', () => {
    expect(formatNextDue('2026-10-01')).toBe('Next due Oct 1');
  });

  it('collapses a band to a point date when earliest equals latest', () => {
    expect(formatNextDue('2026-10-01', { earliest: '2026-10-01', latest: '2026-10-01' })).toBe(
      'Next due Oct 1',
    );
  });

  it('shows the uncertainty band when it spans more than one day', () => {
    expect(formatNextDue('2026-10-01', { earliest: '2026-09-30', latest: '2026-10-03' })).toBe(
      'Next due around Oct 1 (Sep 30 – Oct 3)',
    );
  });
});

describe('formatUncertaintyDays', () => {
  it('reports an exact date at zero', () => {
    expect(formatUncertaintyDays(0)).toBe('exact date');
  });

  it('singularises exactly one day', () => {
    expect(formatUncertaintyDays(1)).toBe('± 1 day');
  });

  it('pluralises more than one day', () => {
    expect(formatUncertaintyDays(3)).toBe('± 3 days');
  });
});

describe('formatDuplicateGroupLabel', () => {
  it('title-cases the last taxonomy segment', () => {
    expect(formatDuplicateGroupLabel('entertainment.streaming')).toBe('Streaming');
  });

  it('splits hyphens and underscores into words', () => {
    expect(formatDuplicateGroupLabel('media.video-on_demand')).toBe('Video On Demand');
  });
});
