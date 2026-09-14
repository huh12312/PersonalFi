// SPDX-License-Identifier: MIT
/**
 * Merchant normalisation, assembled.
 *
 * `normaliseDescriptor` is the one call the rest of the context makes. Everything
 * under this directory is a stage of it, and each stage is exported too because
 * the golden tests drive them individually — a pipeline whose stages can only be
 * tested end to end is a pipeline where a fix to one regex is a guess.
 *
 * The relationship to `@ctx/ledger`'s `normaliseMerchantName()` is deliberate and
 * worth stating plainly, because two normalisers in one codebase is otherwise a
 * smell: Ledger's runs on the *write* path of every sync page and produces the
 * `effective_name` and the merchant grouping key that the list query and the
 * transfer heuristics need, so it must be fast, total, and unsurprising. This one
 * runs in the categorisation consumer, is allowed to be an order of magnitude
 * more thorough, and feeds the merchant profile and the classifier. They agree on
 * the easy cases by construction — both start from the same descriptor — and
 * where they differ, Ledger's answer is what the user sees in the list and this
 * one's is what the engine reasons about.
 *
 * An earlier draft of this header promised a `merchant-agreement.test.ts` in
 * this package pinning the cases where the two must not diverge. **It cannot
 * live here**: asserting agreement means calling `@ctx/ledger`'s normaliser, and
 * `personalfi/layer-imports` denies one context importing another — correctly,
 * and not a rule worth an exception for a test. The cases the two *must* agree
 * on are the ones `descriptor.test.ts` pins on this side (the seed generator's
 * six descriptor styles, which `@ctx/ledger`'s `normalise.test.ts` pins on its
 * own), and a genuine cross-context comparison belongs in `apps/api`, the one
 * layer allowed to see both. Deferred, and recorded in
 * `docs/evidence/phase-1/wp1.4-categorization.md` rather than left as a promise
 * in a comment.
 */

export { fold, foldUpper } from './fold.ts';
export { fingerprint, ngramFingerprint } from './fingerprint.ts';
export { boundedLevenshtein, similarity } from './distance.ts';
export { cleanDescriptor, STEPS, type CleanStep, type CleanedDescriptor } from './descriptor.ts';
export {
  chooseCanonicalName,
  clusterDescriptors,
  editBudget,
  titleCase,
  MAX_EDIT_DISTANCE,
  MIN_FUZZY_LENGTH,
  type DescriptorObservation,
  type MerchantCluster,
} from './cluster.ts';

import { cleanDescriptor } from './descriptor.ts';
import { fingerprint } from './fingerprint.ts';
import { titleCase } from './cluster.ts';

export interface NormalisedDescriptor {
  /** Upper case, noise removed. */
  readonly cleaned: string;
  /** Sorted, deduplicated token key. The grouping key. */
  readonly fingerprint: string;
  /** What a human reads. */
  readonly displayName: string;
  /** Which cleaning steps fired, for the evidence trail. */
  readonly appliedSteps: readonly string[];
}

/**
 * Clean one descriptor and key it.
 *
 * `providerName`, when supplied, replaces the *display* name but not the
 * fingerprint: 07 §2.1's provider shortcut says prefer the aggregator's clean
 * merchant name and use our own pipeline "as the fallback and as a cross-check".
 * Keying on the descriptor either way is what keeps the cross-check meaningful —
 * if the fingerprint came from the provider's name too, a provider that renamed a
 * merchant mid-history would silently split it into two.
 */
export function normaliseDescriptor(
  raw: string,
  providerName?: string | null,
): NormalisedDescriptor {
  const cleaned = cleanDescriptor(raw);
  const provider = providerName?.trim();
  const displaySource = provider !== undefined && provider !== '' ? provider : cleaned.cleaned;

  return {
    cleaned: cleaned.cleaned,
    fingerprint: fingerprint(cleaned.cleaned),
    displayName: titleCase(displaySource),
    appliedSteps: cleaned.appliedSteps,
  };
}
