// SPDX-License-Identifier: MIT
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { setHideAmounts } from '../../lib/privacy.ts';
import { Money } from './Money.tsx';

describe('Money', () => {
  afterEach(() => {
    setHideAmounts(false);
  });

  it('formats a positive amount with a leading plus sign', () => {
    render(<Money value={{ minor: '124099', currency: 'USD' }} />);
    expect(screen.getByText('+$1,240.99')).toBeInTheDocument();
  });

  it('formats a negative amount with the typographic minus sign, not a hyphen', () => {
    render(<Money value={{ minor: '-4599', currency: 'USD' }} />);
    expect(screen.getByText('−$45.99')).toBeInTheDocument();
  });

  it('colours by sign via the CVD-safe token classes, never red/green utility classes', () => {
    const { container: positive } = render(<Money value={{ minor: '100', currency: 'USD' }} />);
    expect(positive.querySelector('.text-money-pos-text')).not.toBeNull();

    const { container: negative } = render(<Money value={{ minor: '-100', currency: 'USD' }} />);
    expect(negative.querySelector('.text-money-neg-text')).not.toBeNull();
  });

  /**
   * Privacy mode blurs the amount with CSS (`.money-sensitive`, base.css) —
   * the formatted text stays in the DOM either way, since a CSS filter isn't
   * something happy-dom renders. What actually changes with `isHidden` is
   * the accessible name: the screen-reader-only span reads "Amount hidden"
   * until the same focus/hover that visually un-blurs it (deliberate — a
   * screen reader announcing the real value while it's visually blurred would
   * defeat the whole feature, see Money.tsx's doc comment).
   */
  it('reports "Amount hidden" to assistive tech until focused, then reverts on blur', () => {
    setHideAmounts(true);
    const { container } = render(<Money value={{ minor: '124099', currency: 'USD' }} />);

    const wrapper = container.querySelector('.money-sensitive');
    expect(wrapper).not.toBeNull();
    if (wrapper === null) throw new Error('unreachable');
    expect(wrapper.getAttribute('tabindex')).toBe('0');

    const srOnly = wrapper.querySelector('.sr-only');
    expect(srOnly?.textContent).toBe('Amount hidden');

    act(() => {
      (wrapper as HTMLElement).focus();
    });
    expect(srOnly?.textContent).not.toBe('Amount hidden');

    act(() => {
      (wrapper as HTMLElement).blur();
    });
    expect(srOnly?.textContent).toBe('Amount hidden');
  });

  it('never reports "Amount hidden" when the global privacy toggle is off', () => {
    const { container } = render(<Money value={{ minor: '124099', currency: 'USD' }} />);
    const wrapper = container.querySelector('.money-sensitive');
    expect(wrapper?.querySelector('.sr-only')?.textContent).not.toBe('Amount hidden');
  });
});
