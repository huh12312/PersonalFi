// SPDX-License-Identifier: MIT
/**
 * The egress guard, **re-exported from `@core/platform`**. No logic lives here.
 *
 * WP 2.4 wrote the guard in this file. WP 3.4 added the second egress surface
 * — market data on a 03:45 schedule — and 03-phase-3-dispatch.md §5 requires
 * the allow-list machinery to be "**reused, not reimplemented**", with an exit
 * test that fails if the second context forks it. `personalfi/layer-imports`
 * denies `@ctx/integrations` -> `@ctx/notifications`, so the only way two
 * contexts can share one module is for it to live in the layer below both.
 *
 * So the implementation moved to `@core/platform/src/egress/policy.ts` (a `git
 * mv`, so `--follow` still reaches WP 2.4) and this file is the seam that keeps
 * every WP 2.4 call site and every WP 2.4 test importing the same path they
 * always did. The move changed one type: `Destination.scheme` and
 * `EgressPolicy.allowedSchemes` are `string` rather than `ChannelScheme`,
 * because the substrate must not know what a notification channel is. Nothing
 * is loosened by that — this context still constructs its policy with
 * `allowedSchemes: ['https', 'smtps', 'smtp+starttls']` and `checkDestination`
 * still refuses everything outside the list — and `channel.ts`'s zod schemas
 * remain the place a *channel's* scheme is narrowed to those three.
 *
 * **Do not add logic to this file.** A refusal added here and not in
 * `@core/platform` would be a refusal the market-data adapters do not have, and
 * the divergence would be invisible: both suites would still be green.
 */
export {
  createEgressPolicy,
  checkDestination,
  checkUrl,
  guardDestination,
  guardUrl,
  classifyAddress,
  classifyStatus,
  isPublicAddress,
  looksLikeIpLiteral,
  normaliseHost,
  assertHeaderValueSafe,
  systemResolver,
  EgressRefusedError,
  isEgressRefusedError,
  DENY_ALL_POLICY,
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  REFUSAL_CODES,
  type AddressClass,
  type Destination,
  type DestinationInput,
  type EgressDecision,
  type EgressPolicy,
  type EgressPolicyInput,
  type RefusalCode,
  type Resolver,
  type StatusVerdict,
} from '@core/platform';
