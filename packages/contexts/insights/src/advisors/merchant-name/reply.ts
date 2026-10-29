// SPDX-License-Identifier: MIT
/**
 * Validating a `merchant.name` reply — the whole point of the query type (11
 * §3.1: "the suggestion must be a substring-preserving cleanup, validated as
 * such, not an invention"). Every word the model wrote is untrusted; nothing is
 * stored as a suggestion until it passes here, and anything else is a refusal
 * with a named class.
 *
 *   * **Schema pin.** The reply is exactly `{ display_name: string }` or exactly
 *     `{ abstain: string }`. An extra key, both keys, a wrong type or a non-JSON
 *     reply is `schema`. An abstention is recorded as such (`abstained`) and the
 *     model's reason is never stored or shown.
 *   * **The name's own checks**, in this order: `name.empty` (nothing but
 *     whitespace or punctuation), `name.too_long` (over 40 characters),
 *     `name.markup` (angle brackets, braces, backticks, square brackets, `*`,
 *     `#`, `|`, `\`, `_`, `~`, `^`, `=` or a control character), `name.link`
 *     (a scheme, `www.`, or a web domain), `name.digits_only` (every word is a
 *     number), `name.copy` (the insight copy linter's banned phrases and merchant
 *     pseudonyms).
 *   * **Substring preservation.** Case-fold both sides and split them into
 *     alphanumeric tokens. Every token of the name must equal, or be a prefix
 *     of, a token of the descriptor, and the tokens it matches must come in the
 *     descriptor's order, each descriptor token used at most once. A name token
 *     that is no descriptor token's prefix anywhere is `name.invented` (a brand
 *     or a word the bank never sent); one that is, but only out of order or
 *     already spent, is `name.out_of_order`.
 *   * **Something changed.** A name equal to the descriptor itself, ignoring
 *     case and spacing, is `name.unchanged`: it would offer the holder nothing.
 *
 * Pure. The same function validates a production run, the golden set, the
 * red-team corpus and the self-test's fixed reply.
 */
import { lintAdviceCopy } from '../copy-lint.ts';
import { MERCHANT_NAME_MAX } from './manifest.ts';

export const MERCHANT_NAME_REFUSAL_CLASSES = [
  'schema',
  'name.empty',
  'name.too_long',
  'name.markup',
  'name.link',
  'name.digits_only',
  'name.copy',
  'name.invented',
  'name.out_of_order',
  'name.unchanged',
] as const;
export type MerchantNameRefusalClass = (typeof MERCHANT_NAME_REFUSAL_CLASSES)[number];

export type MerchantNameVerdict =
  | { readonly verdict: 'suggested'; readonly displayName: string }
  | { readonly verdict: 'abstained' }
  | { readonly verdict: 'refused'; readonly refusal: MerchantNameRefusalClass };

const MARKUP = /[<>{}`[\]*#|\\_~^=]|\p{Cc}/u;
const LINK =
  /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev|us)\b)/iu;

/** Case-folded alphanumeric tokens, in order. */
export function nameTokensOf(text: string): readonly string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== '');
}

/**
 * `null` when every token of `name` is, in order, a token or a token-prefix of
 * `descriptor` (each descriptor token used at most once); else which rule broke.
 */
export function substringPreservationRefusal(
  name: string,
  descriptor: string,
): 'name.invented' | 'name.out_of_order' | null {
  const wanted = nameTokensOf(name);
  const offered = nameTokensOf(descriptor);
  const fits = (candidate: string, token: string): boolean =>
    candidate === token || candidate.startsWith(token);
  let next = 0;
  for (const token of wanted) {
    let found = -1;
    for (let index = next; index < offered.length; index += 1) {
      if (fits(offered[index] ?? '', token)) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      return offered.some((candidate) => fits(candidate, token))
        ? 'name.out_of_order'
        : 'name.invented';
    }
    next = found + 1;
  }
  return null;
}

function collapse(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim().toLowerCase();
}

/** The name's own checks and substring preservation. `null` when it passes. */
export function merchantNameRefusal(
  raw: string,
  descriptor: string,
): MerchantNameRefusalClass | null {
  const name = raw.replaceAll(/\s+/gu, ' ').trim();
  const tokens = nameTokensOf(name);
  if (name === '' || tokens.length === 0) return 'name.empty';
  if ([...name].length > MERCHANT_NAME_MAX) return 'name.too_long';
  if (MARKUP.test(name)) return 'name.markup';
  if (LINK.test(name)) return 'name.link';
  if (tokens.every((token) => /^\p{N}+$/u.test(token))) return 'name.digits_only';
  if (lintAdviceCopy(name, 'evidence_label').length > 0) return 'name.copy';
  const preserved = substringPreservationRefusal(name, descriptor);
  if (preserved !== null) return preserved;
  if (collapse(name) === collapse(descriptor)) return 'name.unchanged';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateMerchantNameReply(
  reply: unknown,
  sent: { readonly descriptor: string },
): MerchantNameVerdict {
  if (!isRecord(reply)) return { verdict: 'refused', refusal: 'schema' };
  const keys = Object.keys(reply);
  if (keys.length !== 1) return { verdict: 'refused', refusal: 'schema' };
  if (keys[0] === 'abstain') {
    return typeof reply['abstain'] === 'string'
      ? { verdict: 'abstained' }
      : { verdict: 'refused', refusal: 'schema' };
  }
  if (keys[0] !== 'display_name' || typeof reply['display_name'] !== 'string') {
    return { verdict: 'refused', refusal: 'schema' };
  }
  const refusal = merchantNameRefusal(reply['display_name'], sent.descriptor);
  if (refusal !== null) return { verdict: 'refused', refusal };
  return {
    verdict: 'suggested',
    displayName: reply['display_name'].replaceAll(/\s+/gu, ' ').trim(),
  };
}
