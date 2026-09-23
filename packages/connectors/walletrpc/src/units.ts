// SPDX-License-Identifier: MIT
/**
 * Smallest-unit bigints (satoshis, wei) to decimal strings.
 *
 * `ProviderHoldingFact.quantity` is a decimal string — `@core/kernel`'s
 * `Quantity` wire form — never a `number`: D3, and 18-decimal token amounts do
 * not survive `Number`'s 53-bit mantissa. This is a pure string-building
 * function over a `bigint`, so no precision is ever at risk.
 */

/** `formatUnits(123456789n, 8) === '1.23456789'`; `formatUnits(0n, 8) === '0'`. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = magnitude / divisor;
  const fraction = magnitude % divisor;

  if (fraction === 0n) {
    return `${negative ? '-' : ''}${whole.toString()}`;
  }

  const fractionDigits = fraction.toString().padStart(decimals, '0').replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole.toString()}.${fractionDigits}`;
}
