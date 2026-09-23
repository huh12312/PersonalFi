// SPDX-License-Identifier: MIT
/**
 * Market data's egress binding. **This is the security surface of WP 3.4.**
 *
 * 03-phase-3-dispatch.md §5 names the risk precisely: *"Market data is the
 * second egress surface, and the first one that runs on a schedule with no
 * human present. An SSRF here reaches `db:5432` and the container metadata
 * endpoint on a timer."* The control it names is equally precise: *"the WP 2.4
 * allow-list machinery **reused, not reimplemented**."*
 *
 * So there is no guard in this file. Every refusal — scheme, host, port,
 * literal IP, private/link-local/loopback range, DNS re-check against
 * rebinding, redirect, body cap, timeout, header control characters — comes
 * from `@core/platform`'s `egress/policy.ts`, which is the module WP 2.4 wrote
 * and `@ctx/notifications` still uses (it moved down a layer in this WP; `git
 * log --follow` reaches WP 2.4, and the notifications file is now a re-export
 * with no logic in it). `test/shared-allowlist.test.ts` fails if that ever
 * stops being true.
 *
 * What this file contributes is the *binding*: which hosts, which scheme, which
 * port, how many bytes, how long.
 *
 * ## Why the allow-list is a constant and not a config value
 *
 * `NOTIFICATIONS_ALLOWED_HOSTS` is operator-supplied because a notification
 * destination genuinely is: the operator's own ntfy server could be anywhere.
 * A market-data host is not. There are exactly four providers, D17 named them,
 * and their hostnames are published facts, so the list lives in code where a
 * reviewer can read it and a typo is a failed test rather than a wider
 * allow-list. `createMarketDataEgressPolicy` still accepts an override, because
 * `MARKET_DATA_ALLOWED_HOSTS` is on the orchestrator's §4 config batch and a
 * deployment that pins its own list should be able to *narrow* this one — but
 * the default is not "whatever the environment says", and an empty environment
 * variable cannot silently widen anything.
 *
 * ## One host per adapter, not four
 *
 * `policyFor(provider)` hands an adapter a policy whose `allowedHosts` has
 * **exactly one** entry: its own. Tiingo cannot reach `api.coingecko.com` even
 * though CoinGecko is a legitimate destination for this context. That is
 * deliberate: a compromised or simply buggy adapter should not inherit the
 * blast radius of every provider we happen to speak to, and the refusal matrix
 * in the evidence is then a per-adapter claim rather than a per-context one.
 *
 * ## yfinance is not in the default list
 *
 * 01 §4.2 is unambiguous that Yahoo data is unlicensed and that shipping it as
 * a documented default "puts the project in the position of instructing every
 * user to violate a ToS". `PROVIDER_HOSTS` knows the host so that an opt-in
 * adapter has somewhere to put it; `MARKET_DATA_ALLOWED_HOSTS` does not include
 * it, so an opt-in that was never opted into cannot reach the network.
 */
import {
  createEgressPolicy,
  type EgressPolicy,
  type EgressPolicyInput,
} from '@core/platform';
import type { MarketDataProvider } from '../schema/index.ts';

/**
 * Provider → the single hostname it is reachable at.
 *
 * Exact hostnames, lowercase, no wildcards. `createEgressPolicy` refuses a
 * wildcard and refuses an IP literal, so neither can be spelled here by
 * accident.
 */
export const PROVIDER_HOSTS: Readonly<Record<MarketDataProvider, string>> = Object.freeze({
  tiingo: 'api.tiingo.com',
  fred: 'api.stlouisfed.org',
  coingecko: 'api.coingecko.com',
  openfigi: 'api.openfigi.com',
  // Opt-in only, and deliberately absent from MARKET_DATA_ALLOWED_HOSTS.
  yfinance: 'query1.finance.yahoo.com',
});

/**
 * The four hosts this context may reach, matching 03-phase-3-dispatch.md §4
 * item 8's `MARKET_DATA_ALLOWED_HOSTS`.
 *
 * Note what is not here, beyond yfinance: `api.coinbase.com`,
 * `blockstream.info` and `api.etherscan.io` are `CRYPTO_ALLOWED_HOSTS`, which
 * belong to WP 3.5 and WP 3.6's connectors. A price source has no business
 * reaching an exchange's account API and this list is how that stays true.
 */
export const MARKET_DATA_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  PROVIDER_HOSTS.tiingo,
  PROVIDER_HOSTS.fred,
  PROVIDER_HOSTS.coingecko,
  PROVIDER_HOSTS.openfigi,
]);

/**
 * 443 and nothing else.
 *
 * The notifications policy allows 465 and 587 as well because SMTP submission
 * needs them. No market-data provider speaks anything but HTTPS on 443, so
 * narrowing the list here removes two ports that could only ever be reached by
 * mistake — and gives `db:5432` a second, independent reason to be refused even
 * if a host allow-list were somehow wrong.
 */
export const MARKET_DATA_ALLOWED_PORTS: readonly number[] = Object.freeze([443]);

/**
 * 1 MiB.
 *
 * Larger than notifications' 64 KiB because a Tiingo EOD window or an OpenFIGI
 * batch response legitimately runs to a few hundred kilobytes, and small enough
 * that a provider (or something answering as one) that streams forever costs us
 * a megabyte rather than a worker. The cap is enforced *while* the body
 * arrives, in the transport, not after it is buffered.
 */
export const MARKET_DATA_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * 15 seconds.
 *
 * The transport applies this as an idle timeout and `3 ×` it as a whole-request
 * deadline, because a server that dribbles one byte per second resets an idle
 * timer forever. Longer than notifications' 10 s: a cold Tiingo EOD query for a
 * multi-year window is genuinely slower than posting a notification, and a
 * 03:45 job has time.
 */
export const MARKET_DATA_TIMEOUT_MS = 15_000;

/**
 * The policy for this context as a whole: all four provider hosts, HTTPS, 443.
 *
 * `allowedHosts` may be narrowed by a deployment. It cannot be widened into
 * anything the shared guard refuses — `createEgressPolicy` throws on a
 * wildcard, on an IP literal and on a syntactically invalid hostname, so a
 * misconfigured deployment fails to boot rather than quietly allowing a host
 * nobody meant.
 */
export function createMarketDataEgressPolicy(input: EgressPolicyInput = {}): EgressPolicy {
  return createEgressPolicy({
    allowedHosts: input.allowedHosts ?? MARKET_DATA_ALLOWED_HOSTS,
    allowedSchemes: ['https'],
    allowedPorts: input.allowedPorts ?? MARKET_DATA_ALLOWED_PORTS,
    maxResponseBytes: input.maxResponseBytes ?? MARKET_DATA_MAX_RESPONSE_BYTES,
    timeoutMs: input.timeoutMs ?? MARKET_DATA_TIMEOUT_MS,
  });
}

/**
 * A policy allowing **one** host: the provider's own.
 *
 * What each adapter is actually handed. See the header for why an adapter does
 * not get the context-wide list.
 */
export function policyFor(
  provider: MarketDataProvider,
  input: Omit<EgressPolicyInput, 'allowedHosts'> = {},
): EgressPolicy {
  return createMarketDataEgressPolicy({ ...input, allowedHosts: [PROVIDER_HOSTS[provider]] });
}

/** The base URL an adapter builds its paths onto. Always https, always the allow-listed host. */
export function baseUrlFor(provider: MarketDataProvider): string {
  return `https://${PROVIDER_HOSTS[provider]}`;
}
