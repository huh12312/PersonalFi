// SPDX-License-Identifier: MIT
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { BriefNarration } from '../../api/generated/types.gen.ts';
import { BriefNarrationHeader, BriefRecap, wordedByLabel } from './BriefNarrationHeader.tsx';

/**
 * WP 11.4 (G5-15): the Brief's header — its deterministic opening always, the composed narration of the week's
 * ranked actions under it, and "Your week" at the top — in each state the api names.
 */
const OPENING =
  '2 ranked actions this week, in order of dollar impact. The largest is “Avoidable fees this year”, $720.00 a year.';

function narration(over: Partial<BriefNarration>): BriefNarration {
  return {
    state: 'unavailable',
    text: null,
    recap: null,
    narratedBy: null,
    refusal: null,
    message: null,
    ...over,
  };
}

const SHOWN = narration({
  state: 'shown',
  text: 'Avoidable fees this year leads the week at $720.00 a year, then Idle cash at $310.00 a year.',
  recap: 'A week of 2 ranked actions and a health score of 72.5 / 100.',
  narratedBy: { provider: 'ollama', model: 'qwen2.5:7b-instruct-q4_K_M' },
});

function Header({ value }: { value: BriefNarration | undefined }) {
  return (
    <div>
      <h2>This week&apos;s Brief</h2>
      <BriefRecap narration={value} />
      <BriefNarrationHeader
        opening={OPENING}
        {...(value === undefined ? {} : { narration: value })}
      />
    </div>
  );
}

describe('the Brief’s own wording (WP 11.4)', () => {
  it('names who wrote it: each provider and its model, or a language model when unnamed', () => {
    expect(wordedByLabel({ provider: 'anthropic', model: 'claude-sonnet-5-5' })).toBe(
      'Worded by Anthropic claude-sonnet-5-5',
    );
    expect(wordedByLabel({ provider: 'openai', model: 'gpt-6.1' })).toBe(
      'Worded by OpenAI gpt-6.1',
    );
    expect(wordedByLabel({ provider: 'openrouter', model: 'x/y' })).toBe(
      'Worded by OpenRouter x/y',
    );
    expect(wordedByLabel({ provider: 'ollama', model: 'qwen2.5:7b' })).toBe(
      'Worded by the local model qwen2.5:7b',
    );
    expect(wordedByLabel(null)).toBe('Worded by a language model');
  });

  it('shown: the recap at the top and the narration under the opening, each badged and labelled', () => {
    render(<Header value={SHOWN} />);
    const recap = screen.getByRole('region', { name: 'Your week' });
    expect(within(recap).getByTestId('brief-recap-text')).toHaveTextContent(SHOWN.recap ?? '');
    expect(within(recap).getByTestId('brief-recap-badge')).toHaveTextContent(
      'Worded by the local model qwen2.5:7b-instruct-q4_K_M',
    );
    expect(within(recap).getByText('AI-assisted wording')).toBeVisible();
    expect(screen.getByTestId('brief-opening')).toHaveTextContent(OPENING);
    const region = screen.getByTestId('brief-narration');
    expect(region).toHaveAttribute('data-state', 'shown');
    expect(within(region).getByTestId('brief-narration-text')).toHaveTextContent(SHOWN.text ?? '');
    expect(within(region).getByTestId('brief-narration-badge')).toHaveTextContent(
      'Worded by the local model qwen2.5:7b-instruct-q4_K_M',
    );
    expect(within(region).getByText('AI-assisted wording')).toBeVisible();
    // The opening precedes the narration; the recap precedes both.
    const order = [screen.getByTestId('brief-recap'), screen.getByTestId('brief-opening'), region];
    for (let index = 1; index < order.length; index += 1) {
      expect(
        order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('the text is plain text: Markdown stays literal', () => {
    render(<Header value={{ ...SHOWN, text: 'A **bold** claim.', recap: '_also_ literal' }} />);
    expect(screen.getByTestId('brief-narration-text').textContent).toBe('A **bold** claim.');
    expect(screen.getByTestId('brief-recap-text').textContent).toBe('_also_ literal');
    expect(document.querySelector('strong, em')).toBeNull();
  });

  it('refused: the api’s words, the opening stands, no narration text and no recap', () => {
    const message =
      "An AI-assisted wording of this week's Brief didn't pass the app's checks, so it is not shown.";
    render(
      <Header
        value={narration({
          state: 'refused',
          refusal: 'numeral',
          message,
          narratedBy: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        })}
      />,
    );
    expect(screen.getByTestId('brief-opening')).toHaveTextContent(OPENING);
    expect(screen.getByTestId('brief-narration')).toHaveAttribute('data-state', 'refused');
    expect(screen.getByTestId('brief-narration-message')).toHaveTextContent(message);
    expect(screen.queryByTestId('brief-narration-text')).toBeNull();
    expect(screen.queryByTestId('brief-recap')).toBeNull();
    expect(screen.queryByText('AI-assisted wording')).toBeNull();
  });

  it('pending and unavailable: the api’s words, muted; nothing else', () => {
    const { unmount } = render(
      <Header
        value={narration({ state: 'pending', message: 'An AI-assisted wording may follow.' })}
      />,
    );
    expect(screen.getByTestId('brief-narration')).toHaveAttribute('data-state', 'pending');
    expect(screen.getByTestId('brief-narration-message')).toHaveClass('text-text-muted');
    expect(screen.queryByTestId('brief-recap')).toBeNull();
    unmount();
    render(<Header value={narration({ state: 'unavailable', message: 'The model is Off.' })} />);
    expect(screen.getByTestId('brief-narration')).toHaveAttribute('data-state', 'unavailable');
    expect(screen.getByTestId('brief-narration-message')).toHaveTextContent('The model is Off.');
    expect(screen.getByTestId('brief-opening')).toBeVisible();
  });

  it('an older response without the fields: the opening only if present, no narration region', () => {
    render(<BriefNarrationHeader />);
    expect(screen.queryByTestId('brief-opening')).toBeNull();
    expect(screen.queryByTestId('brief-narration')).toBeNull();
  });

  it('adds no heading and nothing focusable: the outline and the Tab order are unchanged', () => {
    render(<Header value={SHOWN} />);
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      "This week's Brief",
    ]);
    expect(document.querySelectorAll('a, button, input, [tabindex]')).toHaveLength(0);
  });
});
