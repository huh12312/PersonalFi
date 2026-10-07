// SPDX-License-Identifier: MIT
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Combobox, ComboboxInput } from './combobox.tsx';

describe('ComboboxInput', () => {
  it('lets Escape reach the dialog around it when its own popup is closed (2.1.1)', async () => {
    const outer = vi.fn();
    render(
      // A stand-in for the dialog's own Escape handling, which listens above the field.
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onKeyDown={(event) => outer(event.key)}>
        <Combobox items={['Coffee', 'Rent']} defaultValue="Coffee">
          <ComboboxInput aria-label="Category" />
        </Combobox>
      </div>,
    );
    const user = userEvent.setup();
    // Reached by Tab, popup closed: the state a keyboard user is in when a dialog opens on this field.
    await user.tab();
    await user.keyboard('{Escape}');
    // Base UI's own handler clears the field and stops the event when a value is selected; with the popup closed
    // that left a dialog impossible to dismiss from the keyboard while this field had focus.
    expect(outer).toHaveBeenCalledWith('Escape');
  });

  it('selects the field text on focus so typing replaces the value instead of appending to it', async () => {
    render(
      <Combobox items={['Coffee', 'Rent']} defaultValue="Coffee">
        <ComboboxInput aria-label="Category" />
      </Combobox>,
    );
    const user = userEvent.setup();
    await user.tab();
    const input = screen.getByRole('combobox', { name: 'Category' }) as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
});
