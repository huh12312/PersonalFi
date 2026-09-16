// SPDX-License-Identifier: MIT
/**
 * Decision D25 — merchant identity, and the gate that refuses it.
 *
 * The example tables below are the corpus this rule was written against: every
 * descriptor here is one that `@core/seed`, the Plaid fixtures, or the
 * CSV/OFX/QIF fixtures actually produce. The properties after them are the part
 * that matters, because the failure mode this rule is exposed to is not "the
 * author forgot a case" but "a descriptor nobody thought of loses a real
 * merchant", and an example table cannot see that.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  merchantAbstainReasonOf,
  normaliseMerchantName,
  resolveMerchantIdentity,
} from './normalise.ts';

/** The pre-D25 key computation, stated once, so property 5 can pin it. */
function legacyKeyOf(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '');
}

describe('normaliseMerchantName — the D25 gate', () => {
  it.each([
    // [descriptor, expected merchantKey]
    ['SQ *BLUE BOTTLE COFFEE', 'bluebottlecoffee'],
    ['TST* THE FRENCH LAUNDRY', 'thefrenchlaundry'],
    ['AMZN Mktp US*2K4TT1FF2', 'amazon'],
    ['COSTCO WHSE #1234 SEATTLE WA', 'costcowhse'],
    ['SHELL OIL 57443021 PORTLAND OR', 'shelloil'],
    ['NETFLIX.COM', 'netflixcom'],
    // The three-letter names that set MIN_ALPHABETIC. Deleting any of these is
    // the cost of a stricter floor, which is why the floor is three.
    ['REI #3016 AUSTIN TX', 'rei'],
    ['CVS PHARMACY #405 SEATTLE WA', 'cvspharmacy'],
    ['PG&E', 'pge'],
    ['AT&T WIRELESS', 'attwireless'],
    // Vocabulary words inside real names. Each survives because the rule only
    // fires when *every* token is vocabulary.
    ['BANK OF AMERICA', 'bankofamerica'],
    ['CASH APP', 'cashapp'],
    ['DIRECT TV', 'directtv'],
    ['T-MOBILE', 'tmobile'],
    ['PAYROLL ACME CORP', 'payrollacmecorp'],
    ['NORTHWIND MUTUAL PAYROLL', 'northwindmutualpayroll'],
    ['SMITH, J. - RENT', 'smithjrent'],
    ['HARBOUR HARDWARE', 'harbourhardware'],
    ['TESCO STORES 3428', 'tescostores'],
  ])('resolves %s to %s', (descriptor, expected) => {
    const result = normaliseMerchantName(descriptor);
    expect(result.merchantKey).toBe(expected);
    expect(result.abstainReason).toBeNull();
  });

  it.each([
    ['PORTSIDE WATER CO', 'portside'],
    ['ROOFLINE & GUTTER CO', 'roofline'],
  ])('resolves %s to %s — a known pre-D25 limitation, not a D25 refusal', (descriptor, key) => {
    // `stripNoise`'s `CITY ST` tail rule reads the company suffix `CO` as
    // Colorado and eats the word before it. Both of these descriptors are real
    // (`packages/connectors/plaid/test/fixtures`, `…/csv/test/fixtures`), and
    // both still get a merchant — the identity is just shorter than it should
    // be. Left alone deliberately: D25 decides *whether* a payee has an
    // identity, and rewriting `stripNoise` would silently re-key existing
    // merchants for every user, which is the destructive migration this work
    // was told not to perform. Pinned here so the behaviour is recorded rather
    // than rediscovered.
    const result = normaliseMerchantName(descriptor);
    expect(result.merchantKey).toBe(key);
  });

  it.each([
    // [descriptor, expected abstain reason]
    ['TRANSFER TO HIGH-YIELD SAVINGS', 'self_transfer'],
    ['TRANSFER FROM EVERYDAY CHECKING', 'self_transfer'],
    ['TRANSFER TO REWARDS VISA', 'self_transfer'],
    ['XFER FROM SAVINGS', 'self_transfer'],
    ['ONLINE TRANSFER TO CHECKING 1234', 'self_transfer'],
    ['TRANSFER', 'self_transfer'],
    ['CHECK 1234', 'bank_operation'],
    ['CHECK 123', 'bank_operation'],
    ['INTEREST PAID', 'bank_operation'],
    ['ATM WITHDRAWAL', 'bank_operation'],
    ['DIRECT DEPOSIT', 'bank_operation'],
    ['SERVICE FEE', 'bank_operation'],
    ['SPLIT PURCHASE', 'bank_operation'],
    ['SALARY', 'bank_operation'],
    ['OVERDRAFT FEE', 'bank_operation'],
    ['POS DEBIT', 'bank_operation'],
    // How most US card issuers describe a statement payment. Found by the
    // corpus test, not by the author: `PAYMENT` alone was in the vocabulary and
    // `THANK`/`YOU` were not, so the whole phrase resolved to a merchant.
    ['PAYMENT THANK YOU', 'bank_operation'],
    ['ONLINE PAYMENT THANK YOU', 'bank_operation'],
    ['AUTOPAY PAYMENT THANK YOU', 'bank_operation'],
    ['ENDING IN 4471', 'bank_operation'],
    // `stripNoise` already reduces these to nothing, so the gate never sees
    // them — which is the same answer by an earlier route, and the reason
    // `EMPTY` carries an abstain reason of its own.
    ['1234567', 'empty'],
    ['**** 1234', 'empty'],
    // Masked card suffixes and short digit runs survive `stripNoise` and are the
    // gate's own to refuse.
    ['XXXX4471', 'too_few_letters'],
    ['05/20/2026', 'too_few_letters'],
    ['123', 'too_few_letters'],
  ] as const)('refuses %s (%s)', (descriptor, reason) => {
    const result = normaliseMerchantName(descriptor);
    expect(result.merchantKey).toBeNull();
    expect(result.abstainReason).toBe(reason);
  });

  it('refuses a blank descriptor without inventing a display name', () => {
    expect(normaliseMerchantName('   ')).toEqual({
      key: '',
      display: '',
      merchantKey: null,
      abstainReason: 'empty',
    });
  });

  it('keeps the display readable even when it refuses identity', () => {
    // The row still has to read as something in the transaction list. Refusing
    // identity is not the same as refusing a name.
    const result = normaliseMerchantName('TRANSFER TO HIGH-YIELD SAVINGS');
    expect(result.merchantKey).toBeNull();
    expect(result.display).toBe('Transfer TO High-yield Savings');
    expect(result.key).not.toBe('');
  });
});

describe('resolveMerchantIdentity — the tier order', () => {
  const entity = [{ name: 'Blue Bottle Coffee', type: 'merchant', entityId: 'eyg8o776k0Q' }];

  it('lets the user override anything, ungated', () => {
    // "Transfer to Mum" is a payee the user wants grouped. The gate exists to
    // second-guess banks, not owners.
    const result = resolveMerchantIdentity({
      name: 'TRANSFER TO SAVINGS',
      merchantName: null,
      userMerchantName: 'Transfer to Mum',
    });
    expect(result.source).toBe('user');
    expect(result.key).toBe('transfertomum');
  });

  it('trusts a provider entity id over the text gate', () => {
    // `AMZN MKTP US*...` is gibberish as text; as an entity it is unambiguous.
    const result = resolveMerchantIdentity({
      name: 'PAYMENT THANK YOU',
      merchantName: 'Blue Bottle Coffee',
      provider: 'plaid',
      counterparties: entity,
    });
    expect(result.source).toBe('provider_entity');
    expect(result.key).toBe('bluebottlecoffee');
    expect(result.entityIds).toEqual(['plaid:eyg8o776k0Q']);
  });

  it('falls back to the counterparty name when the provider sent no merchant_name', () => {
    const result = resolveMerchantIdentity({
      name: 'SQ *BLUE BOTTLE 4471',
      merchantName: null,
      provider: 'plaid',
      counterparties: entity,
    });
    expect(result.source).toBe('provider_entity');
    expect(result.key).toBe('bluebottlecoffee');
  });

  it('gates the provider merchant_name when no entity id backs it', () => {
    const result = resolveMerchantIdentity({
      name: 'SOMETHING ELSE',
      merchantName: 'ACH TRANSFER TO SAVINGS',
    });
    expect(result.key).toBeNull();
    expect(result.source).toBe('none');
    expect(result.abstainReason).toBe('self_transfer');
  });

  it('namespaces, sorts and deduplicates entity ids, and ignores non-merchants', () => {
    const result = resolveMerchantIdentity({
      name: 'SQ *BLUE BOTTLE 4471',
      merchantName: 'Blue Bottle Coffee',
      provider: 'plaid',
      counterparties: [
        { name: 'Blue Bottle', type: 'merchant', entityId: 'zzz' },
        { name: 'Blue Bottle', type: 'merchant', entityId: 'aaa' },
        { name: 'Blue Bottle', type: 'merchant', entityId: 'zzz' },
        { name: 'Visa', type: 'financial_institution', entityId: 'visa-1' },
        { name: 'Unknown', type: null, entityId: 'ccc' },
        { name: 'No id', type: 'merchant', entityId: null },
      ],
    });
    expect(result.entityIds).toEqual(['plaid:aaa', 'plaid:ccc', 'plaid:zzz']);
  });

  it('namespaces by provider so two aggregators cannot collide', () => {
    const plaid = resolveMerchantIdentity({
      name: 'X',
      merchantName: 'Blue Bottle Coffee',
      provider: 'plaid',
      counterparties: [{ name: 'B', type: 'merchant', entityId: 'shared-id' }],
    });
    const simplefin = resolveMerchantIdentity({
      name: 'X',
      merchantName: 'Blue Bottle Coffee',
      provider: 'simplefin',
      counterparties: [{ name: 'B', type: 'merchant', entityId: 'shared-id' }],
    });
    expect(plaid.entityIds).toEqual(['plaid:shared-id']);
    expect(simplefin.entityIds).toEqual(['simplefin:shared-id']);
    // …while still being one merchant, because the *text* is the identity.
    expect(plaid.key).toBe(simplefin.key);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/** The descriptor shapes a bank actually emits, as generators. */
const merchantWord = fc.stringMatching(/^[A-Z][A-Z]{2,11}$/u);
// A "real name" is one the gate resolves on its own. The generator can emit
// operation vocabulary as a word (`ACH`, `CARD`, ...) and a name made only of
// those is refused as `bank_operation` by design, so the descriptor-style
// property below would otherwise fail on the gate doing its job rather than on
// a style stripping a name. Filtering here keeps the property about styles.
const realName = fc
  .array(merchantWord, { minLength: 1, maxLength: 3 })
  .map((words) => words.join(' '))
  .filter((name) => normaliseMerchantName(name).merchantKey !== null);
const storeNumber = fc.integer({ min: 1, max: 99_999 });
const cityState = fc.constantFrom('SEATTLE WA', 'PORTLAND OR', 'SALT LAKE CITY UT', 'AUSTIN TX');

describe('D25 properties', () => {
  it('never throws, and merchantKey is always null or exactly key', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = normaliseMerchantName(raw);
        expect(result.merchantKey === null || result.merchantKey === result.key).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('is idempotent on its own display name', () => {
    // Load-bearing: `pruneNoiseMerchants` re-runs the rule against
    // `merchants.display_name` to decide what to retire. If a name that resolved
    // once stopped resolving when fed back, the repair pass would delete the
    // merchants it had just created, every boot.
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const first = normaliseMerchantName(raw);
        if (first.display === '') return;
        const second = normaliseMerchantName(first.display);
        expect(second.merchantKey).toBe(first.merchantKey);
        expect(second.display).toBe(first.display);
      }),
      { numRuns: 2000 },
    );
  });

  it('resolves a real name through every descriptor style the corpus contains', () => {
    fc.assert(
      fc.property(realName, storeNumber, cityState, (name, number, place) => {
        for (const descriptor of [
          name,
          `SQ *${name}`,
          `TST* ${name}`,
          `${name} #${number} ${place}`,
          `${name} ${number}${number} ${place}`,
          `POS ${name}`,
          `DEBIT CARD PURCHASE ${name}`,
        ]) {
          const result = normaliseMerchantName(descriptor);
          expect(result.merchantKey).not.toBeNull();
        }
      }),
      { numRuns: 500 },
    );
  });

  it('never resolves a self-transfer, whatever the account is called', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('TRANSFER', 'XFER', 'TFR', 'TRF'),
        fc.constantFrom('TO', 'FROM'),
        realName,
        (verb, direction, account) => {
          const result = normaliseMerchantName(`${verb} ${direction} ${account}`);
          expect(result.merchantKey).toBeNull();
          expect(result.abstainReason).toBe('self_transfer');
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never resolves a bare cheque, card suffix or reference number', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_999_999 }), (number) => {
        for (const descriptor of [
          `CHECK ${number}`,
          `CHECK# ${number}`,
          `REF ${number}`,
          `XXXX${number}`,
          `**** ${number}`,
          `ENDING IN ${number}`,
          `${number}`,
        ]) {
          expect(normaliseMerchantName(descriptor).merchantKey).toBeNull();
        }
      }),
      { numRuns: 500 },
    );
  });

  it('leaves the fingerprint key exactly as it was before D25', () => {
    // The gate must not touch `key`: `dedupKeyOf` hashes it and the fuzzy
    // pending→posted matcher compares it, and collapsing two unrelated
    // transfers onto one fingerprint would hide a real transaction as a
    // cross-provider duplicate.
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = normaliseMerchantName(raw);
        expect(result.key).toBe(legacyKeyOf(result.display));
      }),
      { numRuns: 2000 },
    );
  });

  it('lets a provider entity id rescue any descriptor the text gate refuses', () => {
    fc.assert(
      fc.property(fc.string(), realName, (descriptor, merchant) => {
        const result = resolveMerchantIdentity({
          name: descriptor,
          merchantName: merchant,
          provider: 'plaid',
          counterparties: [{ name: merchant, type: 'merchant', entityId: 'e1' }],
        });
        expect(result.key).toBe(normaliseMerchantName(merchant).key);
        expect(result.source).toBe('provider_entity');
      }),
      { numRuns: 500 },
    );
  });

  it('agrees with normaliseMerchantName whenever no provider evidence exists', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const identity = resolveMerchantIdentity({ name: raw });
        const normalised = normaliseMerchantName(raw);
        expect(identity.key).toBe(normalised.merchantKey);
        expect(identity.abstainReason).toBe(normalised.abstainReason);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('merchantAbstainReasonOf', () => {
  it('is the whole gate, callable on a residue with no normalisation in front', () => {
    expect(merchantAbstainReasonOf('BLUE BOTTLE COFFEE')).toBeNull();
    expect(merchantAbstainReasonOf('TRANSFER TO SAVINGS')).toBe('self_transfer');
    expect(merchantAbstainReasonOf('CHECK')).toBe('bank_operation');
    expect(merchantAbstainReasonOf('42')).toBe('too_few_letters');
  });
});

describe('D25 tier 2 reaches the read path (regression)', () => {
  it('resolves the same key whether or not the caller is the write path', () => {
    // The defect this pins: `resolveEffective` used to run D25 without the
    // counterparties, so a descriptor whose only evidence of a payee was a
    // provider entity id got a `merchants` row from the write path and a
    // `NULL` `effective_merchant_id` from the projection — an orphan merchant,
    // which is exactly the kind of row a Phase 2 budget rule attaches to and
    // never fires on. `TransactionFact` now carries `provider` and
    // `counterparties` so both sides ask the same question.
    const input = {
      name: 'ONLINE PAYMENT',
      merchantName: null,
      provider: 'plaid',
      counterparties: [{ name: 'Blue Bottle Coffee', type: 'merchant', entityId: 'e1' }],
    } as const;

    expect(normaliseMerchantName(input.name).merchantKey).toBeNull(); // the gate refuses the text
    expect(resolveMerchantIdentity(input).key).toBe('bluebottlecoffee'); // the entity rescues it
    expect(resolveMerchantIdentity({ ...input, counterparties: null }).key).toBeNull();
  });
});
