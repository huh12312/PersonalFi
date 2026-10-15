// SPDX-License-Identifier: MIT
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NarratedSummary, narrationBadgeLabel } from './NarrationBadge.tsx';

/**
 * WP 10.6: the Brief's narration badge names the provider and model from `narration.narratedBy`; without it the
 * badge keeps its plain "AI-assisted wording".
 */
describe('the narration badge names who wrote the wording (WP 10.6)', () => {
  it('names each provider and its model, and falls back to "AI-assisted wording"', () => {
    expect(narrationBadgeLabel({ provider: 'anthropic', model: 'claude-sonnet-5-5' })).toBe(
      'Narrated by Anthropic claude-sonnet-5-5',
    );
    expect(narrationBadgeLabel({ provider: 'openai', model: 'gpt-6.1-sol' })).toBe(
      'Narrated by OpenAI gpt-6.1-sol',
    );
    expect(
      narrationBadgeLabel({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' }),
    ).toBe('Narrated by OpenRouter anthropic/claude-sonnet-5.5');
    expect(narrationBadgeLabel({ provider: 'ollama', model: 'qwen2.5:7b-instruct-q4_K_M' })).toBe(
      'Narrated by the local model qwen2.5:7b-instruct-q4_K_M',
    );
    expect(narrationBadgeLabel(null)).toBe('AI-assisted wording');
    expect(narrationBadgeLabel(undefined)).toBe('AI-assisted wording');
  });

  it('the shown wording carries the named badge', () => {
    render(
      <NarratedSummary
        templateSummaryMd="You paid $720 in avoidable fees."
        narration={{
          status: 'narrated',
          aiAssisted: true,
          textShown: true,
          summaryMd: 'Fee hunter found $720.',
          narratedBy: { provider: 'openai', model: 'gpt-6.1-sol' },
        }}
      />,
    );
    expect(screen.getByText('Narrated by OpenAI gpt-6.1-sol')).toBeInTheDocument();
    expect(screen.queryByText('AI-assisted wording')).not.toBeInTheDocument();
  });

  it('the withheld wording carries the named badge too', () => {
    render(
      <NarratedSummary
        templateSummaryMd="You paid $720 in avoidable fees."
        narration={{
          status: 'narrated',
          aiAssisted: true,
          textShown: false,
          summaryMd: null,
          narratedBy: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
        }}
      />,
    );
    expect(screen.getByTestId('narration-withheld')).toHaveTextContent(
      'Narrated by OpenRouter anthropic/claude-sonnet-5.5',
    );
  });

  it('a narration with no narrator named keeps "AI-assisted wording"', () => {
    render(
      <NarratedSummary
        templateSummaryMd="You paid $720 in avoidable fees."
        narration={{
          status: 'narrated',
          aiAssisted: true,
          textShown: true,
          summaryMd: 'Fee hunter found $720.',
          narratedBy: null,
        }}
      />,
    );
    expect(screen.getByText('AI-assisted wording')).toBeInTheDocument();
  });
});
