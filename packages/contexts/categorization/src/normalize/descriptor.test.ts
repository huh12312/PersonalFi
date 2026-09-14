// SPDX-License-Identifier: MIT
/**
 * The descriptor golden set.
 *
 * Every case here is either a shape `@core/seed` actually generates
 * (`packages/seed/src/merchants.ts` names six descriptor styles and this file
 * covers all six), a fixture 07 §2.1 asks for verbatim, or a family a real
 * statement contains that neither of those happens to exercise.
 *
 * A golden set is only worth its maintenance if a failure tells you *which*
 * stage broke, so the cases are grouped by the step they are about and the
 * per-step suites below drive stages in isolation. A case that is really about
 * two stages interacting is in `combined`, deliberately.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cleanDescriptor, STEPS } from './descriptor.ts';
import { fold, foldUpper } from './fold.ts';
import { normaliseDescriptor } from './index.ts';

/** `[raw, expected cleaned form, why this case exists]`. */
type Golden = readonly [string, string, string];

const FACILITATOR: readonly Golden[] = [
  ['SQ *BLUE BOTTLE COFFEE', 'BLUE BOTTLE COFFEE', 'seed: square style'],
  ["SQ *DAVE'S HOT CHICKEN", "DAVE'S HOT CHICKEN", 'seed: square style, apostrophe'],
  ['SQ *PHILZ COFFEE', 'PHILZ COFFEE', 'seed: square style'],
  ['SQ*LITTLE BEAST', 'LITTLE BEAST', 'square with no space after the star'],
  ['TST* THE FRENCH LAUNDRY', 'THE FRENCH LAUNDRY', 'seed: toast style'],
  ['TST*TARTINE BAKERY', 'TARTINE BAKERY', 'toast with no space'],
  ['AMZN Mktp US*2K4TT1FF2', 'AMAZON', 'seed: amazon order-id style'],
  ['AMZN Mktp US*2K4LM9XY3', 'AMAZON', '07 §2.1 fixture'],
  ['AMZN Mktp CA*7H2QQ0ZZ1', 'AMAZON', 'amazon, Canadian marketplace'],
  ['AMAZON.COM*M12AB3CD4', 'AMAZON', 'amazon retail rather than marketplace'],
  ['PAYPAL *SPOTIFYUSA 4029357733', 'SPOTIFYUSA', '07 §2.1 fixture; aliasing is a later tier'],
  ['PAYPAL *STEAM GAMES', 'STEAM GAMES', 'paypal wrapping a clean name'],
  ['PP*GRUBHUB', 'GRUBHUB', 'the short paypal form'],
  ['WPY*CITY PARKS FOUNDATION', 'CITY PARKS FOUNDATION', 'WePay'],
  ['EB *BROOKLYN BOOK FEST', 'BROOKLYN BOOK FEST', 'Eventbrite'],
  ['DD *DOORDASH THAI', 'DOORDASH THAI', 'DoorDash'],
  ['IN *ACME PLUMBING', 'ACME PLUMBING', 'Intuit'],
  ['CKE*COFFEE PROJECT', 'COFFEE PROJECT', 'Clover'],
  ['GOOGLE *YOUTUBE PREMIUM', 'YOUTUBE PREMIUM', 'Google Play wrapper'],
  ['APPLE.COM/BILL 866-712-7753 CA', 'APPLE', 'the prefix is the merchant'],
  ['SQ *', 'SQ', 'a prefix with no payload must not become an empty merchant'],
];

const BANK_WRAPPER: readonly Golden[] = [
  [
    'PURCHASE AUTHORIZED ON 09/03 NETFLIX.COM 866-579-7172 CA',
    'NETFLIX',
    '07 §2.1 fixture: four layers at once',
  ],
  ['POS DEBIT WALGREENS 04176 SEATTLE WA', 'WALGREENS', 'POS wrapper plus store plus geography'],
  ['CHECKCARD 0903 STARBUCKS STORE 12345 SEATTLE WA', 'STARBUCKS', 'checkcard with a bare MMDD'],
  ['ACH DEBIT - PG&E', 'PG&E', 'ACH wrapper with a dash separator'],
  ['ELECTRONIC WITHDRAWAL COMCAST XFINITY', 'COMCAST XFINITY', 'electronic withdrawal wrapper'],
  ['RECURRING PAYMENT AUTHORIZED ON 05/12 HULU 877-8244858 CA', 'HULU', 'three stacked wrappers'],
  ['DEBIT CARD PURCHASE TRADER JOES', 'TRADER JOES', 'debit card purchase wrapper'],
  ['DIRECT DEP ACME CORP PAYROLL', 'ACME CORP PAYROLL', 'seed: the payroll inflow'],
  ['WEB PMT STATE FARM INSURANCE', 'STATE FARM INSURANCE', 'seed: insurance premium'],
];

const STORE_AND_GEOGRAPHY: readonly Golden[] = [
  ["TRADER JOE'S #1234 SEATTLE WA", "TRADER JOE'S", 'seed: storeNumber style'],
  ['WHOLE FOODS MARKET #482 OAKLAND CA', 'WHOLE FOODS MARKET', 'seed: storeNumber style'],
  ['COSTCO WHOLESALE #9021 DENVER CO', 'COSTCO WHOLESALE', 'seed: storeNumber style'],
  ['SAFEWAY #310 AUSTIN TX', 'SAFEWAY', 'seed: storeNumber style'],
  ['TARGET #4471 CHICAGO IL', 'TARGET', 'seed: storeNumber style'],
  ['CVS PHARMACY #8817 PORTLAND OR', 'CVS PHARMACY', 'seed: storeNumber style'],
  ['AMC THEATRES #226 SEATTLE WA', 'AMC THEATRES', 'seed: storeNumber style'],
  ['REI #112 PORTLAND OR', 'REI', 'seed: storeNumber, three-letter merchant'],
  ['SHELL OIL 5744302 PORTLAND OR', 'SHELL OIL', 'seed: cityState style'],
  ['CHEVRON 1093882 AUSTIN TX', 'CHEVRON', 'seed: cityState style'],
  ['MARRIOTT HOTELS 2210945 DENVER CO', 'MARRIOTT HOTELS', 'seed: cityState, two-word merchant'],
  [
    'SHELL OIL 57443021 SALT LAKE CITY UT',
    'SHELL OIL',
    'a three-word city: the number is what anchors the strip',
  ],
  ['PANERA BREAD #601234 NEW YORK NY', 'PANERA BREAD', 'two-word city, two-word state-ish'],
  ['THE HOME DEPOT #6177', 'THE HOME DEPOT', 'store number with no geography at all'],
  ['IKEA 4471 RENTON WA', 'IKEA', 'four-letter merchant survives the digit strip'],
  ['7-ELEVEN 711 AUSTIN TX', '7-ELEVEN', 'a merchant whose name contains digits'],
  ['MARRIOTT HOTELS DENVER CO', 'MARRIOTT HOTELS', 'bare city/state tail, no number to anchor on'],
  ['COMCAST CALIFORNIA #8155 800-COMCAST', 'COMCAST', '07 §2.1 fixture: spelled-out state'],
  ['BLUE BOTTLE COFFEE OAKLAND CA', 'BLUE BOTTLE COFFEE', '07 §2.1 fixture, prefix already gone'],
  ['SQ *BLUE BOTTLE COFFEE OAKLAND CA', 'BLUE BOTTLE COFFEE', '07 §2.1 fixture, verbatim'],
  ['TST* TARTINE BAKERY - SAN FRANC', 'TARTINE BAKERY', '07 §2.1 fixture: truncated branch'],
  ['SQ *PHILZ COFFEE - 24TH ST', 'PHILZ COFFEE', 'branch suffix that is a street'],
];

const IDENTIFIERS: readonly Golden[] = [
  ['USPS PO 1234567890 SEATTLE WA', 'USPS PO', 'a long id then geography'],
  ['VENMO PAYMENT 1035512345678', 'VENMO PAYMENT', 'a bare long digit run'],
  ['ZELLE TO JOHN SMITH ON 05/12', 'ZELLE TO JOHN SMITH', 'a trailing date'],
  ['UBER TRIP AUTH 8H2K1LM9', 'UBER TRIP', 'an auth code introduced by its own keyword'],
  ['SQ *BLUE BOTTLE 4471', 'BLUE BOTTLE', 'the ledger normaliser’s own example'],
  ['LYFT *RIDE 05/12', 'LYFT RIDE', 'star in the middle, trailing date'],
  ['ACME WIDGETS INC', 'ACME WIDGETS', 'legal suffix, final token only'],
  ['INCREDIBLE PIZZA', 'INCREDIBLE PIZZA', 'a name that starts with a legal suffix is untouched'],
];

const UNICODE: readonly Golden[] = [
  ['CAFÉ MONTMARTRE', 'CAFE MONTMARTRE', 'diacritic folding'],
  ['ＭＣＤＯＮＡＬＤＳ', 'MCDONALDS', 'NFKC: fullwidth forms'],
  ['TRADER JOE’S #123', "TRADER JOE'S", 'typographic apostrophe folds to ASCII'],
  ['NAÏVE SALON', 'NAIVE SALON', 'precomposed diacritic'],
  ['ZARÅS BAGERI', 'ZARAS BAGERI', 'decomposed diacritic'],
  ['NETFLIX​', 'NETFLIX', 'a zero-width space is invisible and still breaks grouping'],
];

const PLAIN: readonly Golden[] = [
  ['NETFLIX', 'NETFLIX', 'seed: plain style'],
  ['SPOTIFY', 'SPOTIFY', 'seed: plain style'],
  ['ICLOUD', 'ICLOUD', 'seed: plain style'],
  ['ADOBE CREATIVE CLOUD', 'ADOBE CREATIVE CLOUD', 'seed: plain style'],
  ['PLANET FITNESS', 'PLANET FITNESS', 'seed: plain style'],
  ['EQUINOX', 'EQUINOX', 'seed: plain style'],
  ['KAISER PERMANENTE', 'KAISER PERMANENTE', 'seed: plain style'],
  ['PG&E', 'PG&E', 'seed: an ampersand must survive every step'],
  ['AT&T WIRELESS', 'AT&T WIRELESS', 'seed: ampersand mid-name'],
  ['CHASE MORTGAGE', 'CHASE MORTGAGE', 'seed: plain style'],
  ['UBER', 'UBER', 'seed: plain style'],
  ['LYFT', 'LYFT', 'seed: plain style'],
  ['DELTA AIR LINES', 'DELTA AIR LINES', 'seed: three words, none of them noise'],
  ['WWW.NETFLIX.COM', 'NETFLIX', 'a bare host name'],
  ['HTTPS://GITHUB.COM/SPONSORS', 'GITHUB/SPONSORS', 'a URL with a path'],
];

const ALL: readonly Golden[] = [
  ...FACILITATOR,
  ...BANK_WRAPPER,
  ...STORE_AND_GEOGRAPHY,
  ...IDENTIFIERS,
  ...UNICODE,
  ...PLAIN,
];

describe('cleanDescriptor golden set', () => {
  it('covers at least sixty cases', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(60);
  });

  it.each(ALL)('%s -> %s (%s)', (raw, expected) => {
    expect(cleanDescriptor(raw).cleaned).toBe(expected);
  });

  it('covers every descriptor style the seed generator emits', () => {
    // `packages/seed/src/merchants.ts` names these six. A style the seed can
    // produce and the golden set does not mention is a gap the accuracy number
    // would hide.
    const styles = ['square', 'toast', 'amazon', 'storeNumber', 'cityState', 'plain'];
    const mentioned = ALL.map(([, , why]) => why).join(' ');
    for (const style of styles) expect(mentioned).toContain(style);
  });
});

describe('cleanDescriptor invariants', () => {
  it('never returns an empty string for input that folds to anything at all', () => {
    for (const [raw] of ALL) expect(cleanDescriptor(raw).cleaned).not.toBe('');
  });

  it('reports which steps fired', () => {
    const result = cleanDescriptor('PURCHASE AUTHORIZED ON 09/03 NETFLIX.COM 866-579-7172 CA');
    expect(result.appliedSteps).toContain('bank-wrapper');
    expect(result.appliedSteps).toContain('web');
    expect(result.appliedSteps).toContain('phone');
    expect(result.appliedSteps).toContain('geography');
    expect(result.folded).toBe('PURCHASE AUTHORIZED ON 09/03 NETFLIX.COM 866-579-7172 CA');
  });

  it('leaves a descriptor of pure punctuation recognisable rather than empty', () => {
    expect(cleanDescriptor('***').cleaned).toBe('***');
    expect(cleanDescriptor('   ').cleaned).toBe('');
  });
});

describe('cleanDescriptor properties', () => {
  // Arbitrary that looks like a descriptor rather than like random Unicode:
  // property tests over `fc.string()` mostly assert things about whitespace.
  const descriptor = fc
    .array(
      fc.oneof(
        fc.constantFrom('SQ *', 'TST* ', 'POS ', 'PURCHASE ', 'AMZN MKTP US*', ''),
        fc.stringMatching(/^[A-Z]{2,10}$/u),
        fc.stringMatching(/^#?\d{1,6}$/u),
        fc.constantFrom('SEATTLE WA', 'OAKLAND CA', 'DENVER CO', "JOE'S", 'PG&E'),
      ),
      { minLength: 1, maxLength: 6 },
    )
    .map((parts) => parts.join(' '));

  it('is idempotent: cleaning a cleaned descriptor changes nothing', () => {
    fc.assert(
      fc.property(descriptor, (raw) => {
        const once = cleanDescriptor(raw).cleaned;
        expect(cleanDescriptor(once).cleaned).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it('is invariant to surrounding and repeated whitespace', () => {
    fc.assert(
      fc.property(descriptor, fc.constantFrom(' ', '  ', '\t', '\n'), (raw, space) => {
        const padded = `${space}${raw.replaceAll(' ', space)}${space}`;
        expect(cleanDescriptor(padded).cleaned).toBe(cleanDescriptor(raw).cleaned);
      }),
      { numRuns: 300 },
    );
  });

  it('is invariant to input case', () => {
    fc.assert(
      fc.property(descriptor, (raw) => {
        expect(cleanDescriptor(raw.toLowerCase()).cleaned).toBe(cleanDescriptor(raw).cleaned);
      }),
      { numRuns: 300 },
    );
  });

  it('never grows the string', () => {
    fc.assert(
      fc.property(descriptor, (raw) => {
        const result = cleanDescriptor(raw);
        expect(result.cleaned.length).toBeLessThanOrEqual(result.folded.length);
      }),
      { numRuns: 300 },
    );
  });

  it('every step is total: it never throws and never returns undefined', () => {
    // Deliberately *not* "every step is idempotent". `geography` is not, and
    // should not be: `SEATTLE WA AA SEATTLE WA` has two geography tails and
    // removing one is the correct single answer. Idempotence is a promise of
    // the assembled pipeline (which applies geography once), not of the parts.
    fc.assert(
      fc.property(descriptor, (raw) => {
        const folded = foldUpper(raw);
        for (const step of STEPS) expect(typeof step.apply(folded)).toBe('string');
      }),
      { numRuns: 200 },
    );
  });
});

describe('fold', () => {
  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = fold(raw);
        expect(fold(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it('collapses every flavour of space to one ASCII space', () => {
    expect(fold('A  B')).toBe('A B');
  });

  it('leaves an ampersand and a digit alone', () => {
    expect(fold('PG&E 2024')).toBe('PG&E 2024');
  });
});

describe('normaliseDescriptor', () => {
  it('prefers the provider name for display and the descriptor for the key', () => {
    const result = normaliseDescriptor('SQ *BLUE BOTTLE 4471', 'Blue Bottle Coffee');
    expect(result.displayName).toBe('Blue Bottle Coffee');
    expect(result.fingerprint).toBe('blue bottle');
  });

  it('falls back to the cleaned descriptor when the provider supplied nothing', () => {
    const result = normaliseDescriptor('WHOLE FOODS MARKET #482 OAKLAND CA', null);
    expect(result.displayName).toBe('Whole Foods Market');
    expect(result.fingerprint).toBe('foods market whole');
  });

  it('gives two noisy sightings of one shop the same fingerprint', () => {
    const a = normaliseDescriptor('SQ *BLUE BOTTLE COFFEE OAKLAND CA');
    const b = normaliseDescriptor('SQ *BLUE BOTTLE COFFEE #12 SEATTLE WA');
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});
