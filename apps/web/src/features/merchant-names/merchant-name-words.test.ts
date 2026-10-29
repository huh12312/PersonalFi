// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { MerchantNameUnavailableReason } from './merchant-name-api.ts';
import {
  acceptedWords,
  dismissedWords,
  provenanceWords,
  shortModel,
  suggestedByWords,
  unavailableSentence,
  unavailableWords,
} from './merchant-name-words.ts';

const REASONS: readonly MerchantNameUnavailableReason[] = [
  'off',
  'not_configured',
  'hosted_narrator',
  'key_unopenable',
  'endpoint_refused',
  'advisors_disabled',
  'module_disabled',
  'kind_disabled',
  'advisor_disabled',
  'advisor_quarantined',
  'payload_not_approved',
];

describe('merchant name words (WP 11.6)', () => {
  it('shortens a model label to its name and size', () => {
    expect(shortModel('qwen2.5:7b-instruct-q4_K_M')).toBe('qwen2.5:7b');
    expect(shortModel('llama3.2:3b')).toBe('llama3.2:3b');
    expect(shortModel('llama3.2')).toBe('llama3.2');
    expect(shortModel('hf.co/org/some-model:Q4_K_M')).toBe('hf.co/org/some-model:Q4_K_M');
  });

  it('names the provider and model and says the name came from the bank’s text', () => {
    expect(suggestedByWords({ model: 'qwen2.5:7b-instruct-q4_K_M' })).toBe(
      'Suggested by the local model (qwen2.5:7b) from the bank’s text',
    );
    expect(provenanceWords({ model: 'qwen2.5:7b-instruct-q4_K_M', status: 'suggested' })).toBe(
      'Suggested by the local model (qwen2.5:7b) from the bank’s text',
    );
    expect(provenanceWords({ model: 'qwen2.5:7b-instruct-q4_K_M', status: 'accepted' })).toBe(
      'Suggested by the local model (qwen2.5:7b) from the bank’s text. You accepted it for this merchant before; this row still reads the bank’s text.',
    );
  });

  it('says what an accept and a dismiss did', () => {
    expect(acceptedWords('Ebay', 3)).toBe('Renamed 3 transactions to Ebay.');
    expect(acceptedWords('Ebay', 1)).toBe('Renamed 1 transaction to Ebay.');
    expect(acceptedWords('Ebay', 0)).toBe('No transaction needed renaming to Ebay.');
    expect(dismissedWords('Ebay')).toBe('Dismissed the name Ebay. The bank’s text stays.');
  });

  it('has a sentence for every reason, and only the ones with a switch to flip link to Advisors', () => {
    expect(unavailableSentence('payload_not_approved')).toBe(
      'No name is suggested yet: approve “Merchant name suggestions (local model)” in Advisors.',
    );
    expect(unavailableSentence('hosted_narrator')).toBe(
      'Names stay on this machine, so name suggestions run only with the local model.',
    );
    expect(unavailableSentence('off')).toBe('No local model is set up, so no name is suggested.');
    expect(unavailableSentence('not_configured')).toBe(unavailableSentence('off'));
    for (const reason of REASONS) {
      const words = unavailableWords(reason);
      expect(words.lead.length).toBeGreaterThan(10);
      const linked = [
        'payload_not_approved',
        'advisor_quarantined',
        'advisors_disabled',
        'module_disabled',
        'kind_disabled',
        'advisor_disabled',
      ].includes(reason);
      expect(words.link !== null).toBe(linked);
    }
  });

  it('never advises and never names another product', () => {
    const everything = [
      ...REASONS.map(unavailableSentence),
      acceptedWords('Ebay', 2),
      dismissedWords('Ebay'),
      provenanceWords({ model: 'qwen2.5:7b', status: 'accepted' }),
    ].join(' ');
    expect(everything).not.toMatch(/\b(should|buy|sell|recommend)/iu);
    expect(everything).not.toMatch(/openai|anthropic|chatgpt|gpt|claude|gemini/iu);
  });
});
