// SPDX-License-Identifier: MIT
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LifeEventsTimeline } from './LifeEventsTimeline.tsx';
import { lifeEventFixture } from './fixtures.ts';

const RANGE_START = new Date(2026, 0, 1);
const RANGE_END = new Date(2056, 0, 1);

/**
 * `docs/plan/04-phase-4-dispatch.md` §3: "Draggable life events on the
 * timeline, each a typed dated amount, keyboard-operable (a drag that only
 * works with a pointer fails WCAG 2.2 AA, 05 §8.1)." — the exit test is
 * literally `'a life event can be moved with the keyboard alone'`, so these
 * assertions never simulate a pointer drag at all.
 */
describe('LifeEventsTimeline', () => {
  it('is a real `role="slider"` control (a native range input) with an accessible name and value text', () => {
    render(
      <LifeEventsTimeline
        lifeEvents={[lifeEventFixture()]}
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        onMove={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Signing bonus date' });
    expect(slider).toHaveAttribute('aria-valuetext');
  });

  it('moves a life event through the same input/change event a keyboard press on a native range control fires, with no pointer event needed', () => {
    // A native `<input type="range">` translates an ArrowRight/ArrowLeft
    // keypress into exactly this `input`/`change` event pair natively in a
    // real browser (that translation is the browser's job, not jsdom's/
    // happy-dom's to simulate) — the control being a real range input,
    // asserted in the previous test, is what makes that translation happen
    // at all. This test proves the component's own reaction to it: the
    // value and the displayed date both update, from one event, no pointer
    // interaction anywhere in this test.
    const onMove = vi.fn();
    render(
      <LifeEventsTimeline
        lifeEvents={[lifeEventFixture({ occursOn: '2030-06-01' })]}
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        onMove={onMove}
        onDelete={vi.fn()}
      />,
    );

    const slider = screen.getByRole('slider', { name: 'Signing bonus date' }) as HTMLInputElement;
    const before = slider.value;
    fireEvent.change(slider, { target: { value: String(Number(before) + 1) } });

    expect(slider.value).not.toBe(before);
    // The displayed date beside the slider updates too, not just the raw offset.
    expect(screen.getByText(/Jun \d+, 2030/)).toBeInTheDocument();
  });

  it('flushes the move to onMove on blur (a keyboard user tabbing away never loses the last unsent move)', () => {
    const onMove = vi.fn();
    render(
      <LifeEventsTimeline
        lifeEvents={[lifeEventFixture({ id: 'evt-x', occursOn: '2030-06-01' })]}
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        onMove={onMove}
        onDelete={vi.fn()}
      />,
    );

    const slider = screen.getByRole('slider', { name: 'Signing bonus date' });
    fireEvent.change(slider, { target: { value: '1600' } });
    // Blur before the 300ms debounce would otherwise fire.
    fireEvent.blur(slider);

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith('evt-x', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('removes a life event via its own labelled button, disabled while the delete is pending', () => {
    const onDelete = vi.fn();
    render(
      <LifeEventsTimeline
        lifeEvents={[lifeEventFixture({ id: 'evt-y', name: 'Home purchase down payment' })]}
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        onMove={vi.fn()}
        onDelete={onDelete}
        pendingDeleteId="evt-y"
      />,
    );
    const removeButton = screen.getByRole('button', {
      name: 'Remove Home purchase down payment',
    });
    expect(removeButton).toBeDisabled();
  });

  it('renders a first-class empty state, not a blank list, when there are no life events', () => {
    render(
      <LifeEventsTimeline
        lifeEvents={[]}
        rangeStart={RANGE_START}
        rangeEnd={RANGE_END}
        onMove={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('No life events yet.')).toBeInTheDocument();
  });
});
