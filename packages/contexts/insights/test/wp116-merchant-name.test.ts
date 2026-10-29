// SPDX-License-Identifier: MIT
/**
 * WP 11.6 — `merchant.name`, the insights half: the manifest (local only, one
 * scope, not in the nightly registry), the pinned payload snapshot (the
 * descriptor and the prefix hint, nothing a caller adds), the pinned validator
 * table (every refusal class, by example), the approvable shape (the consent
 * text is inside it) and the seventeenth control check.
 */
import { describe, expect, it } from 'vitest';
import { lintAdviceCopy } from '../src/advisors/copy-lint.ts';
import { createBuiltinRegistry } from '../src/advisors/catalogue.ts';
import {
  MERCHANT_NAME_ADVISOR_ID,
  MERCHANT_NAME_CONSENT_TEXT,
  MERCHANT_NAME_MANIFEST,
  merchantNameShapeTemplateHash,
} from '../src/advisors/merchant-name/manifest.ts';
import { buildMerchantNameRequest } from '../src/advisors/merchant-name/request.ts';
import {
  MERCHANT_NAME_REFUSAL_CLASSES,
  nameTokensOf,
  substringPreservationRefusal,
  validateMerchantNameReply,
  type MerchantNameVerdict,
} from '../src/advisors/merchant-name/reply.ts';
import { merchantNameShape } from '../src/advisors/merchant-name/run.ts';
import { insightExplainShape } from '../src/advisors/explain/run.ts';
import {
  CONTROL_CHECKS,
  MERCHANT_NAME_PROBE_DESCRIPTOR,
  MERCHANT_NAME_PROBE_REPLY,
  checkMerchantNameSubstring,
} from '../src/control-checks/catalogue.ts';

const NOW = new Date('2026-10-29T09:00:00.000Z');

describe('the manifest', () => {
  it('is a local_model query type asking for transactions.residue only, no impact, no narration, not in the nightly registry', () => {
    expect(MERCHANT_NAME_MANIFEST).toMatchObject({
      advisor_id: 'merchant.name',
      kind: 'local_model',
      requires_scopes: ['transactions.residue'],
      triggers: [],
      capabilities: { produces_impact: false, narrates_only: false, max_severity: 'info' },
      egress_allowlist: [],
    });
    expect(MERCHANT_NAME_MANIFEST.requires_scopes).not.toContain('transactions.raw');
    expect(createBuiltinRegistry().get(MERCHANT_NAME_ADVISOR_ID)).toBeUndefined();
  });

  it('the consent text says it stays on this machine, and passes the copy linter', () => {
    expect(MERCHANT_NAME_CONSENT_TEXT).toContain('local model on this machine only');
    expect(MERCHANT_NAME_CONSENT_TEXT).toContain('Nothing leaves this machine');
    expect(lintAdviceCopy(MERCHANT_NAME_CONSENT_TEXT, 'summary_md')).toEqual([]);
    expect(lintAdviceCopy(MERCHANT_NAME_MANIFEST.purpose, 'summary_md')).toEqual([]);
  });

  it('the shape folds in the consent: a new template is a new shape, and it is never another query type’s', () => {
    const a = merchantNameShape(`sha256:${'1'.repeat(64)}`);
    expect(merchantNameShape(`sha256:${'1'.repeat(64)}`)).toBe(a);
    expect(merchantNameShape(`sha256:${'2'.repeat(64)}`)).not.toBe(a);
    expect(merchantNameShapeTemplateHash(`sha256:${'1'.repeat(64)}`)).not.toBe(
      `sha256:${'1'.repeat(64)}`,
    );
    expect(insightExplainShape(`sha256:${'1'.repeat(64)}`)).not.toBe(a);
  });
});

describe('the payload (scope minimisation)', () => {
  it('is the descriptor and the prefix hint, and nothing a caller adds', () => {
    const smuggled = {
      descriptor: 'Ebayinc',
      strippedPrefix: 'PAYPAL *',
      amount: '-$42.10',
      postedDate: '2026-10-01',
      accountId: 'acc-1',
      categoryKey: 'shopping',
      otherMerchants: ['Whlfds MKT'],
      now: NOW,
      timeoutMs: 300_000,
      maxResponseBytes: 4_096,
    };
    const built = buildMerchantNameRequest(smuggled);
    expect(built.payload).toMatchInlineSnapshot(`
      {
        "granted_scopes": [
          "transactions.residue",
        ],
        "snapshot": {
          "transactions_residue": {
            "descriptor": "Ebayinc",
            "stripped_prefix": "PAYPAL *",
          },
        },
      }
    `);
    expect(Object.keys(built.request).sort()).toEqual([
      'deadline',
      'descriptor',
      'max_response_bytes',
      'request_id',
      'stripped_prefix',
    ]);
    expect(built.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The digest is of the data, not of the per-run id or deadline.
    expect(buildMerchantNameRequest({ ...smuggled, now: new Date(NOW.getTime() + 1) }).digest).toBe(
      built.digest,
    );
  });

  it('refuses an empty or over-long descriptor', () => {
    const base = { strippedPrefix: null, now: NOW, timeoutMs: 1, maxResponseBytes: 1 };
    expect(() => buildMerchantNameRequest({ ...base, descriptor: '  ' })).toThrow(RangeError);
    expect(() => buildMerchantNameRequest({ ...base, descriptor: 'x'.repeat(201) })).toThrow(
      RangeError,
    );
  });
});

/** The validator table the evidence prints: descriptor, reply, verdict. */
export const VALIDATOR_TABLE: readonly (readonly [string, unknown, MerchantNameVerdict])[] = [
  // Accepted: substring-preserving cleanups.
  ['Ebayinc', { display_name: 'Ebay' }, { verdict: 'suggested', displayName: 'Ebay' }],
  ['Ebayinc', { display_name: 'eBay' }, { verdict: 'suggested', displayName: 'eBay' }],
  [
    'Cko*patreon* Membership',
    { display_name: 'Patreon Membership' },
    { verdict: 'suggested', displayName: 'Patreon Membership' },
  ],
  [
    'Cko*patreon* Membership',
    { display_name: 'Cko Patreon' },
    { verdict: 'suggested', displayName: 'Cko Patreon' },
  ],
  ['Whlfds MKT', { display_name: 'Whlfds' }, { verdict: 'suggested', displayName: 'Whlfds' }],
  [
    'Google *youtube Premium',
    { display_name: '  YouTube   Premium ' },
    { verdict: 'suggested', displayName: 'YouTube Premium' },
  ],
  ['Ebay O*2k4tt1ff2', { display_name: 'Ebay' }, { verdict: 'suggested', displayName: 'Ebay' }],
  ['AT&T *payment', { display_name: 'AT&T' }, { verdict: 'suggested', displayName: 'AT&T' }],
  // Abstained.
  ['Bluebottlecoffee', { abstain: 'run together' }, { verdict: 'abstained' }],
  // name.invented: a brand or a word the bank never sent.
  ['Bluebtl Coffee 2K4TT1FF2', { display_name: 'Starbucks Coffee' }, refused('name.invented')],
  ['Strbcks', { display_name: 'Starbucks' }, refused('name.invented')],
  ['Bluebottlecoffee', { display_name: 'Blue Bottle Coffee' }, refused('name.invented')],
  ['Whlfds MKT', { display_name: 'Whole Foods Market' }, refused('name.invented')],
  ['Ebayinc', { display_name: 'eBay Inc' }, refused('name.invented')],
  ['Netflix REF XK2', { display_name: 'Netflix Streaming' }, refused('name.invented')],
  ['Uber *trip Help.uber.com', { display_name: 'Lyft' }, refused('name.invented')],
  // name.out_of_order: every word is the bank's, but not in its order (or one word twice).
  ['Cko*patreon* Membership', { display_name: 'Membership Patreon' }, refused('name.out_of_order')],
  ['Google *youtube Premium', { display_name: 'Premium Google' }, refused('name.out_of_order')],
  ['Whlfds MKT', { display_name: 'Whlfds Whlfds' }, refused('name.out_of_order')],
  // The name's own checks.
  ['Ebayinc', { display_name: '   ' }, refused('name.empty')],
  ['Ebayinc', { display_name: '***' }, refused('name.empty')],
  ['Ebayinc', { display_name: 'E'.repeat(41) }, refused('name.too_long')],
  ['Ebayinc', { display_name: '<b>Ebay</b>' }, refused('name.markup')],
  ['Ebayinc', { display_name: '**Ebay**' }, refused('name.markup')],
  ['Ebayinc', { display_name: 'Ebay\u0007' }, refused('name.markup')],
  ['Apple.com/bill', { display_name: 'Apple.com' }, refused('name.link')],
  ['Ebayinc', { display_name: 'www.ebay' }, refused('name.link')],
  ['Shop 7-11 2K4TT1', { display_name: '7 11' }, refused('name.digits_only')],
  [
    'Bestbuy 2K4TT1FF2',
    { display_name: 'Bestbuy' },
    { verdict: 'suggested', displayName: 'Bestbuy' },
  ],
  ['Best Buy 2K4TT1FF2', { display_name: 'Best Buy' }, refused('name.copy')],
  ['Starbucks', { display_name: 'STARBUCKS' }, refused('name.unchanged')],
  // The schema pin.
  ['Ebayinc', { display_name: 'Ebay', abstain: 'x' }, refused('schema')],
  ['Ebayinc', { name: 'Ebay' }, refused('schema')],
  ['Ebayinc', { display_name: 42 }, refused('schema')],
  ['Ebayinc', { abstain: null }, refused('schema')],
  ['Ebayinc', ['Ebay'], refused('schema')],
  ['Ebayinc', null, refused('schema')],
  ['Ebayinc', 'Ebay', refused('schema')],
];

function refused(refusal: (typeof MERCHANT_NAME_REFUSAL_CLASSES)[number]): MerchantNameVerdict {
  return { verdict: 'refused', refusal };
}

describe('the validator table', () => {
  it.each(VALIDATOR_TABLE)('%s ← %j', (descriptor, reply, expected) => {
    expect(validateMerchantNameReply(reply, { descriptor })).toEqual(expected);
  });

  it('exercises every refusal class', () => {
    const seen = new Set(
      VALIDATOR_TABLE.flatMap(([, , verdict]) =>
        verdict.verdict === 'refused' ? [verdict.refusal] : [],
      ),
    );
    expect([...seen].sort()).toEqual([...MERCHANT_NAME_REFUSAL_CLASSES].sort());
  });

  it('tokens are case-folded alphanumerics; a prefix of a descriptor token counts, in order, each token once', () => {
    expect(nameTokensOf('Cko*patreon* Membership')).toEqual(['cko', 'patreon', 'membership']);
    expect(substringPreservationRefusal('Patreon', 'Cko*patreon* Membership')).toBeNull();
    expect(substringPreservationRefusal('Patr Memb', 'Cko*patreon* Membership')).toBeNull();
    expect(substringPreservationRefusal('Membership Cko', 'Cko*patreon* Membership')).toBe(
      'name.out_of_order',
    );
    // A token that is the descriptor's but only as an infix is an invention.
    expect(substringPreservationRefusal('Bay', 'Ebayinc')).toBe('name.invented');
  });
});

describe('the seventeenth control check, merchant_name_substring', () => {
  it('is in the catalogue (api side) and passes against the shipped validator', async () => {
    expect(CONTROL_CHECKS).toHaveLength(17);
    expect(CONTROL_CHECKS.at(-1)).toMatchObject({ id: 'merchant_name_substring', side: 'api' });
    const outcome = await checkMerchantNameSubstring();
    expect(outcome.status, outcome.reason ?? '').toBe('pass');
    expect(outcome.facts.join(' ')).toContain('name.invented');
    // The fixed reply really is an invention of the fixed descriptor.
    expect(
      validateMerchantNameReply(MERCHANT_NAME_PROBE_REPLY, {
        descriptor: MERCHANT_NAME_PROBE_DESCRIPTOR,
      }),
    ).toEqual({ verdict: 'refused', refusal: 'name.invented' });
    // Its facts are sentences and carry no reply text beyond the class.
    expect(outcome.facts.join(' ')).not.toContain('Starbucks');
  });
});
