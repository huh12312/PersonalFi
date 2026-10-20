// SPDX-License-Identifier: MIT
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { ActiveProviderForm } from './ActiveProviderForm.tsx';
import { ControlChecksSection } from './ControlChecksSection.tsx';
import { NarratorProviderCard } from './NarratorProviderCard.tsx';
import { NARRATOR_PROVIDERS, useNarratorSettingsQuery } from './narrator-api.ts';

/**
 * Settings › Language model (WP 10.6, decision D30). Chris's request: "i want to make the LLM setup available in
 * the setting as well. ideally options include ollama/openai/openrouter/anthropic options where you can bring your
 * own api key for use."
 *
 * The narrator's provider as a radio group (Ollama, OpenAI, OpenRouter, Anthropic, Off), then one card per
 * provider: its consent (hosted), its key, its model, and Test. Every write asks for the passkey. Nothing on this
 * screen can show a key: the api returns its last four characters at most. Below the cards, the controls self-test
 * (WP 10.16, `ControlChecksSection`).
 */
export function NarratorSettingsSection() {
  const query = useNarratorSettingsQuery();

  return (
    <section
      aria-labelledby="narrator-settings-heading"
      className="flex flex-col gap-4"
      data-testid="narrator-settings"
    >
      <div className="flex flex-col gap-1">
        <h2 id="narrator-settings-heading" className="text-h3 text-text-primary">
          Language model
        </h2>
        <p className="text-small text-text-muted">
          A language model can word the Brief&apos;s findings; every figure stays the Brief&apos;s
          own. Run one yourself with Ollama, or bring your own OpenAI, OpenRouter or Anthropic key.
        </p>
        {query.data !== undefined && (
          <p className="text-small text-text-muted">
            What leaves this machine for a hosted provider: {query.data.whatLeaves}. You see the
            exact payload, and approve it, before anything is sent.
          </p>
        )}
      </div>

      {query.isLoading ? (
        <SkeletonText lines={4} />
      ) : query.data === undefined ? (
        <p className="text-small text-text-secondary">
          The language-model settings cannot be read right now. Try again in a moment.
        </p>
      ) : (
        <>
          <ActiveProviderForm settings={query.data} />
          <div className="grid gap-3 lg:grid-cols-2">
            {NARRATOR_PROVIDERS.map((provider) => {
              const state = query.data.providers.find((p) => p.provider === provider);
              if (state === undefined) return null;
              return <NarratorProviderCard key={provider} settings={query.data} state={state} />;
            })}
          </div>
          <ControlChecksSection />
        </>
      )}
    </section>
  );
}
