// SPDX-License-Identifier: MIT
/**
 * Merchant name suggestions, in words (WP 11.6). Pure functions over the api's shapes, so every sentence the chip
 * and the note can say is tested without rendering. None of them advises: they say what was suggested, by what, from
 * what, and what happens when it is accepted.
 */
import type { MerchantNameSuggestion, MerchantNameUnavailableReason } from './merchant-name-api.ts';

/**
 * A model's label as a holder reads it: "qwen2.5:7b-instruct-q4_K_M" -> "qwen2.5:7b". The tag after the colon keeps
 * its size and drops the variant and quantisation; a label with no tag is kept whole.
 */
export function shortModel(model: string): string {
  const colon = model.indexOf(':');
  if (colon === -1) return model;
  const tag = model.slice(colon + 1);
  const size = tag.split('-')[0] ?? tag;
  return `${model.slice(0, colon)}:${size === '' ? tag : size}`;
}

/** "Suggested by the local model (qwen2.5:7b) from the bank’s text". */
export function suggestedByWords(suggestion: Pick<MerchantNameSuggestion, 'model'>): string {
  return `Suggested by the local model (${shortModel(suggestion.model)}) from the bank’s text`;
}

/** The chip's second line: where the name came from, and for an accepted one why it is shown again. */
export function provenanceWords(
  suggestion: Pick<MerchantNameSuggestion, 'model' | 'status'>,
): string {
  return suggestion.status === 'accepted'
    ? `${suggestedByWords(suggestion)}. You accepted it for this merchant before; this row still reads the bank’s text.`
    : suggestedByWords(suggestion);
}

/** "Renamed 3 transactions to Ebay" / "Renamed 1 transaction to Ebay". */
export function acceptedWords(name: string, renamed: number): string {
  if (renamed === 0) return `No transaction needed renaming to ${name}.`;
  return `Renamed ${String(renamed)} ${renamed === 1 ? 'transaction' : 'transactions'} to ${name}.`;
}

export function dismissedWords(name: string): string {
  return `Dismissed the name ${name}. The bank’s text stays.`;
}

export const ADVISOR_NAME = 'Merchant name suggestions (local model)';

export interface UnavailableWords {
  /** Said before the link, or the whole sentence when there is none. */
  readonly lead: string;
  /** The link's text (it goes to Advisors), or `null`. */
  readonly link: string | null;
  /** Said after the link. */
  readonly tail: string;
}

/** Why no name is suggested for a merchant, in one short sentence. */
export function unavailableWords(reason: MerchantNameUnavailableReason): UnavailableWords {
  switch (reason) {
    case 'payload_not_approved':
      return {
        lead: `No name is suggested yet: approve “${ADVISOR_NAME}” in `,
        link: 'Advisors',
        tail: '.',
      };
    case 'hosted_narrator':
      return {
        lead: 'Names stay on this machine, so name suggestions run only with the local model.',
        link: null,
        tail: '',
      };
    case 'off':
    case 'not_configured':
      return {
        lead: 'No local model is set up, so no name is suggested.',
        link: null,
        tail: '',
      };
    case 'key_unopenable':
    case 'endpoint_refused':
      return {
        lead: 'The local model cannot be reached, so no name is suggested.',
        link: null,
        tail: '',
      };
    case 'advisor_quarantined':
      return {
        lead: 'Name suggestions are paused after repeated failures; see ',
        link: 'Advisors',
        tail: '.',
      };
    case 'advisors_disabled':
    case 'module_disabled':
    case 'kind_disabled':
    case 'advisor_disabled':
      return {
        lead: 'Name suggestions are switched off; they can be switched on in ',
        link: 'Advisors',
        tail: '.',
      };
  }
}

/** The note as one string (for an accessible description and for tests). */
export function unavailableSentence(reason: MerchantNameUnavailableReason): string {
  const words = unavailableWords(reason);
  return `${words.lead}${words.link ?? ''}${words.tail}`;
}
