// SPDX-License-Identifier: MIT
/**
 * WP 11.6: which merchants are **noise** — a descriptor the deterministic
 * normaliser could only partly clean, so the name a holder reads is still the
 * bank's residue (`Ebayinc`, `Whlfds Mkt`, `Cko*patreon* Membership`).
 *
 * Only a noise merchant may ever be put to the `merchant.name` query type (a
 * local model's display-name suggestion). Everything here is pure, total and
 * deterministic, and it extends the normaliser's own rules rather than
 * replacing them:
 *
 *   1. **D25 first.** `resolveMerchantIdentity(...).key === null` — the rule
 *      `pruneNoiseMerchants` applies — means the descriptor names a banking
 *      operation (`CHECK 1234`, `TRANSFER TO SAVINGS`), not a payee. There is no
 *      merchant to name and no `normalized_key` to key a suggestion on, and a
 *      model asked to name `CHECK` could only invent. Never noise.
 *   2. **The provider spoke.** When the identity came from the provider's own
 *      merchant name or entity (`provider_name`, `provider_entity`), the display
 *      is the provider's cleaned name, not the residue. Never noise.
 *   3. **The shape table** below, over the normaliser's residue (the display a
 *      holder reads). A descriptor matching none of it is clean — the default,
 *      as everywhere in this module's family: a rule here only ever names noise
 *      it can name.
 *
 * What the table deliberately does not try: a cleanly truncated word (`STARBUCKS
 * COF`). A suggestion must be a substring-preserving cleanup — it may drop, never
 * complete — so a model could only cut the stub, and guessing which short word
 * is a stub needs a dictionary this module does not carry.
 */
import {
  processorPrefixOf,
  resolveMerchantIdentity,
  type MerchantIdentityInput,
} from './normalise.ts';

export type MerchantNoiseShape =
  | 'processor_star'
  | 'hash_token'
  | 'reference_marker'
  | 'domain_tail'
  | 'vowelless_run'
  | 'run_together'
  | 'processor_squashed';

export interface MerchantNoiseShapeDefinition {
  readonly shape: MerchantNoiseShape;
  /** What it catches, in words (the evidence prints this table). */
  readonly rule: string;
  /** A residue it matches, as the holder reads it. */
  readonly example: string;
}

/** The shape table. Order is the order `noiseShapesOf` reports matches in. */
export const MERCHANT_NOISE_SHAPES: readonly MerchantNoiseShapeDefinition[] = Object.freeze([
  {
    shape: 'processor_star',
    rule: 'a `*` is still in the residue: a processor or aggregator wrapper the prefix table does not know',
    example: 'Cko*patreon* Membership',
  },
  {
    shape: 'hash_token',
    rule: 'a token of 6+ letters and digits with at least two of each: an order id or a hash',
    example: 'Ebay 2K4TT1FF2',
  },
  {
    shape: 'reference_marker',
    rule: 'a reference word (REF, TXN, TRX, INV, ORDER, ORD, CONF, TRACE, ID) beside at least one other word',
    example: 'Netflix Ref Xk2',
  },
  {
    shape: 'domain_tail',
    rule: 'a token that is a web address or a path: `.COM`, `.NET`, `.ORG`, `.CO`, `.IO`, `.APP`, or a `/`',
    example: 'Apple.com/bill',
  },
  {
    shape: 'vowelless_run',
    rule: 'a token of 5+ letters with no vowel (A, E, I, O, U, Y): an abbreviation a terminal made',
    example: 'Whlfds Mkt',
  },
  {
    shape: 'run_together',
    rule: 'the whole residue is one token of 12+ letters: words run together',
    example: 'Bluebottlecoffee',
  },
  {
    shape: 'processor_squashed',
    rule: 'a processor prefix was stripped and what is left is one token of 6+ letters',
    example: 'PAYPAL * → Ebayinc',
  },
] satisfies readonly MerchantNoiseShapeDefinition[]);

const REFERENCE_MARKERS = new Set([
  'REF',
  'REFNO',
  'TXN',
  'TRX',
  'INV',
  'ORDER',
  'ORD',
  'CONF',
  'TRACE',
  'ID',
]);
const DOMAIN = /\.(?:COM|NET|ORG|CO|IO|APP)\b|\//iu;
const HASH_TOKEN = /^(?=(?:[^0-9]*[0-9]){2})(?=(?:[^A-Z]*[A-Z]){2})[A-Z0-9]{6,}$/u;
const VOWEL = /[AEIOUY]/u;

/** The residue's whitespace tokens, upper-cased, with their alphanumeric core. */
function tokensOf(residue: string): readonly { readonly raw: string; readonly core: string }[] {
  return residue
    .toUpperCase()
    .split(/\s+/u)
    .filter((raw) => raw !== '')
    .map((raw) => ({ raw, core: raw.replaceAll(/[^A-Z0-9]/gu, '') }));
}

/**
 * The shapes a residue matches, in table order; empty when it is clean.
 * `processor_squashed` needs the raw descriptor and is only reported by
 * `detectMerchantNoise`.
 */
export function noiseShapesOf(residue: string): readonly MerchantNoiseShape[] {
  const tokens = tokensOf(residue);
  const shapes: MerchantNoiseShape[] = [];
  if (residue.includes('*')) shapes.push('processor_star');
  if (tokens.some((token) => HASH_TOKEN.test(token.core))) shapes.push('hash_token');
  if (
    tokens.length >= 2 &&
    tokens.some((token) => REFERENCE_MARKERS.has(token.core)) &&
    tokens.some((token) => token.core !== '' && !REFERENCE_MARKERS.has(token.core))
  ) {
    shapes.push('reference_marker');
  }
  if (tokens.some((token) => DOMAIN.test(token.raw))) shapes.push('domain_tail');
  if (
    tokens.some((token) => {
      const letters = token.core.replaceAll(/[^A-Z]/gu, '');
      return letters.length >= 5 && letters === token.core && !VOWEL.test(letters);
    })
  ) {
    shapes.push('vowelless_run');
  }
  if (tokens.length === 1 && /^[A-Z]{12,}$/u.test(tokens[0]?.raw ?? ''))
    shapes.push('run_together');
  return shapes;
}

/**
 * The pre-screen over a stored `merchants.display_name`: every display a noise
 * verdict can come from passes it (the shapes, plus the one-word residue that
 * `processor_squashed` needs the raw descriptor to confirm). Never a verdict on
 * its own — `detectMerchantNoise` over the bank's text is.
 */
export function mayBeNoise(display: string): boolean {
  if (noiseShapesOf(display).length > 0) return true;
  const tokens = tokensOf(display);
  return tokens.length === 1 && /^[A-Z]{6,}$/u.test(tokens[0]?.raw ?? '');
}

export type MerchantNoiseVerdict =
  | {
      readonly noise: false;
      /** Why not: no payee (D25), the provider named it, or the residue is clean. */
      readonly reason: 'no_merchant' | 'provider_named' | 'clean';
      readonly key: string | null;
    }
  | {
      readonly noise: true;
      /** The merchant's `normalized_key`: what a suggestion is keyed and deduplicated on. */
      readonly key: string;
      /** The normaliser's residue as the holder reads it: the descriptor `merchant.name` is sent. */
      readonly descriptor: string;
      /** The processor prefix the normaliser stripped (`PAYPAL *`), or `null`. Holder-visible. */
      readonly strippedPrefix: string | null;
      readonly shapes: readonly MerchantNoiseShape[];
    };

/**
 * The detector. Takes a transaction's provider facts — **never** the holder's
 * `user_merchant_name`: a renamed payee is the holder's word, and the question is
 * what the bank sent.
 */
export function detectMerchantNoise(
  input: Omit<MerchantIdentityInput, 'userMerchantName'>,
): MerchantNoiseVerdict {
  const identity = resolveMerchantIdentity({ ...input, userMerchantName: null });
  if (identity.key === null) return { noise: false, reason: 'no_merchant', key: null };
  if (identity.source !== 'descriptor') {
    return { noise: false, reason: 'provider_named', key: identity.key };
  }
  const strippedPrefix = processorPrefixOf(input.name);
  const shapes = [...noiseShapesOf(identity.display)];
  const tokens = tokensOf(identity.display);
  if (
    strippedPrefix !== null &&
    tokens.length === 1 &&
    /^[A-Z]{6,}$/u.test(tokens[0]?.raw ?? '') &&
    !shapes.includes('run_together')
  ) {
    shapes.push('processor_squashed');
  }
  if (shapes.length === 0) return { noise: false, reason: 'clean', key: identity.key };
  return {
    noise: true,
    key: identity.key,
    descriptor: identity.display,
    strippedPrefix,
    shapes,
  };
}
