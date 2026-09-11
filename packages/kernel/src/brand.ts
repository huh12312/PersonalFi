// SPDX-License-Identifier: MIT
declare const brandTag: unique symbol;

/**
 * Nominal typing helper. `Brand<string, 'AccountId'>` is assignable to `string`
 * but a plain `string` is not assignable to it, so ids cannot be crossed.
 */
export type Brand<TBase, TTag extends string> = TBase & { readonly [brandTag]: TTag };
