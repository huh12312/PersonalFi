// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';

import {
  assignEditorReducer,
  CLOSED_ASSIGN_EDITOR,
  isDraftValid,
  parseDraft,
} from './assign-editor.ts';

describe('assignEditorReducer', () => {
  it('opens with the server value formatted as a decimal string', () => {
    const state = assignEditorReducer(CLOSED_ASSIGN_EDITOR, {
      type: 'open',
      initial: Money.of(12345n, 'USD'),
    });
    expect(state.draft).toBe('123.45');
  });

  it('types replace the draft verbatim, including an in-progress fraction', () => {
    const state = assignEditorReducer({ draft: '10' }, { type: 'type', text: '10.' });
    expect(state.draft).toBe('10.');
  });

  it('steps by exactly $10 minor units up and down, bigint-exact', () => {
    let state = assignEditorReducer(
      { draft: '100.00' },
      { type: 'step', direction: 1, big: false, currency: 'USD' },
    );
    expect(state.draft).toBe('110.00');
    state = assignEditorReducer(state, {
      type: 'step',
      direction: -1,
      big: false,
      currency: 'USD',
    });
    expect(state.draft).toBe('100.00');
  });

  it('steps by exactly $100 with the big modifier', () => {
    const state = assignEditorReducer(
      { draft: '0.00' },
      { type: 'step', direction: 1, big: true, currency: 'USD' },
    );
    expect(state.draft).toBe('100.00');
  });

  it('stepping down below zero goes negative, never clamped or floated — a real ROLLOVER_ALLOW_NEGATIVE line can go negative', () => {
    const state = assignEditorReducer(
      { draft: '5.00' },
      { type: 'step', direction: -1, big: false, currency: 'USD' },
    );
    expect(state.draft).toBe('-5.00');
  });

  it('stepping from an unparseable draft treats it as zero rather than throwing', () => {
    const state = assignEditorReducer(
      { draft: '12.' },
      { type: 'step', direction: 1, big: false, currency: 'USD' },
    );
    expect(state.draft).toBe('10.00');
  });

  it('close returns to the closed sentinel', () => {
    expect(assignEditorReducer({ draft: '5' }, { type: 'close' })).toBe(CLOSED_ASSIGN_EDITOR);
  });
});

describe('parseDraft / isDraftValid', () => {
  it('parses an exact bigint minor-unit amount from a decimal string', () => {
    expect(parseDraft('42.10', 'USD').minor).toBe(4210n);
  });

  it('treats an empty draft as zero', () => {
    expect(parseDraft('  ', 'USD').minor).toBe(0n);
  });

  it('rejects more decimal places than the currency scale, never silently rounds', () => {
    expect(isDraftValid('1.234', 'USD')).toBe(false);
    expect(() => parseDraft('1.234', 'USD')).toThrow();
  });

  it('accepts a well-formed negative amount', () => {
    expect(isDraftValid('-10.00', 'USD')).toBe(true);
    expect(parseDraft('-10.00', 'USD').minor).toBe(-1000n);
  });
});
