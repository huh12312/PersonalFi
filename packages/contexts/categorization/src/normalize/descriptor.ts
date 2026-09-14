// SPDX-License-Identifier: MIT
/**
 * Statement-descriptor cleaning.
 *
 * The full pipeline 07 §2.1 specifies, which `@ctx/ledger`'s `normaliseMerchantName`
 * deliberately does not attempt — that one is "the part Ledger cannot do without,
 * written to be obviously wrong in predictable ways", and its own header points
 * here for the real thing.
 *
 * ## The shape of the problem
 *
 * A descriptor is a merchant name with up to five layers of packaging stapled to
 * it, each added by a different party:
 *
 *     PURCHASE AUTHORIZED ON 09/03 NETFLIX.COM 866-579-7172 CA
 *     |------- the issuing bank -------|      |--- the acquirer ---|
 *
 *     SQ *BLUE BOTTLE COFFEE OAKLAND CA
 *     |-|                    |--------|
 *     the payment facilitator   geography
 *
 * Each layer is removed by a **named step**, in an order that is itself load
 * bearing, and each step is independently testable. `STEPS` is exported so a test
 * can drive one stage in isolation and so `cleanDescriptor` can return a trace of
 * what it removed — which is what the transaction detail drawer shows when a user
 * asks why we think `AMZN Mktp US*2K4TT1FF2` is Amazon.
 *
 * ## Why the order is what it is
 *
 * * Unicode folding first, or every regex below is written against the wrong
 *   alphabet (see `fold.ts`).
 * * Bank wrappers before facilitator prefixes: `PURCHASE SQ *PHILZ` has both, and
 *   the facilitator rule is anchored at the start of the string.
 * * Phone numbers and dates before bare digit runs, or `866-579-7172` becomes
 *   `866-579-` and then `-` and the trailing-punctuation rule has to guess.
 * * Geography before bare digit runs, because the most reliable signal that a
 *   tail *is* geography is that it follows a store or terminal number. Strip the
 *   number first and that signal is gone.
 * * Legal suffixes last, on the theory that `LTD` in the middle of a name is part
 *   of the name and `LTD` at the end is corporate boilerplate.
 *
 * ## The rule every step obeys
 *
 * **Only ever remove noise it can name, and never return an empty string.** If a
 * step would delete everything, the step is skipped and the previous value stands.
 * A merchant called `Blue Bottle` is a small error; a merchant called `` is a row
 * the user cannot find, cannot rename, and cannot categorise.
 */

import { foldUpper } from './fold.ts';

/** US state codes. Two letters, so the check is exact rather than fuzzy. */
const STATE_CODES: ReadonlySet<string> = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
  'PR',
  'VI',
  'GU',
]);

/**
 * Spelled-out state names, which appear where a code would be more useful —
 * `COMCAST CALIFORNIA #8155` is a real shape. Multi-word names are matched as
 * whole phrases before the single-word pass, so `NEW YORK` is not mistaken for a
 * city called `NEW` in a state called `YORK`.
 */
const STATE_NAMES: readonly string[] = [
  'NEW HAMPSHIRE',
  'NEW JERSEY',
  'NEW MEXICO',
  'NEW YORK',
  'NORTH CAROLINA',
  'NORTH DAKOTA',
  'RHODE ISLAND',
  'SOUTH CAROLINA',
  'SOUTH DAKOTA',
  'WEST VIRGINIA',
  'DISTRICT OF COLUMBIA',
  'PUERTO RICO',
  'ALABAMA',
  'ALASKA',
  'ARIZONA',
  'ARKANSAS',
  'CALIFORNIA',
  'COLORADO',
  'CONNECTICUT',
  'DELAWARE',
  'FLORIDA',
  'GEORGIA',
  'HAWAII',
  'IDAHO',
  'ILLINOIS',
  'INDIANA',
  'IOWA',
  'KANSAS',
  'KENTUCKY',
  'LOUISIANA',
  'MAINE',
  'MARYLAND',
  'MASSACHUSETTS',
  'MICHIGAN',
  'MINNESOTA',
  'MISSISSIPPI',
  'MISSOURI',
  'MONTANA',
  'NEBRASKA',
  'NEVADA',
  'OHIO',
  'OKLAHOMA',
  'OREGON',
  'PENNSYLVANIA',
  'TENNESSEE',
  'TEXAS',
  'UTAH',
  'VERMONT',
  'VIRGINIA',
  'WASHINGTON',
  'WISCONSIN',
  'WYOMING',
];

/**
 * Facilitator prefixes whose payload is the merchant. Longest first: `PAYPAL *`
 * must be tried before `PP*`, and `AMZN MKTP US*` before `AMZN MKTP`.
 *
 * The list is 07 §2.1's, which is the one assembled from real statements:
 * `SQ *` (Square), `TST*` (Toast), `PY *`/`WPY*` (WePay), `IN *` (Intuit),
 * `EB *` (Eventbrite), `DD *` (DoorDash), `CKE*` (Clover), `PP*`/`PAYPAL *`.
 */
const FACILITATOR_PREFIXES: readonly string[] = [
  'AMZN MKTP US*',
  'AMZN MKTP CA*',
  'AMZN MKTP',
  'AMAZON MKTPLACE',
  'AMAZON.COM*',
  'PAYPAL *',
  'PAYPAL*',
  'SQUARE *',
  'SQUARE*',
  'GOOGLE *',
  'GOOGLE*',
  'APPLE.COM/BILL',
  'APLPAY ',
  'MSFT *',
  'TST* ',
  'TST*',
  'SQ *',
  'SQ*',
  'WPY*',
  'CKE*',
  'EB *',
  'DD *',
  'PY *',
  'IN *',
  'PP*',
  'SP ',
  'LS ',
];

/**
 * Prefixes that *are* the merchant, because what follows them is an order id.
 * `AMZN Mktp US*2K4TT1FF2` carries no merchant name at all — strip the prefix and
 * nothing recognisable is left, so the prefix is the answer.
 */
const PREFIX_IS_THE_MERCHANT: ReadonlyMap<string, string> = new Map([
  ['AMZN MKTP US*', 'AMAZON'],
  ['AMZN MKTP CA*', 'AMAZON'],
  ['AMZN MKTP', 'AMAZON'],
  ['AMAZON MKTPLACE', 'AMAZON'],
  ['AMAZON.COM*', 'AMAZON'],
  ['APPLE.COM/BILL', 'APPLE'],
]);

/** Corporate boilerplate, stripped only when it is the final token. */
const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  'INC',
  'INCORPORATED',
  'LLC',
  'L.L.C',
  'LLP',
  'LTD',
  'LIMITED',
  'CORP',
  'CORPORATION',
  'CO',
  'COMPANY',
  'PLC',
  'GMBH',
  'SA',
  'NV',
  'BV',
  'AG',
  'PTY',
  'PTE',
  'SRL',
  'SPA',
]);

/** One named transformation. Pure, and never returns an empty string. */
export interface CleanStep {
  readonly name: string;
  readonly apply: (value: string) => string;
}

/**
 * The prefixes an *issuing bank* staples on, as opposed to the ones an acquirer
 * does. Applied repeatedly rather than once, because they genuinely stack:
 * `RECURRING PAYMENT AUTHORIZED ON 05/12 HULU` carries three of them, and a
 * single pass would have to encode every legal ordering as one regex.
 */
const BANK_WRAPPERS: readonly RegExp[] = [
  /^(?:RECURRING\s+PAYMENT|RECURRING|PREAUTH(?:ORIZED)?)\s+/u,
  /^(?:PURCHASE|POS(?:\s+DEBIT|\s+CREDIT)?|DEBIT(?:\s+CARD)?(?:\s+PURCHASE)?|CREDIT(?:\s+CARD)?|CHECKCARD|CHECK\s*CARD|VISA|MASTERCARD|AMEX|DISCOVER|CARD)\b\s*/u,
  /^(?:ACH\s+(?:DEBIT|CREDIT)|ELECTRONIC\s+(?:WITHDRAWAL|DEPOSIT)|PREAUTHORIZED\s+(?:DEBIT|CREDIT)|DIRECT\s+(?:DEBIT|DEP(?:OSIT)?)|EXTERNAL\s+(?:WITHDRAWAL|DEPOSIT)|WEB\s+(?:PMT|PAYMENT))\s*[-:]?\s*/u,
  /^AUTHORIZED\s+ON\s+\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\s*/u,
  // `CHECKCARD 0903 STARBUCKS` — a bare MMDD left behind by the rule above.
  /^\d{4}\s+(?=\D)/u,
];

function stripBankWrapper(value: string): string {
  let out = value;
  // Bounded rather than `while (changed)`: five passes is more stacking than any
  // real statement carries, and an unbounded loop over caller-supplied text is
  // one pattern change away from being a hang.
  for (let pass = 0; pass < 5; pass += 1) {
    const before = out;
    for (const wrapper of BANK_WRAPPERS) {
      const next = out.replace(wrapper, '').trim();
      if (next !== '') out = next;
    }
    if (out === before) break;
  }
  return out.trim();
}

function stripFacilitator(value: string): string {
  for (const prefix of FACILITATOR_PREFIXES) {
    if (!value.startsWith(prefix)) continue;
    const replacement = PREFIX_IS_THE_MERCHANT.get(prefix);
    if (replacement !== undefined) return replacement;
    const rest = value
      .slice(prefix.length)
      .replace(/^[\s*#:-]+/u, '')
      .trim();
    // `SQ *` with nothing usable after it is still better described by the
    // original than by an empty string.
    return rest === '' ? value : rest;
  }
  return value;
}

function stripWeb(value: string): string {
  // Strip the *scheme and host prefix* rather than the whole token: deleting all
  // of `WWW.NETFLIX.COM` leaves nothing, the empty-result guard skips the step,
  // and the descriptor keeps its `WWW.` forever. Peeling instead leaves `NETFLIX`
  // for the TLD rule below.
  let out = value.replace(/\bHTTPS?:\/\//gu, ' ').replace(/\bWWW\./gu, ' ');
  // Deleted rather than replaced with a space: the dot is already a boundary, so
  // `NETFLIX.COM` must become `NETFLIX` and `GITHUB.COM/SPONSORS` must become
  // `GITHUB/SPONSORS`, not `GITHUB /SPONSORS`.
  out = out.replace(/\.(?:COM|NET|ORG|CO\.UK|CO|IO|APP|GG|TV|ME|US|BIZ|INFO)\b/gu, '');
  return out.replace(/\s+/gu, ' ').trim();
}

/**
 * A trailing `- BRANCH` segment.
 *
 * `TST* TARTINE BAKERY - SAN FRANC` and `SQ *PHILZ COFFEE - 24TH ST` both use a
 * spaced hyphen to introduce a location that is frequently *truncated* by the
 * card network's field width — which is why the geography rules cannot catch it:
 * `SAN FRANC` is not a city name and there is no state code to anchor on.
 *
 * Bounded to three tokens, and only with a spaced hyphen: `7-ELEVEN` and
 * `WAL-MART` have no spaces around theirs and are untouched.
 */
function stripBranchSuffix(value: string): string {
  const match = /^(.+?)\s+-\s+([A-Z0-9][A-Z0-9 '.]{0,24})$/u.exec(value);
  if (match === null) return value;
  const head = (match[1] as string).trim();
  const tail = (match[2] as string).trim();
  if (head === '' || tail.split(' ').length > 3) return value;
  return head;
}

function stripPhone(value: string): string {
  let out = value;
  // 800-555-1212, 800.555.1212, (800) 555-1212, +1 800 555 1212.
  out = out.replace(/\+?\d{0,2}\s*\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/gu, ' ');
  // Vanity numbers: 800-COMCAST, 877-FLOWERS.
  out = out.replace(/\b\d{3}-[A-Z]{4,}\b/gu, ' ');
  // Bare toll-free runs: 8005551212.
  out = out.replace(/\b(?:800|833|844|855|866|877|888)\d{7}\b/gu, ' ');
  return out.replace(/\s+/gu, ' ').trim();
}

function stripDatesAndAuth(value: string): string {
  let out = value;
  out = out.replace(/\b(?:ON\s+)?\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/gu, ' ');
  out = out.replace(/\b\d{4}-\d{2}-\d{2}\b/gu, ' ');
  out = out.replace(
    /\b(?:AUTH|REF|TRACE|ARN|SEQ|CONF|INV|ORDER|TXN|TRN|ID)\s*#?\s*[A-Z0-9]{4,}\b/gu,
    ' ',
  );
  out = out.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu, ' ');
  return out.replace(/\s+/gu, ' ').trim();
}

function stripStoreAndPos(value: string): string {
  let out = value;
  out = out.replace(/\s*#\s*\d+[A-Z]?\b/gu, ' ');
  out = out.replace(
    /\b(?:STORE|STR|SHOP|UNIT|LOC|LOCATION|TERM|TERMINAL|LANE|REG|POS)\s*#?\s*\d+\b/gu,
    ' ',
  );
  // `T-1234`, `Q39`, `F4471` — terminal identifiers glued to a letter.
  out = out.replace(/\b[A-Z]-\d{2,}\b/gu, ' ');
  return out.replace(/\s+/gu, ' ').trim();
}

/**
 * Remove a trailing `... CITY STATE`.
 *
 * Two passes, and the first is the safe one:
 *
 *   1. **After a number.** `COSTCO WHSE #1234 SEATTLE WA` and `SHELL OIL 5744302
 *      PORTLAND OR` both put the geography after a store or terminal number, so
 *      the number marks where the merchant name stopped. Everything from the
 *      number to the end goes, however many words the city has — which is how
 *      `SALT LAKE CITY UT` survives a rule that would otherwise eat `LAKE CITY`
 *      and leave `SALT`.
 *   2. **Bare tail.** No number to anchor on, so at most three words of city are
 *      removed along with the state, and only when at least one token is left.
 *      `MARRIOTT HOTELS DENVER CO` becomes `MARRIOTT HOTELS`, not `MARRIOTT`.
 *
 * A state code alone at the end is dropped in either case. The conservative half
 * of this — "never strip so much that nothing remains" — is enforced by the
 * caller, not repeated in each branch.
 */
const STATE_CODE_ALTERNATION = [...STATE_CODES].join('|');

/**
 * `... 1234 SALT LAKE CITY UT` — geography introduced by a store or terminal
 * number, optionally behind the keyword that labels it.
 *
 * This is the only pattern that can safely remove a *multi-word* city, because
 * the number marks exactly where the merchant name stopped. Every other pass has
 * to guess, and guesses one word.
 */
const GEOGRAPHY_AFTER_NUMBER = new RegExp(
  String.raw`\s+(?:STORE|STR|SHOP|UNIT|LOC|LOCATION|TERM|TERMINAL|LANE|REG|POS)?\s*#?\d{2,}[A-Z]?\s+[A-Z][A-Z '.-]*\s+(?:${STATE_CODE_ALTERNATION})\s*$`,
  'u',
);

/** A trailing store number, which can sit *after* the geography it follows. */
const TRAILING_STORE_NUMBER = /\s*#\s*\d+[A-Z]?\s*$/u;

const SPELLED_STATE_TAIL = new RegExp(
  String.raw`\s+(?:[A-Z][A-Z'.-]*\s+){0,3}(?:${STATE_NAMES.join('|')})\s*$`,
  'u',
);

function stripGeography(value: string): string {
  // Pass 1: a number anchors the strip, so any number of city words may go.
  if (GEOGRAPHY_AFTER_NUMBER.test(value)) {
    const stripped = value.replace(GEOGRAPHY_AFTER_NUMBER, '').trim();
    if (stripped !== '') return stripped;
  }

  // A trailing `#8155` sits between us and the tail in `COMCAST CALIFORNIA
  // #8155`. Look past it, but hand the number itself back to `store-pos` — this
  // step's job is geography, and a step that quietly did two things would make
  // the trace lie about which rule fired.
  const suffix = TRAILING_STORE_NUMBER.exec(value)?.[0] ?? '';
  const head = suffix === '' ? value : value.slice(0, value.length - suffix.length).trim();
  if (head === '') return value;

  // Pass 2: a spelled-out state name, with up to three words of city before it.
  const spelled = head.replace(SPELLED_STATE_TAIL, '').trim();
  if (spelled !== '' && spelled !== head) return `${spelled}${suffix}`;

  // Pass 3: a two-letter state code, with **at most one** word of city.
  //
  // One, not three, and this is the conservative half of the whole file: with no
  // number to anchor on there is nothing in the string that says how long the
  // city name is, and three words of greed turns `WHOLE FOODS MARKET OAKLAND CA`
  // into `WHOLE`. Under-stripping leaves `MARRIOTT HOTELS DENVER` for a user to
  // rename once; over-stripping merges two merchants and loses history.
  const tokens = head.split(' ').filter((token) => token !== '');
  const last = tokens.at(-1);
  if (last === undefined || !STATE_CODES.has(last)) return value;

  for (const cityWords of [1, 0]) {
    const remaining = tokens.length - 1 - cityWords;
    if (remaining < 1) continue;
    return `${tokens.slice(0, remaining).join(' ')}${suffix}`;
  }
  return value;
}

function stripIdentifiers(value: string): string {
  let out = value;
  // A trailing mixed-alphanumeric run of 6+ that contains a digit: an order id
  // (`2K4TT1FF2`). Requiring a digit is what keeps `MARRIOTT` and `SAFEWAY`.
  out = out.replace(/\s+(?=[A-Z0-9]*\d)[A-Z0-9]{6,}\s*$/gu, ' ');
  // Bare digit runs of four or more, anywhere. Four rather than three so
  // `7-ELEVEN 711` and `CHEVRON 76` survive.
  out = out.replace(/\b\d{4,}\b/gu, ' ');
  // A trailing short digit run is a store number by another name.
  out = out.replace(/\s+\d{1,3}\s*$/gu, ' ');
  return out.replace(/\s+/gu, ' ').trim();
}

function stripLegalSuffix(value: string): string {
  const tokens = value.split(' ').filter((token) => token !== '');
  if (tokens.length < 2) return value;
  const last = (tokens.at(-1) as string).replace(/[.,]/gu, '');
  if (!LEGAL_SUFFIXES.has(last)) return value;
  return tokens.slice(0, -1).join(' ');
}

function tidy(value: string): string {
  return value
    .replaceAll(/[*#|~^_]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .replace(/^[\s,.:;/\\-]+/u, '')
    .replace(/[\s,.:;/\\-]+$/u, '')
    .trim();
}

/**
 * The pipeline, in order, as data.
 *
 * Exported so `descriptor.test.ts` can assert one stage at a time and so the
 * trace `cleanDescriptor` returns names the step that did the removing rather
 * than reporting one opaque before/after pair.
 */
export const STEPS: readonly CleanStep[] = Object.freeze([
  { name: 'bank-wrapper', apply: stripBankWrapper },
  { name: 'facilitator', apply: stripFacilitator },
  { name: 'web', apply: stripWeb },
  { name: 'phone', apply: stripPhone },
  { name: 'date-auth', apply: stripDatesAndAuth },
  // Geography before store numbers, not after: the number is what tells this
  // step where the merchant name stopped, and removing it first throws away the
  // only evidence that `SALT LAKE CITY` is a city rather than three more words
  // of merchant.
  { name: 'geography', apply: stripGeography },
  { name: 'store-pos', apply: stripStoreAndPos },
  { name: 'branch-suffix', apply: stripBranchSuffix },
  { name: 'identifier', apply: stripIdentifiers },
  { name: 'tidy', apply: tidy },
  { name: 'legal-suffix', apply: stripLegalSuffix },
]);

export interface CleanedDescriptor {
  /** Upper case, noise removed. The input to fingerprinting. */
  readonly cleaned: string;
  /** The folded, upper-cased original, before any step ran. */
  readonly folded: string;
  /** Which steps changed the string, oldest first. The explainability trail. */
  readonly appliedSteps: readonly string[];
}

/**
 * Run every step, skipping any that would empty the string.
 *
 * The skip is the safety property, and it is checked per step rather than once at
 * the end: a step that empties the value is a step whose pattern was too greedy
 * for *this* input, and letting it run and then restoring from a backup would
 * also discard the correct work of every step before it.
 */
export function cleanDescriptor(raw: string): CleanedDescriptor {
  const folded = foldUpper(raw);
  let current = folded;
  const appliedSteps: string[] = [];

  // Run to a fixed point, not once.
  //
  // Removing one layer routinely exposes another that is anchored at the start
  // of the string and therefore could not match before: `0000 0000 AMZN MKTP
  // US*2K4` only *becomes* a facilitator prefix once the leading batch id is
  // gone. Iterating is also what makes the whole function idempotent — the
  // result is by construction a string no step will change again — and
  // `descriptor.test.ts` asserts that as a property rather than trusting it.
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const before = current;
    for (const step of STEPS) {
      const next = step.apply(current);
      if (next === '' || next === current) continue;
      current = next;
      if (!appliedSteps.includes(step.name)) appliedSteps.push(step.name);
    }
    if (current === before) break;
  }

  return { cleaned: current === '' ? folded : current, folded, appliedSteps };
}

/**
 * Four is empirically two more than any real descriptor needs, and a bound
 * rather than `while (changed)` because this runs on caller-supplied text.
 */
const MAX_PASSES = 4;
