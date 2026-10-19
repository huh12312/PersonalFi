// SPDX-License-Identifier: MIT

/** A withheld figure: the reason, in words, where the figure would be — never a zero, never a blank. */
export function Withheld({ reason }: { readonly reason: string }) {
  return (
    <p className="text-small text-text-muted" data-testid="block-withheld">
      {reason}
    </p>
  );
}
