// SPDX-License-Identifier: MIT
/**
 * The HTTP transport, **re-exported from `@core/platform`**. No logic here.
 *
 * It moved with the guard it belongs to — see `src/egress.ts` in this package
 * for why, and `@core/platform/src/egress/transport.ts` for the four safety
 * properties (connect to a validated address not a name, never follow a
 * redirect, bound the body while it arrives, two timers rather than one).
 *
 * The transport deliberately contains no policy, which is what lets
 * `test/egress-allowlist.test.ts` point it at a real local server answering 302
 * and observe that the redirect target is never contacted — without the test
 * needing a switch that turns a security control off. That property is now
 * shared by `@ctx/integrations`' market-data adapters too.
 */
export {
  createNodeTransport,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from '@core/platform';
