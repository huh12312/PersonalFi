// SPDX-License-Identifier: MIT
/**
 * Parameter citations, in Insights' vocabulary (WP 11.5a; 12 §2.2).
 *
 * The parameter store is Planning's — WP 4.2's cited, hashed assumptions file,
 * with a stable key per cited node (`@ctx/planning`'s `parameters.ts`:
 * `tax.us.2026.retirement.elective_deferral`). 08 §1.6's arrows point down:
 * `@ctx/insights` may not import `@ctx/planning`, so this port is declared
 * here and bound at the composition root
 * (`apps/api/src/knowledge-base.ts#createKnowledgeParameterPort`), the
 * arrangement `brief/ports.ts` uses for the retirement solver. The shapes below
 * mirror Planning's `ParameterCitation` field for field; the binding's test
 * proves the conversion is the identity over every key in the file.
 *
 * Rendering a value into prose lives here, because prose is Insights' concern:
 * a playbook page's `{{param:…}}` placeholder is replaced with
 * `renderParameter`'s text at read time, so a page never states a limit it
 * typed in.
 */

export interface ParameterMoney {
  /** Minor units as a decimal string. Never a `number` (08 §6.5). */
  readonly minor: string;
  readonly currency: string;
}

export type ParameterValue =
  | { readonly kind: 'money'; readonly value: ParameterMoney }
  | {
      readonly kind: 'moneyRange';
      readonly value: { readonly from: ParameterMoney; readonly to: ParameterMoney };
    }
  | { readonly kind: 'rate'; readonly value: string }
  | { readonly kind: 'rateRange'; readonly value: { readonly from: string; readonly to: string } }
  | { readonly kind: 'integer'; readonly value: string }
  | {
      readonly kind: 'fraction';
      readonly value: { readonly numerator: string; readonly denominator: string };
    }
  | { readonly kind: 'index'; readonly value: string }
  | { readonly kind: 'fact'; readonly value: string }
  | {
      readonly kind: 'brackets';
      readonly value: readonly { readonly over: ParameterMoney; readonly rate: string }[];
    }
  | {
      readonly kind: 'ageSchedule';
      readonly value: readonly {
        readonly bornFrom: string;
        readonly bornThrough: string | null;
        readonly age: string;
      }[];
    }
  | {
      readonly kind: 'correlation';
      readonly value: {
        readonly assets: readonly string[];
        readonly matrix: readonly (readonly string[])[];
      };
    };

/** One cited node of the parameter store, by key. Mirrors `@ctx/planning`'s `ParameterCitation`. */
export type ParameterCitation = ParameterValue & {
  readonly key: string;
  readonly source: string;
  readonly asOf: string;
  readonly note?: string;
  readonly attribution?: string;
  readonly effective?: string;
  readonly unit?: string;
  readonly basis?: string;
  /** The assumptions file version the node was read from (`sha256:…`). */
  readonly parametersVersion: string;
};

export type ParameterLookup =
  | { readonly found: true; readonly citation: ParameterCitation }
  | {
      readonly found: false;
      /** `year_unavailable`: a `tax.us.<year>` key for a year the store does not hold — never substituted. */
      readonly reason: 'unknown' | 'year_unavailable';
      readonly detail: string;
    };

/** The parameter store, read-only, by key. Bound at the composition root. */
export interface ParameterPort {
  /** Never throws for a key that names nothing: it says why instead. */
  get(key: string): ParameterLookup;
}

/** The key grammar, the same as Planning's `PARAMETER_KEY_PATTERN`. */
export const PARAMETER_KEY_PATTERN =
  /^(?:tax\.us\.\d{4}|assumptions)(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/;

const TAX_YEAR_KEY = /^tax\.us\.(\d{4})\./;

/** `1234567` → `1,234,567`. Digits only in, digits only out. */
function grouped(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `$24,500` for whole dollars, `$18.99` otherwise. USD only: the store holds nothing else. */
export function renderMoney(amount: ParameterMoney): string | null {
  if (amount.currency !== 'USD' || !/^\d+$/.test(amount.minor)) return null;
  const padded = amount.minor.padStart(3, '0');
  const whole = padded.slice(0, -2).replace(/^0+(?=\d)/, '');
  const cents = padded.slice(-2);
  return cents === '00' ? `$${grouped(whole)}` : `$${grouped(whole)}.${cents}`;
}

/** `'0.038'` → `'3.8%'`, `'0.0393'` → `'3.93%'`, `'0.08'` → `'8%'`. Exact: a string shift, no float. */
export function renderRate(rate: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(rate);
  if (match === null) return null;
  const [, sign = '', whole = '0', fraction = ''] = match;
  const digits = `${whole}${fraction.padEnd(2, '0')}`;
  const point = whole.length + 2;
  const integer = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  const decimals = digits.slice(point).replace(/0+$/, '');
  return `${sign}${integer}${decimals === '' ? '' : `.${decimals}`}%`;
}

/**
 * The prose a `{{param:…}}` placeholder becomes. A tax-year node carries its
 * year, so a page read in 2027 still says which year's limit it states.
 * `null` for a kind with no inline form (a table, a schedule, a fraction, a
 * fact): a page cites those through a source marker, never a placeholder, and
 * the generator refuses one in a placeholder.
 */
export function renderParameter(citation: ParameterCitation): string | null {
  let text: string | null;
  switch (citation.kind) {
    case 'money':
      text = renderMoney(citation.value);
      break;
    case 'moneyRange': {
      const from = renderMoney(citation.value.from);
      const to = renderMoney(citation.value.to);
      text = from === null || to === null ? null : `${from}–${to}`;
      break;
    }
    case 'rate':
      text = renderRate(citation.value);
      break;
    case 'rateRange': {
      const from = renderRate(citation.value.from);
      const to = renderRate(citation.value.to);
      text = from === null || to === null ? null : `${from}–${to}`;
      break;
    }
    case 'integer':
    case 'index':
      text = citation.value;
      break;
    default:
      text = null;
  }
  if (text === null) return null;
  const year = TAX_YEAR_KEY.exec(citation.key)?.[1];
  return year === undefined ? text : `${text} (tax year ${year})`;
}

/** `$24,500` → the forms a narration may write it in: `24500` and `24500.00`. */
function moneyFigures(amount: ParameterMoney): readonly string[] {
  const rendered = renderMoney(amount);
  if (rendered === null) return [];
  const plain = rendered.replace(/[$,]/g, '');
  return plain.includes('.') ? [plain] : [plain, `${plain}.00`];
}

function rateFigures(rate: string): readonly string[] {
  const rendered = renderRate(rate);
  return rendered === null ? [] : [rendered];
}

/**
 * Every figure a sent parameter licenses a narration to write, in the
 * numeral check's normalised form (`24500`, `3.8%`) — its value as the app
 * renders it (and a tax-year node's year, which its rendering prints), and
 * nothing derived from it. Exported for the citation validator and the evidence.
 */
export function parameterFigures(citation: ParameterCitation): readonly string[] {
  const year = TAX_YEAR_KEY.exec(citation.key)?.[1];
  return year === undefined ? valueFigures(citation) : [...valueFigures(citation), year];
}

function valueFigures(citation: ParameterCitation): readonly string[] {
  switch (citation.kind) {
    case 'money':
      return moneyFigures(citation.value);
    case 'moneyRange':
      return [...moneyFigures(citation.value.from), ...moneyFigures(citation.value.to)];
    case 'rate':
      return rateFigures(citation.value);
    case 'rateRange':
      return [...rateFigures(citation.value.from), ...rateFigures(citation.value.to)];
    case 'integer':
    case 'index':
      return [citation.value];
    case 'brackets':
      return citation.value.flatMap((row) => [...moneyFigures(row.over), ...rateFigures(row.rate)]);
    case 'ageSchedule':
      return citation.value.flatMap((row) => [
        row.bornFrom,
        row.age,
        ...(row.bornThrough === null ? [] : [row.bornThrough]),
      ]);
    case 'fraction':
    case 'fact':
    case 'correlation':
      return [];
  }
}
