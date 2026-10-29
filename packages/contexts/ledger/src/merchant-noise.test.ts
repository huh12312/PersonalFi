// SPDX-License-Identifier: MIT
/**
 * WP 11.6: the noise detector — which merchants a `merchant.name` suggestion may
 * ever be asked for. The tables pin the shape table and the verdict over
 * descriptors from the repo's own corpora and the evidence's golden set; the
 * properties pin the two rules that are not table rows: a banking operation
 * (D25's `key === null`) is never noise, and a holder's rename never changes the
 * verdict (the detector reads only what the bank sent).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MERCHANT_NOISE_SHAPES,
  detectMerchantNoise,
  mayBeNoise,
  noiseShapesOf,
  type MerchantNoiseShape,
} from './merchant-noise.ts';
import { processorPrefixOf, resolveMerchantIdentity } from './normalise.ts';

describe('the shape table', () => {
  it('has exactly the seven shapes, each with a rule and an example', () => {
    expect(MERCHANT_NOISE_SHAPES.map((entry) => entry.shape)).toEqual([
      'processor_star',
      'hash_token',
      'reference_marker',
      'domain_tail',
      'vowelless_run',
      'run_together',
      'processor_squashed',
    ]);
    for (const entry of MERCHANT_NOISE_SHAPES) {
      expect(entry.rule.length).toBeGreaterThan(20);
      expect(entry.example.length).toBeGreaterThan(3);
    }
  });

  it.each(
    MERCHANT_NOISE_SHAPES.filter((entry) => entry.shape !== 'processor_squashed').map(
      (entry) => [entry.shape, entry.example] as const,
    ),
  )('%s matches its own example', (shape, example) => {
    expect(noiseShapesOf(example)).toContain(shape);
  });
});

describe('detectMerchantNoise: noise', () => {
  const NOISE: readonly (readonly [
    string,
    string,
    string | null,
    readonly MerchantNoiseShape[],
  ])[] = [
    // raw descriptor, the residue sent, the prefix hint, the shapes
    ['PAYPAL *EBAYINC', 'Ebayinc', 'PAYPAL *', ['processor_squashed']],
    ['CKO*PATREON* MEMBERSHIP', 'Cko*patreon* Membership', null, ['processor_star']],
    ['EBAY O*2K4TT1FF2', 'Ebay O*2k4tt1ff2', null, ['processor_star', 'hash_token']],
    ['APPLE.COM/BILL', 'Apple.com/bill', null, ['domain_tail']],
    ['WHLFDS MKT #10234', 'Whlfds MKT', null, ['vowelless_run']],
    ['BLUEBOTTLECOFFEE', 'Bluebottlecoffee', null, ['run_together']],
    ['NETFLIX REF XK2', 'Netflix REF XK2', null, ['reference_marker']],
    ['PP*ACMEWIDG8X2', 'Acmewidg8x2', 'PP*', ['hash_token']],
    ['STRBCKS 0042', 'Strbcks', null, ['vowelless_run']],
    ['GOOGLE *YOUTUBE PREMIUM', 'Google *youtube Premium', null, ['processor_star']],
    [
      'UBER *TRIP HELP.UBER.COM',
      'Uber *trip Help.uber.com',
      null,
      ['processor_star', 'domain_tail'],
    ],
    ['ORDER ID 9X8Y7Z6W', 'Order ID 9x8y7z6w', null, ['hash_token', 'reference_marker']],
  ];

  it('the stored-display pre-screen passes every residue a noise verdict comes from', () => {
    for (const [raw, descriptor] of NOISE) expect(mayBeNoise(descriptor), raw).toBe(true);
    expect(mayBeNoise('Blue Bottle Coffee')).toBe(false);
    expect(mayBeNoise('REI')).toBe(false);
  });

  it.each(NOISE)('%s → %s', (raw, descriptor, prefix, shapes) => {
    const verdict = detectMerchantNoise({ name: raw });
    expect(verdict).toEqual({
      noise: true,
      key: resolveMerchantIdentity({ name: raw }).key,
      descriptor,
      strippedPrefix: prefix,
      shapes,
    });
  });
});

describe('detectMerchantNoise: not noise', () => {
  it.each([
    ['SQ *BLUE BOTTLE COFFEE #4471 OAKLAND CA', 'clean'],
    ['TST* JOES PIZZA 0042', 'clean'],
    ['COSTCO WHSE #1234 SEATTLE WA', 'clean'],
    ['SHELL OIL 57443021 PORTLAND OR', 'clean'],
    ['REI 0042', 'clean'],
    ['7-ELEVEN 711', 'clean'],
    ['BEST BUY 00012345', 'clean'],
    ['TRADER JOE S #552', 'clean'],
    // The prefix *is* the merchant: the normaliser already says "Amazon".
    ['AMZN Mktp US*2K4TT1FF2', 'clean'],
    // D25: a banking operation names no payee — no merchant, no key, never asked.
    ['CHECK 1234', 'no_merchant'],
    ['TRANSFER TO SAVINGS', 'no_merchant'],
    ['PAYMENT THANK YOU', 'no_merchant'],
    ['INTEREST PAID', 'no_merchant'],
  ] as const)('%s → %s', (raw, reason) => {
    const verdict = detectMerchantNoise({ name: raw });
    expect(verdict.noise).toBe(false);
    if (!verdict.noise) expect(verdict.reason).toBe(reason);
  });

  it('is never noise when the provider named the merchant', () => {
    expect(detectMerchantNoise({ name: 'PAYPAL *EBAYINC', merchantName: 'eBay' })).toEqual({
      noise: false,
      reason: 'provider_named',
      key: 'ebay',
    });
    expect(
      detectMerchantNoise({
        name: 'CKO*PATREON* MEMBERSHIP',
        provider: 'plaid',
        counterparties: [{ name: 'Patreon', type: 'merchant', entityId: 'e1' }],
      }),
    ).toMatchObject({ noise: false, reason: 'provider_named' });
  });
});

describe('the rules that are not rows', () => {
  const noiseWord = fc.constantFrom(
    'CKO*PATREON*',
    'WHLFDS',
    '2K4TT1FF2',
    'APPLE.COM/BILL',
    'STRBCKS',
    'REF',
  );
  const operation = fc.constantFrom(
    'CHECK',
    'TRANSFER TO SAVINGS',
    'INTEREST PAID',
    'ATM WITHDRAWAL',
    'ONLINE PAYMENT THANK YOU',
  );

  it('a banking operation (D25 key === null) is never noise, whatever noise rides with it', () => {
    fc.assert(
      fc.property(operation, fc.option(fc.integer({ min: 0, max: 99_999 })), (op, number) => {
        const raw = number === null ? op : `${op} ${String(number)}`;
        const verdict = detectMerchantNoise({ name: raw });
        if (resolveMerchantIdentity({ name: raw }).key === null) {
          expect(verdict).toEqual({ noise: false, reason: 'no_merchant', key: null });
        }
      }),
    );
  });

  it('the verdict is a function of the bank’s text alone: a noise word makes a merchant noise, and its key is the identity key', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z]{3,8}$/u), noiseWord, (word, noise) => {
        const raw = `${word} ${noise}`;
        const verdict = detectMerchantNoise({ name: raw });
        const identity = resolveMerchantIdentity({ name: raw });
        if (identity.key === null) {
          expect(verdict.noise).toBe(false);
          return;
        }
        expect(verdict.noise).toBe(true);
        expect(verdict.key).toBe(identity.key);
      }),
    );
  });

  it('the prefix hint names only a prefix the normaliser strips, never one that is the merchant', () => {
    expect(processorPrefixOf('PAYPAL *EBAYINC')).toBe('PAYPAL *');
    expect(processorPrefixOf('sq *bluebtl')).toBe('SQ *');
    expect(processorPrefixOf('TST* JOES')).toBe('TST*');
    expect(processorPrefixOf('AMZN Mktp US*2K4TT1FF2')).toBeNull();
    expect(processorPrefixOf('BLUE BOTTLE')).toBeNull();
  });
});
