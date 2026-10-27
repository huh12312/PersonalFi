// SPDX-License-Identifier: MIT
/**
 * Validating a `categorize.suggest` reply — every word the model wrote is
 * untrusted, and nothing reaches a row until it passes here (11 §4,
 * "Validation, per reply, before anything is stored").
 *
 *   * **Schema pin.** The reply is `{ suggestions: [{ transaction_ref,
 *     category_key, reason }], abstain: [transaction_ref] }` and nothing else:
 *     an extra key anywhere, a wrong type or a non-JSON reply refuses the whole
 *     batch (`schema`). The model's format option asked for this shape; asking
 *     is a convenience, never the control.
 *   * **Closed enums, at run time.** `transaction_ref` must be one this request
 *     sent (`unknown_ref`), at most once across both lists (`duplicate_ref`);
 *     `category_key` must be one of **this holder's** category keys as sent in
 *     the request (`unknown_category`). An unknown key is a refusal class,
 *     never shown — the worst a successful prompt injection can do is a wrong
 *     *suggestion*, from a list the holder wrote.
 *   * **The reason.** 1–140 characters after trimming (`reason_empty`,
 *     `reason_too_long`); no figure — no digit in any script, no number with a
 *     scale or a currency (`reason_numeral`: the app computed no figure for the
 *     model to cite, so any figure is one it made up); no link (`reason_link`);
 *     no markup or control characters (`reason_markup`); and the copy linter
 *     that every insight's prose passes (`reason_copy`: 07 §7.2's banned
 *     phrases and imperative advice).
 *   * **Every row answered.** A ref the model neither suggested nor abstained
 *     on is `missing` — recorded, not retried forever.
 *
 * Pure. The same function validates a production run, the measurement's
 * replies, the red-team corpus and the self-test's enum probe.
 */
import { lintAdviceCopy } from '../copy-lint.ts';

export const SUGGEST_REASON_MAX = 140;

export const SUGGEST_REFUSAL_CLASSES = [
  'schema',
  'unknown_ref',
  'duplicate_ref',
  'unknown_category',
  'reason_empty',
  'reason_too_long',
  'reason_numeral',
  'reason_link',
  'reason_markup',
  'reason_copy',
  'missing',
] as const;
export type SuggestRefusalClass = (typeof SUGGEST_REFUSAL_CLASSES)[number];

export interface ValidatedSuggestion {
  readonly ref: string;
  readonly categoryKey: string;
  /** Trimmed; passed every check above. */
  readonly reason: string;
}

export interface SuggestRefusal {
  /** `null` for a refusal of the whole reply. */
  readonly ref: string | null;
  readonly refusal: SuggestRefusalClass;
}

export interface SuggestValidation {
  /** `schema` when the whole reply was refused; then every ref is refused too. */
  readonly replyRefusal: 'schema' | null;
  readonly suggestions: readonly ValidatedSuggestion[];
  readonly abstained: readonly string[];
  readonly refusals: readonly SuggestRefusal[];
}

/** Any decimal digit, in any script (`\p{Nd}`), and the figure words a scale or currency makes. */
const NUMERAL = /\p{Nd}/u;
const FIGURE_WORDS =
  /\b(?:hundred|thousand|million|billion|trillion|percent|per\s*cent|dollars?|cents?|bucks)\b/iu;
const LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev)\b)/iu;
// Angle brackets, braces, backticks, markdown link/image syntax, and C0/C1 controls.
const MARKUP = /[<>{}`]|\]\(|!\[|\p{Cc}/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** The reason's own checks. `null` when it passes. */
export function reasonRefusal(raw: string): SuggestRefusalClass | null {
  const reason = raw.trim();
  if (reason.length === 0) return 'reason_empty';
  if ([...reason].length > SUGGEST_REASON_MAX) return 'reason_too_long';
  if (MARKUP.test(reason)) return 'reason_markup';
  if (NUMERAL.test(reason) || FIGURE_WORDS.test(reason)) return 'reason_numeral';
  if (LINK.test(reason)) return 'reason_link';
  if (lintAdviceCopy(reason, 'summary_md').length > 0) return 'reason_copy';
  return null;
}

export function validateSuggestReply(
  reply: unknown,
  sent: { readonly refs: readonly string[]; readonly categoryKeys: ReadonlySet<string> },
): SuggestValidation {
  const refusedAll = (): SuggestValidation => ({
    replyRefusal: 'schema',
    suggestions: [],
    abstained: [],
    refusals: [
      { ref: null, refusal: 'schema' },
      ...sent.refs.map((ref) => ({ ref, refusal: 'schema' as const })),
    ],
  });
  if (!isRecord(reply) || !exactKeys(reply, ['suggestions', 'abstain'])) return refusedAll();
  const suggestions = reply['suggestions'];
  const abstain = reply['abstain'];
  if (!Array.isArray(suggestions) || !Array.isArray(abstain)) return refusedAll();
  for (const entry of suggestions) {
    if (!isRecord(entry) || !exactKeys(entry, ['transaction_ref', 'category_key', 'reason'])) {
      return refusedAll();
    }
    if (
      typeof entry['transaction_ref'] !== 'string' ||
      typeof entry['category_key'] !== 'string' ||
      typeof entry['reason'] !== 'string'
    ) {
      return refusedAll();
    }
  }
  if (!abstain.every((entry) => typeof entry === 'string')) return refusedAll();

  const known = new Set(sent.refs);
  const seen = new Map<string, number>();
  for (const ref of [
    ...suggestions.map((entry) => (entry as Record<string, string>)['transaction_ref'] as string),
    ...(abstain as string[]),
  ]) {
    seen.set(ref, (seen.get(ref) ?? 0) + 1);
  }

  const accepted: ValidatedSuggestion[] = [];
  const abstained: string[] = [];
  const refusals: SuggestRefusal[] = [];
  const answered = new Set<string>();
  const refuse = (ref: string | null, refusal: SuggestRefusalClass): void => {
    refusals.push({ ref, refusal });
  };

  for (const raw of suggestions as Record<string, string>[]) {
    const ref = raw['transaction_ref'] as string;
    if (!known.has(ref)) {
      refuse(null, 'unknown_ref');
      continue;
    }
    if (answered.has(ref)) continue;
    answered.add(ref);
    if ((seen.get(ref) ?? 0) > 1) {
      refuse(ref, 'duplicate_ref');
      continue;
    }
    const key = raw['category_key'] as string;
    if (!sent.categoryKeys.has(key)) {
      refuse(ref, 'unknown_category');
      continue;
    }
    const reasonProblem = reasonRefusal(raw['reason'] as string);
    if (reasonProblem !== null) {
      refuse(ref, reasonProblem);
      continue;
    }
    accepted.push({ ref, categoryKey: key, reason: (raw['reason'] as string).trim() });
  }
  for (const ref of abstain as string[]) {
    if (!known.has(ref)) {
      refuse(null, 'unknown_ref');
      continue;
    }
    if (answered.has(ref)) continue;
    answered.add(ref);
    if ((seen.get(ref) ?? 0) > 1) {
      refuse(ref, 'duplicate_ref');
      continue;
    }
    abstained.push(ref);
  }
  for (const ref of sent.refs) if (!answered.has(ref)) refuse(ref, 'missing');

  return { replyRefusal: null, suggestions: accepted, abstained, refusals };
}
