// SPDX-License-Identifier: MIT
/**
 * WP 10.15 (V8): an insight's entity mentions come from its own evidence, and only from the three leaves the
 * snapshot carries as real ids. `segmentText` adds and drops no words.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_LINE_TRANSACTIONS,
  contextLineOf,
  mentionCandidatesOf,
  segmentText,
  type MentionEvidence,
} from '../src/index.ts';

const CATEGORY = '0190a000-0000-7000-8000-000000000001';
const ACCOUNT = '0190a000-0000-7000-8000-000000000002';
const TRANSACTION = '0190a000-0000-7000-8000-000000000003';

function row(
  position: number,
  sourceRef: string | null,
  resolved: string | null,
  label = 'A row',
): MentionEvidence {
  return { position, label, value: null, sourceRef, resolvedDisplay: resolved };
}

describe('mentionCandidatesOf', () => {
  it('admits a category, an account and a transaction ref whose resolved value is a uuid', () => {
    const mentions = mentionCandidatesOf([
      row(0, 'snapshot:spending_summary.by_category[2].amount.minor', '12345'),
      row(1, 'snapshot:spending_summary.by_category[2].category_ref', CATEGORY),
      row(2, 'snapshot:cash_summary.accounts[0].account_ref', ACCOUNT),
      row(
        3,
        'snapshot:transactions.uncategorised[4].transaction_ref',
        TRANSACTION,
        'A transaction with no category',
      ),
    ]);
    expect(mentions).toEqual([
      {
        entityType: 'category',
        entityId: CATEGORY,
        evidencePosition: 1,
        sourceRef: 'snapshot:spending_summary.by_category[2].category_ref',
        label: 'A row',
      },
      {
        entityType: 'account',
        entityId: ACCOUNT,
        evidencePosition: 2,
        sourceRef: 'snapshot:cash_summary.accounts[0].account_ref',
        label: 'A row',
      },
      {
        entityType: 'transaction',
        entityId: TRANSACTION,
        evidencePosition: 3,
        sourceRef: 'snapshot:transactions.uncategorised[4].transaction_ref',
        label: 'A transaction with no category',
      },
    ]);
  });

  it('an entity the evidence does not cite is not a mention: no rows, no mentions', () => {
    expect(mentionCandidatesOf([])).toEqual([]);
    expect(
      mentionCandidatesOf([row(0, 'snapshot:spending_summary.total.minor', CATEGORY)]),
    ).toEqual([]);
  });

  it('a non-uuid value is not a mention (an external advisor sees tokens, never ids)', () => {
    expect(
      mentionCandidatesOf([
        row(0, 'snapshot:spending_summary.by_category[0].category_ref', 'CAT_a7f31c9d0e42'),
        row(1, 'snapshot:cash_summary.accounts[0].account_ref', null),
      ]),
    ).toEqual([]);
  });

  it('a merchant ref is never a mention: it is a one-way pseudonym (D22)', () => {
    expect(
      mentionCandidatesOf([
        row(0, 'snapshot:recurring_list.streams[0].merchant_ref', 'MERCHANT_a7f31c9d0e42'),
        row(1, 'snapshot:recurring_list.streams[0].merchant_ref', CATEGORY),
      ]),
    ).toEqual([]);
  });

  it('an external: ref and a null ref are skipped; an entity cited twice is mentioned once', () => {
    const mentions = mentionCandidatesOf([
      row(0, 'external:https://example.com/category_ref', CATEGORY),
      row(1, null, CATEGORY),
      row(2, 'snapshot:budget.lines[0].category_ref', CATEGORY),
      row(3, 'snapshot:budget.lines[1].category_ref', CATEGORY.toUpperCase()),
    ]);
    expect(mentions.map((m) => m.evidencePosition)).toEqual([2]);
  });
});

describe('segmentText', () => {
  const groceries = { text: 'Groceries', entityType: 'category' as const, entityId: CATEGORY };
  const household = {
    text: 'Groceries & Household',
    entityType: 'category' as const,
    entityId: ACCOUNT,
  };

  it('links every exact occurrence and keeps every character', () => {
    const text = 'Groceries ran high; Groceries again.';
    const segments = segmentText(text, [groceries]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    expect(segments.filter((s) => s.entityId === CATEGORY)).toHaveLength(2);
  });

  it('prefers the longest name at a position and is case-sensitive', () => {
    const segments = segmentText('groceries vs Groceries & Household', [groceries, household]);
    expect(segments).toEqual([
      { text: 'groceries vs ' },
      { text: 'Groceries & Household', entityType: 'category', entityId: ACCOUNT },
    ]);
  });

  it('no mentions: one plain segment; empty text: none', () => {
    expect(segmentText('Nothing here', [])).toEqual([{ text: 'Nothing here' }]);
    expect(segmentText('', [groceries])).toEqual([]);
  });
});

describe('contextLineOf', () => {
  it('names entities, numbers transactions, counts past the cap, and is null with nothing to say', () => {
    expect(contextLineOf([])).toBeNull();
    const tx = Array.from({ length: CONTEXT_LINE_TRANSACTIONS + 2 }, (_, i) => ({
      text: 'A transaction',
      entityType: 'transaction' as const,
      entityId: `0190a000-0000-7000-8000-00000000010${String(i)}`,
    }));
    const line = contextLineOf([
      { text: 'Groceries', entityType: 'category', entityId: CATEGORY },
      ...tx,
    ]);
    expect(line?.map((s) => s.text).join('')).toBe(
      'About Groceries · transaction 1, transaction 2, transaction 3, transaction 4, transaction 5 and 2 more',
    );
    expect(line?.filter((s) => s.entityId !== undefined)).toHaveLength(
      1 + CONTEXT_LINE_TRANSACTIONS,
    );
  });
});
