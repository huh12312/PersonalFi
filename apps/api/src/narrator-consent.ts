// SPDX-License-Identifier: MIT
/**
 * The consent a holder gives before a hosted provider may narrate (WP 10.6;
 * decision D30). The text is shown beside a checkbox in Settings, Language
 * model; the checkbox must be ticked before the provider can be made active,
 * and `narrator_provider_consents` records the version and the sha256 of the
 * exact text ticked. Changing a word of it is a new version: every standing
 * consent then stops counting (`createNarratorStores` reads only the current
 * version), the active hosted provider stops narrating, and the holder is
 * asked again.
 */
import {
  HOSTED_DISPLAY_NAMES,
  HOSTED_MODEL_HOSTS,
  type HostedProvider,
} from '@advisor/local-model';
import { sha256 } from '@core/secretbox';

export const NARRATOR_CONSENT_VERSION = 'narrator-consent/1';

/** What leaves the machine — the brief's own words, verbatim. */
export const NARRATOR_CONSENT_WHAT_LEAVES =
  'Brief findings: aggregated amounts, bucketed, merchants pseudonymised — never a transaction, never an account number';

export function narratorConsentText(provider: HostedProvider): string {
  return (
    `Send the narrator's payload to ${HOSTED_DISPLAY_NAMES[provider]} (${HOSTED_MODEL_HOSTS[provider]}) ` +
    `with my own key. What leaves this machine: ${NARRATOR_CONSENT_WHAT_LEAVES}. ` +
    'I see the exact payload before anything is sent, and approve it first. ' +
    `${HOSTED_DISPLAY_NAMES[provider]}'s own terms apply to what it receives.`
  );
}

export function narratorConsentSha256(provider: HostedProvider): string {
  const digest = sha256(new TextEncoder().encode(narratorConsentText(provider)));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
