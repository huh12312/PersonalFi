// SPDX-License-Identifier: MIT
/**
 * WP 11.2 — `categorize.suggest`, pure: the request carries the listed fields
 * and nothing else, the reply is a closed enum over the holder's taxonomy, the
 * reason carries no figure, link, markup or advice, and the approval shape is
 * this advisor's own.
 */
import { describe, expect, it } from 'vitest';
import { checkManifest } from '../src/registry.ts';
import {
  CATEGORY_SUGGEST_MANIFEST,
  categorySuggestShape,
  buildSuggestRequest,
  reasonRefusal,
  validateSuggestReply,
  type ResidueRowInput,
} from '../src/index.ts';
import { NARRATOR_MANIFEST } from '../src/advisors/local/manifest.ts';
import { queryShape } from '../src/preview.ts';

const TAXONOMY = [
  { key: 'food.groceries', label: 'Groceries' },
  { key: 'shopping.pets', label: 'Pets' },
];
const KEYS = new Set(TAXONOMY.map((entry) => entry.key));

function row(tokens: readonly string[] = ['fresh', 'market']): ResidueRowInput {
  return {
    payee_tokens: tokens,
    mcc_family: 'food',
    pfc_primary: 'food_and_drink',
    amount_bucket: '3',
    account_kind: 'credit',
    direction: 'out',
    day_bucket: 'mid',
  };
}

describe('the manifest', () => {
  it('registers: a local_model advisor asking for transactions.residue only, no impact, no narration', () => {
    expect(checkManifest(CATEGORY_SUGGEST_MANIFEST)).toMatchObject({ ok: true });
    expect(CATEGORY_SUGGEST_MANIFEST.advisor_id).toBe('categorize.suggest');
    expect(CATEGORY_SUGGEST_MANIFEST.kind).toBe('local_model');
    expect(CATEGORY_SUGGEST_MANIFEST.requires_scopes).toEqual(['transactions.residue']);
    expect(CATEGORY_SUGGEST_MANIFEST.capabilities).toMatchObject({
      deterministic: false,
      produces_impact: false,
      narrates_only: false,
    });
    expect(CATEGORY_SUGGEST_MANIFEST.egress_allowlist).toEqual([]);
  });
});

describe('the request (scope minimisation)', () => {
  it('carries only the listed fields per row, under batch-local refs; a memo or an id a caller adds is dropped', () => {
    const leaky = {
      ...row(),
      memo: 'MEMO-SECRET',
      account_id: '00000000-0000-7000-8000-b00000000001',
      transaction_id: '00000000-0000-7000-8000-a00000000001',
      raw_descriptor: 'SQ *FRESH MARKET #22 OAKLAND',
    } as ResidueRowInput;
    const built = buildSuggestRequest({
      taxonomy: TAXONOMY,
      rows: [leaky, row(['paws', 'depot'])],
      now: new Date('2026-10-27T12:00:00.000Z'),
      timeoutMs: 300_000,
      maxResponseBytes: 65_536,
    });
    const text = JSON.stringify(built.request);
    for (const forbidden of ['MEMO', 'SECRET', '00000000-0000-7000-8000', 'SQ *', 'OAKLAND']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(built.payload).toMatchInlineSnapshot(`
      {
        "granted_scopes": [
          "transactions.residue",
        ],
        "snapshot": {
          "transactions_residue": {
            "rows": [
              {
                "account_kind": "credit",
                "amount_bucket": "3",
                "day_bucket": "mid",
                "direction": "out",
                "mcc_family": "food",
                "payee_tokens": [
                  "fresh",
                  "market",
                ],
                "pfc_primary": "food_and_drink",
                "transaction_ref": "r1",
              },
              {
                "account_kind": "credit",
                "amount_bucket": "3",
                "day_bucket": "mid",
                "direction": "out",
                "mcc_family": "food",
                "payee_tokens": [
                  "paws",
                  "depot",
                ],
                "pfc_primary": "food_and_drink",
                "transaction_ref": "r2",
              },
            ],
            "taxonomy": [
              {
                "key": "food.groceries",
                "label": "Groceries",
              },
              {
                "key": "shopping.pets",
                "label": "Pets",
              },
            ],
          },
        },
      }
    `);
    expect(built.digest).toMatch(/^sha256:/u);
  });

  it('refuses an empty batch and one over fifty rows', () => {
    const base = {
      taxonomy: TAXONOMY,
      now: new Date(0),
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    };
    expect(() => buildSuggestRequest({ ...base, rows: [] })).toThrow(RangeError);
    expect(() =>
      buildSuggestRequest({ ...base, rows: Array.from({ length: 51 }, () => row()) }),
    ).toThrow(RangeError);
    expect(
      buildSuggestRequest({ ...base, rows: Array.from({ length: 50 }, () => row()) }).request.rows,
    ).toHaveLength(50);
  });
});

describe('the reply: a closed enum over the holder taxonomy', () => {
  const sent = { refs: ['r1', 'r2'], categoryKeys: KEYS };

  it('accepts a key from the taxonomy with a plain reason, and an abstention', () => {
    const outcome = validateSuggestReply(
      {
        suggestions: [
          {
            transaction_ref: 'r1',
            category_key: 'food.groceries',
            reason: 'A market name with a food category code.',
          },
        ],
        abstain: ['r2'],
      },
      sent,
    );
    expect(outcome.replyRefusal).toBeNull();
    expect(outcome.suggestions).toEqual([
      {
        ref: 'r1',
        categoryKey: 'food.groceries',
        reason: 'A market name with a food category code.',
      },
    ]);
    expect(outcome.abstained).toEqual(['r2']);
    expect(outcome.refusals).toEqual([]);
  });

  it('refuses an unknown category key as a refusal class — never shown', () => {
    const outcome = validateSuggestReply(
      {
        suggestions: [
          {
            transaction_ref: 'r1',
            category_key: 'control.outside_taxonomy',
            reason: 'Because it says so.',
          },
          { transaction_ref: 'r2', category_key: 'Groceries', reason: 'A label is not a key.' },
        ],
        abstain: [],
      },
      sent,
    );
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.refusals).toEqual([
      { ref: 'r1', refusal: 'unknown_category' },
      { ref: 'r2', refusal: 'unknown_category' },
    ]);
  });

  it('refuses the whole reply outside the format: an extra key, a wrong type, not an object', () => {
    for (const reply of [
      null,
      'food.groceries',
      { suggestions: [], abstain: [], note: 'extra' },
      {
        suggestions: [
          { transaction_ref: 'r1', category_key: 'food.groceries', reason: 'x', confidence: 1 },
        ],
        abstain: [],
      },
      {
        suggestions: [{ transaction_ref: 1, category_key: 'food.groceries', reason: 'x' }],
        abstain: [],
      },
      { suggestions: 'all of them', abstain: [] },
    ]) {
      const outcome = validateSuggestReply(reply, sent);
      expect(outcome.replyRefusal, JSON.stringify(reply)).toBe('schema');
      expect(outcome.suggestions).toEqual([]);
    }
  });

  it('refuses a ref it never sent, a ref answered twice, and records a ref left unanswered', () => {
    const outcome = validateSuggestReply(
      {
        suggestions: [
          { transaction_ref: 'r9', category_key: 'food.groceries', reason: 'Not a row we sent.' },
          { transaction_ref: 'r1', category_key: 'food.groceries', reason: 'Twice.' },
        ],
        abstain: ['r1'],
      },
      sent,
    );
    expect(outcome.suggestions).toEqual([]);
    expect(outcome.refusals).toEqual([
      { ref: null, refusal: 'unknown_ref' },
      { ref: 'r1', refusal: 'duplicate_ref' },
      { ref: 'r2', refusal: 'missing' },
    ]);
  });
});

describe('the reason', () => {
  it('refuses a figure in any form, a link, markup, advice, empty and over 140 characters', () => {
    expect(reasonRefusal('Usually about 40 a visit.')).toBe('reason_numeral');
    expect(reasonRefusal('Usually about ٤٠ a visit.')).toBe('reason_numeral');
    expect(reasonRefusal('Around five hundred dollars a month.')).toBe('reason_numeral');
    expect(reasonRefusal('Ten percent of your spending.')).toBe('reason_numeral');
    expect(reasonRefusal('See https://example.test for details.')).toBe('reason_link');
    expect(reasonRefusal('A shop on www.example.test.')).toBe('reason_link');
    expect(reasonRefusal('A <b>bold</b> guess.')).toBe('reason_markup');
    expect(reasonRefusal('Click [here](javascript:alert)')).toBe('reason_markup');
    expect(reasonRefusal('Cancel this subscription and save money.')).toBe('reason_copy');
    expect(reasonRefusal('   ')).toBe('reason_empty');
    expect(reasonRefusal('a'.repeat(141))).toBe('reason_too_long');
    expect(reasonRefusal('a'.repeat(140))).toBeNull();
    expect(reasonRefusal('A grocery chain name and a food category code.')).toBeNull();
  });
});

describe('the approval shape', () => {
  it("is this advisor's own: not the narrator's, and new when the template hash changes", () => {
    const a = categorySuggestShape('sha256:aaaa');
    expect(a).toBe(categorySuggestShape('sha256:aaaa'));
    expect(a).not.toBe(categorySuggestShape('sha256:bbbb'));
    expect(a).not.toBe(
      queryShape({
        advisorId: NARRATOR_MANIFEST.advisor_id,
        advisorVersion: NARRATOR_MANIFEST.version,
        kind: 'local_model',
        scopes: ['transactions.residue'],
        promptTemplateHash: 'sha256:aaaa',
      }),
    );
  });
});
