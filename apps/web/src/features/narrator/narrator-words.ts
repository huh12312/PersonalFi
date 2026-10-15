// SPDX-License-Identifier: MIT
/**
 * Settings › Language model, in words (WP 10.6). Pure functions over the settings shape, so every sentence the
 * section can say is tested without rendering anything - and so no state is ever shown by colour alone.
 */
import type {
  NarratorChoice,
  NarratorProvider,
  NarratorProviderState,
  NarratorSettings,
  NotReadyReason,
} from './narrator-api.ts';
import { isHosted } from './narrator-api.ts';

const NAMES: Readonly<Record<NarratorProvider, string>> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
};

/** The short name: "Ollama", "OpenAI", "OpenRouter", "Anthropic". */
export function providerName(provider: NarratorProvider): string {
  return NAMES[provider];
}

/** What the radio for each choice reads. */
export function choiceLabel(choice: NarratorChoice): string {
  if (choice === 'off') return 'Off';
  if (choice === 'ollama') return 'Ollama (local)';
  return NAMES[choice];
}

/** "Anthropic claude-sonnet-5-5", or "the local model qwen2.5:7b-instruct-q4_K_M". */
export function modelPhrase(provider: NarratorProvider, model: string | null): string {
  if (provider === 'ollama') return model === null ? 'the local model' : `the local model ${model}`;
  return model === null ? NAMES[provider] : `${NAMES[provider]} ${model}`;
}

/** Why a provider cannot narrate, as the end of a sentence. */
export function notReadyWords(provider: NarratorProvider, reason: NotReadyReason): string {
  switch (reason) {
    case 'off':
      return 'the narrator is off';
    case 'not_configured':
      return provider === 'ollama'
        ? 'no local model is configured (set an endpoint, model name and digest on the Ollama card, or have the operator pin one)'
        : `${NAMES[provider]} is not configured`;
    case 'consent_required':
      return `its consent is not ticked (tick it on the ${NAMES[provider]} card)`;
    case 'key_missing':
      return `it has no key (save one on the ${NAMES[provider]} card)`;
    case 'key_unopenable':
      return 'its stored key cannot be opened by this install (save the key again)';
    case 'endpoint_refused':
      return "its endpoint is refused by this install's egress policy";
    default:
      return String(reason);
  }
}

/** The one sentence at the top: what narrates now, or why nothing does. */
export function activeSentence(settings: NarratorSettings): string {
  const choice = settings.activeProvider;
  if (choice === 'off') return 'Off: the Brief shows its own wording.';
  if (settings.active.ready) {
    return `Narrating with ${modelPhrase(choice, settings.active.model)}.`;
  }
  const reason = settings.active.notReady ?? 'not_configured';
  return `${choiceLabel(choice)} is chosen but not narrating: ${notReadyWords(choice, reason)}. The Brief shows its own wording until then.`;
}

/**
 * Why a choice cannot be made active yet, or `null` when it can. A hosted provider needs its consent ticked AND a
 * key (the operator's file or a stored one); the local model needs a model, from the environment or set here.
 */
export function choiceBlocker(
  choice: NarratorChoice,
  providers: readonly NarratorProviderState[],
): string | null {
  if (choice === 'off') return null;
  const state = providers.find((p) => p.provider === choice);
  if (state === undefined) return `${choiceLabel(choice)} is not offered by this install.`;
  if (isHosted(choice)) {
    const consented = state.consent?.given === true;
    const keyed = state.key.source !== 'none';
    if (!consented && !keyed) {
      return `Tick ${NAMES[choice]}'s consent and save a key on its card first.`;
    }
    if (!consented) return `Tick ${NAMES[choice]}'s consent on its card first.`;
    if (!keyed) return `Save a ${NAMES[choice]} key on its card first.`;
    return null;
  }
  return state.model.value === null
    ? 'Set an endpoint, model name and digest on the Ollama card first, or have the operator pin one.'
    : null;
}

/** The sentence after a switch that withdrew the narrator's standing payload approvals. */
export function approvalsWithdrawnLead(settings: NarratorSettings): string {
  const choice = settings.activeProvider;
  const under = choice === 'off' ? 'the new provider' : modelPhrase(choice, settings.active.model);
  return `The narrator's payload approval was withdrawn: approve the payload again under ${under} in`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
