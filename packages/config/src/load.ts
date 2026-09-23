// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { z } from 'zod';
import { ConfigError, type ConfigProblem } from './errors.ts';
import { redact, type Redacted } from './redacted.ts';
import {
  KEK_ARGON2_FLOORS,
  SECRET_SPECS,
  environmentSchema,
  type Argon2Params,
  type EnvironmentConfig,
  type SecretName,
} from './schema.ts';

/**
 * The environment as the rest of the app sees it.
 *
 * `DATABASE_URL` is deliberately absent: it carries a password, so once it has
 * been read it lives only inside `databaseUrl`, boxed in `Redacted`. Leaving it on
 * a plain object means the first `JSON.stringify(config)` in a debug log prints
 * the database password, and that call site is impossible to find later.
 */
export type PublicEnvironmentConfig = Omit<EnvironmentConfig, 'DATABASE_URL'>;

/**
 * Key-derivation settings, resolved and floor-checked at boot.
 *
 * The passphrase is **not** here. It stays in `secrets.master_key` as a
 * `Redacted<string>` and is handed to `SecretBox.unlock()` exactly once; putting
 * it — or the derived KEK — on `config` would mean the first
 * `JSON.stringify(config)` in a debug log prints the key to everything.
 */
export interface KekConfig {
  readonly params: Argon2Params;
  readonly floor: Argon2Params;
}

/** The two Plaid API environments this application will actually call. */
export const PLAID_CALLABLE_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type PlaidCallableEnvironment = (typeof PLAID_CALLABLE_ENVIRONMENTS)[number];

/**
 * Plaid, resolved and validated at boot — or absent.
 *
 * `AppConfig.plaid` is `null` whenever `plaid_client_id` or `plaid_secret` is
 * missing: the deployment simply has not configured a Plaid connector, which is
 * not a configuration *error* (`docs/evidence/phase-1/wp1.3b-plaid-api.md`
 * "feature-detect"). `apps/api/src/domain.ts` reads this field to decide
 * whether to register `PlaidConnector`, and logs exactly one info line either
 * way — never the values.
 */
export interface PlaidConfig {
  readonly clientId: Redacted<string>;
  readonly secret: Redacted<string>;
  readonly environment: PlaidCallableEnvironment;
  readonly clientName: string;
  readonly countryCodes: readonly string[];
  readonly language: string;
  readonly redirectUri: string | null;
  readonly webhookUrl: string | null;
}

/**
 * `@ctx/notifications`'s egress allow-list, resolved and validated at boot.
 *
 * A plain object rather than `EgressPolicy` itself: `packages/config` may
 * import nothing but `@core/kernel` (the same rule that keeps `PlaidConfig`
 * here as data rather than a `PlaidConnector`), so the actual policy is built
 * by `createEgressPolicy` in `apps/api/src/domain.ts`, the composition root.
 */
export interface NotificationsConfig {
  /** Lowercase hostnames. Empty ⇒ deny-all. Never a wildcard, never an IP literal. */
  readonly allowedHosts: readonly string[];
}

/**
 * `@ctx/integrations`'s egress allow-list, and `@connector/coinbase`'s, as
 * deployment configuration.
 *
 * Same "data, not a policy object" rule as `NotificationsConfig` above —
 * `packages/config` may import nothing but `@core/kernel`, so the actual
 * `EgressPolicy` is built in `apps/api/src/domain.ts`.
 *
 * **Empty means "do not narrow", not "deny all"**, which is the one way these
 * differ from `NotificationsConfig`. The authoritative list for each is in the
 * code that dials (`@ctx/integrations`'s `MARKET_DATA_ALLOWED_HOSTS`,
 * `@connector/coinbase`'s own host), and a value here can only intersect with
 * it. An operator can therefore switch a price source off by narrowing this
 * list, but cannot point one at a host the code does not already name.
 */
export interface AllowedHostsConfig {
  /** Lowercase hostnames. Empty ⇒ no override. Never a wildcard, never an IP literal. */
  readonly allowedHosts: readonly string[];
}

/**
 * Coinbase, feature-detected — or absent.
 *
 * `AppConfig.coinbase` is `null` whenever `coinbase_key_name` or
 * `coinbase_private_key` is missing, exactly as `plaid` is. Unlike
 * `PlaidConfig` it carries **no credential at all**: the connector reads the
 * sealed pair from each `ConnectionHandle` per request (wp3.5-coinbase.md
 * §8.3), so the only thing the composition root needs from configuration is
 * whether the operator has opted in. Carrying the bytes here anyway would put
 * a CDP private key in a long-lived process-wide object for no caller.
 */
export interface CoinbaseConfig {
  /** Always `true` when the object exists; present so the type is not empty. */
  readonly configured: true;
}

export interface AppConfig {
  readonly env: PublicEnvironmentConfig;
  /** Every declared secret, boxed. `config.secrets.database_url?.reveal()`. */
  readonly secrets: Readonly<Record<SecretName, Redacted<string> | undefined>>;
  /** The effective database URL, from the secret file if present, else the env var. */
  readonly databaseUrl: Redacted<string>;
  /** Argon2id parameters for the KEK, with the floor they were checked against. */
  readonly kek: KekConfig;
  /** Origins allowed by WebAuthn verification and the CSRF `Origin` check. */
  readonly allowedOrigins: readonly string[];
  /** `null` when Plaid is not configured (§ `resolvePlaid`). Never partially set. */
  readonly plaid: PlaidConfig | null;
  /** `null` when neither Coinbase secret file is present (§ `resolveCoinbase`). */
  readonly coinbase: CoinbaseConfig | null;
  readonly notifications: NotificationsConfig;
  /** `MARKET_DATA_ALLOWED_HOSTS`, validated. Empty ⇒ the code's own list stands. */
  readonly marketData: AllowedHostsConfig;
  /** `CRYPTO_ALLOWED_HOSTS`, validated. Empty ⇒ the code's own list stands. */
  readonly crypto: AllowedHostsConfig;
  readonly isProduction: boolean;
  readonly isTest: boolean;
}

export interface LoadConfigOptions {
  /** Defaults to `process.env`. Injectable so tests never mutate the real one. */
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides `SECRETS_DIR`. */
  readonly secretsDir?: string;
  /** Read a secret file. Injectable for tests; defaults to the filesystem. */
  readonly readSecret?: (path: string) => string;
}

function defaultReadSecret(path: string): string {
  return readFileSync(path, 'utf8');
}

function hintFor(key: string): string {
  return `set ${key} in the environment (see .env.example)`;
}

function problemsFromZod(error: z.ZodError): ConfigProblem[] {
  return error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return {
      key,
      // `issue.message` describes the constraint, never echoes the value, so it is
      // safe to print even when the key turns out to be sensitive.
      problem: issue.message,
      hint: hintFor(key),
    };
  });
}

/**
 * Load and validate configuration. Throws `ConfigError` listing every problem.
 *
 * Non-secrets come from the environment; secrets come from files under
 * `SECRETS_DIR`, because env vars leak into `docker inspect`, crash dumps and
 * child processes. No secret value ever appears in a thrown message.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const source = options.env ?? process.env;
  const readSecret = options.readSecret ?? defaultReadSecret;
  const problems: ConfigProblem[] = [];

  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    problems.push(...problemsFromZod(parsed.error));
  }

  // Without a valid environment we cannot know where the secrets live, so report
  // what we have rather than guessing.
  if (!parsed.success) throw new ConfigError(problems);

  const env = parsed.data;
  const secretsDir = options.secretsDir ?? env.SECRETS_DIR;
  const secrets: Partial<Record<SecretName, Redacted<string>>> = {};

  for (const spec of SECRET_SPECS) {
    const path = join(secretsDir, spec.file);
    let value: string | undefined;
    try {
      const raw = readSecret(path).trim();
      if (raw.length > 0) value = raw;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== undefined && code !== 'ENOENT' && code !== 'ENOTDIR') {
        problems.push({
          key: `secret:${spec.name}`,
          problem: `could not be read (${code})`,
          hint: `check permissions on ${path}; it should be mode 0400 owned by the app user`,
        });
        continue;
      }
    }

    if (value === undefined && spec.envFallback !== undefined) {
      const fallback = source[spec.envFallback];
      if (typeof fallback === 'string' && fallback.trim().length > 0) value = fallback.trim();
    }

    if (value === undefined) {
      // Required-ness is per role (`SECRET_SPECS[].requiredForRoles`): the
      // one-shot migrator applies DDL and has no use for the KEK passphrase, so
      // demanding it there would only force the passphrase to be mounted into a
      // container that must never hold it.
      if (spec.requiredForRoles.includes(env.ROLE)) {
        problems.push({ key: `secret:${spec.name}`, problem: 'is missing', hint: spec.hint });
      }
      continue;
    }
    secrets[spec.name] = redact(value);
  }

  const databaseUrl = secrets.database_url;
  if (databaseUrl === undefined) {
    problems.push({
      key: 'secret:database_url',
      problem: 'is missing; the application cannot start without a database',
      hint: `write it to ${join(secretsDir, 'database_url')}, or set DATABASE_URL for local dev`,
    });
  }

  const isProduction = env.NODE_ENV === 'production';
  const kekParams: Argon2Params = {
    memoryKiB: env.KEK_ARGON2_MEMORY_KIB,
    timeCost: env.KEK_ARGON2_TIME_COST,
    parallelism: env.KEK_ARGON2_PARALLELISM,
  };
  // The floor follows NODE_ENV, never a setting of its own: a "relax the KDF"
  // switch is a switch that eventually gets flipped in production at 02:00 to make
  // a restart faster.
  const kekFloor = KEK_ARGON2_FLOORS[isProduction ? 'production' : 'development'];
  problems.push(...kekFloorProblems(kekParams, kekFloor, isProduction));

  const allowedOrigins = env.AUTH_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (allowedOrigins.length === 0) {
    problems.push({
      key: 'AUTH_ALLOWED_ORIGINS',
      problem: 'is empty; with no allowed origin every mutation would be rejected as cross-site',
      hint: 'set it to the exact scheme+host+port the UI is served from, e.g. https://fi.example.ts.net',
    });
  }
  problems.push(...webAuthnProblems(env.AUTH_RP_ID, allowedOrigins, isProduction));
  problems.push(...plaidRedirectUriProblems(env.PLAID_REDIRECT_URI, allowedOrigins));

  const notificationsAllowedHostsResult = resolveAllowedHosts(
    'NOTIFICATIONS_ALLOWED_HOSTS',
    env.NOTIFICATIONS_ALLOWED_HOSTS,
    'ntfy.example.ts.net',
  );
  problems.push(...notificationsAllowedHostsResult.problems);

  const marketDataAllowedHostsResult = resolveAllowedHosts(
    'MARKET_DATA_ALLOWED_HOSTS',
    env.MARKET_DATA_ALLOWED_HOSTS,
    'api.tiingo.com',
  );
  problems.push(...marketDataAllowedHostsResult.problems);

  const cryptoAllowedHostsResult = resolveAllowedHosts(
    'CRYPTO_ALLOWED_HOSTS',
    env.CRYPTO_ALLOWED_HOSTS,
    'api.coinbase.com',
  );
  problems.push(...cryptoAllowedHostsResult.problems);

  // `SESSION_COOKIE_SECURE=false` exists only for a plain-HTTP local/integration
  // harness (apps/api/test/cookies.test.ts) — a session cookie without `Secure`
  // in production would ride along on plain HTTP the instant Caddy's TLS
  // termination is ever bypassed or misconfigured, and nothing else in this repo
  // would notice. `true` is the default, so this only ever fires on a deliberate
  // override left in place.
  if (isProduction && !env.SESSION_COOKIE_SECURE) {
    problems.push({
      key: 'SESSION_COOKIE_SECURE',
      problem: 'is false in production; the session cookie would be sent over plain HTTP',
      hint:
        'leave SESSION_COOKIE_SECURE at its default (true) in production — it exists only for a ' +
        'plain-HTTP test harness. Caddy terminates TLS in front of this process (docker/Caddyfile).',
    });
  }

  // Resolved before the final `problems.length` check so a Plaid misconfiguration
  // (e.g. `plaid_env=production` with no opt-in) is reported *with* every other
  // boot problem in one shot, matching "boot fails fast and prints every problem
  // at once" — not as a second exception a moment later.
  const plaid = resolvePlaid(secrets, env, problems);
  const coinbase = resolveCoinbase(secrets, problems);

  if (problems.length > 0) throw new ConfigError(problems);
  if (databaseUrl === undefined) throw new ConfigError(problems); // unreachable; narrows the type

  const { DATABASE_URL: _consumed, ...publicEnv } = env;

  return Object.freeze({
    env: publicEnv,
    secrets: Object.freeze({ ...secrets }) as AppConfig['secrets'],
    databaseUrl,
    kek: Object.freeze({ params: Object.freeze(kekParams), floor: kekFloor }),
    allowedOrigins: Object.freeze(allowedOrigins),
    plaid,
    coinbase,
    notifications: Object.freeze({
      allowedHosts: Object.freeze(notificationsAllowedHostsResult.hosts),
    }),
    marketData: Object.freeze({
      allowedHosts: Object.freeze(marketDataAllowedHostsResult.hosts),
    }),
    crypto: Object.freeze({ allowedHosts: Object.freeze(cryptoAllowedHostsResult.hosts) }),
    isProduction,
    isTest: env.NODE_ENV === 'test',
  });
}

/** Hosts a browser treats as a secure context without TLS. Never a deployment. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Bare labels that are not registrable domains, and so are never a valid
 * WebAuthn RP ID. Not the IANA Public Suffix List — a dependency this package
 * will not take on for a single-user app's boot check — but the handful an
 * operator could plausibly type in place of a real registrable domain: this
 * repo's own LAN convention, a few common TLDs, and the loopback name (already
 * handled above by `LOOPBACK_HOSTS`; listed here too so `BARE_SUFFIX_RP_IDS`
 * reads complete on its own).
 */
const BARE_SUFFIX_RP_IDS = new Set([
  'lan',
  'local',
  'localdomain',
  'localhost',
  'internal',
  'home',
  'test',
  'invalid',
  'com',
  'net',
  'org',
  'io',
  'dev',
  'app',
  'co',
]);

/**
 * The passkey configuration must describe the host actually served (P0-4).
 *
 * `AUTH_RP_ID` and `AUTH_ALLOWED_ORIGINS` both defaulted, and `compose.yml` set
 * neither, so the deployed stack booted with `localhost` / `http://localhost:8080`
 * while serving `https://personalfi.lan`. Two independent breakages fell out of
 * that one omission and *neither announced itself*: the CSRF `Origin` allow-list
 * rejected every mutation from the real origin with a 403, and `localhost` is not
 * a registrable suffix of `personalfi.lan`, so the browser refused the WebAuthn
 * ceremony before the server was consulted. No passkey had ever been enrolled
 * through the stack and nothing in the system said so.
 *
 * Silent-and-wrong is the failure mode worth spending a boot check on, so:
 *
 * - **Every environment** requires that *at least one* allowed origin can
 *   actually enrol a passkey — its host must be the RP id or a subdomain of it
 *   (WebAuthn §7.1). This is the deployed failure stated exactly: not "every
 *   origin matches", which would be wrong, but "none of them does", which is the
 *   condition under which the passkey system is decoration.
 *
 *   Deliberately **not** an error on the individual non-matching origins. The
 *   list serves double duty, and a LAN name plus a Tailscale MagicDNS name is a
 *   legitimate deployment: both must pass the CSRF `Origin` check, while only
 *   one can ever be the WebAuthn RP. Rejecting the extras would forbid a working
 *   configuration to catch a mistake the quorum rule already catches.
 *
 * - **Production** additionally refuses the shipped defaults and plain HTTP. A
 *   box holding financial data that still says `localhost` is a box whose
 *   operator believes passkeys work.
 */
function webAuthnProblems(
  rpId: string,
  origins: readonly string[],
  isProduction: boolean,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  if (isProduction && LOOPBACK_HOSTS.has(rpId)) {
    problems.push({
      key: 'AUTH_RP_ID',
      problem: `is still the development default (${rpId}); no passkey can be enrolled against a production host with this set`,
      hint:
        'set AUTH_RP_ID to the exact hostname the UI is served from, with no scheme and no port ' +
        '(e.g. personalfi.lan). Changing it later invalidates every enrolled passkey, so pick the ' +
        'final hostname now — see 03 §3.2 and P0-4.',
    });
  } else if (isProduction && (!rpId.includes('.') || BARE_SUFFIX_RP_IDS.has(rpId))) {
    // A registrable domain has at least one dot; a bare TLD or LAN suffix
    // is not one, whether or not it happens to also be the shipped default.
    problems.push({
      key: 'AUTH_RP_ID',
      problem: `is "${rpId}", a bare label rather than a registrable domain — a WebAuthn RP id must be the exact hostname the UI is served from, not a TLD or a LAN suffix on its own`,
      hint:
        'set AUTH_RP_ID to a real hostname with at least one dot, e.g. personalfi.lan or ' +
        'personalfi.example.com. Changing it later invalidates every enrolled passkey, so pick the ' +
        'final hostname now — see 03 §3.2 and P0-4.',
    });
  }

  let enrollable = 0;

  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      problems.push({
        key: 'AUTH_ALLOWED_ORIGINS',
        problem: `contains "${origin}", which is not a parseable origin`,
        hint: 'each entry must be scheme://host[:port] with no path, e.g. https://personalfi.lan',
      });
      continue;
    }

    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      problems.push({
        key: 'AUTH_ALLOWED_ORIGINS',
        problem: `contains "${origin}", which carries a path, query or fragment; an origin is scheme+host+port only`,
        hint: `use ${url.origin} instead`,
      });
    }

    // WebAuthn §7.1: the RP id must equal the origin's effective domain or be a
    // registrable suffix of it. Counted rather than enforced per-origin — see
    // the note above on the CSRF list's double duty.
    const host = url.hostname;
    if (host === rpId || host.endsWith(`.${rpId}`)) enrollable += 1;

    if (isProduction && url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(host)) {
      problems.push({
        key: 'AUTH_ALLOWED_ORIGINS',
        problem: `contains "${origin}", which is not HTTPS; WebAuthn requires a secure context and the session cookie is \`Secure\``,
        hint: `use https://${url.host} — Caddy terminates TLS in front of this process`,
      });
    }
  }

  // The deployed failure, stated exactly. `AUTH_RP_ID=localhost` against
  // `https://personalfi.lan` lands here: the stack boots, logs "configuration
  // loaded", serves the UI, and can never enrol a passkey — the browser refuses
  // the ceremony before the server is consulted, so nothing server-side ever
  // reports a problem. Zero enrollable origins is not a preference; it is a
  // passkey system that exists only in the configuration file.
  if (origins.length > 0 && enrollable === 0) {
    problems.push({
      key: 'AUTH_RP_ID',
      problem: `is "${rpId}", which is not the host of any allowed origin (${origins.join(', ')}); no passkey can ever be enrolled or asserted with this pairing`,
      hint:
        'AUTH_RP_ID must be the registrable host of at least one AUTH_ALLOWED_ORIGINS entry — ' +
        'the exact hostname, no scheme and no port. For https://personalfi.lan set ' +
        'AUTH_RP_ID=personalfi.lan. See 03 §3.2 and P0-4.',
    });
  }

  return problems;
}

/**
 * `PLAID_REDIRECT_URI` (D12; gate-security-review.md §2.2 F-2, §6 C-3): the
 * page Plaid Link sends the browser back to after an OAuth institution's own
 * login page. Two properties matter enough to check at boot rather than
 * discover mid-Link:
 *
 * - **Must be `https`.** Plaid requires it unconditionally for an OAuth
 *   redirect — there is no loopback exception the way `AUTH_ALLOWED_ORIGINS`
 *   gets one in development, because Plaid itself refuses a non-`https`
 *   `redirect_uri` (`INVALID_FIELD`), so a plain-HTTP value would only ever
 *   fail at Plaid rather than here.
 * - **Must share an origin with an allowed origin.** `PlaidConnector` sends
 *   this verbatim as `redirect_uri` (`connector.ts#linkTokenBase`); if its
 *   origin is not one this deployment's CSRF/WebAuthn allow-list already
 *   trusts, the browser lands back on a page this application never actually
 *   serves as itself — the OAuth return silently fails, or worse, succeeds
 *   against something unintended.
 *
 * `null` (the default) is never a problem: D12 says LAN-only deployments have
 * no OAuth redirect and Plaid Link disables OAuth institutions without one.
 */
function plaidRedirectUriProblems(
  redirectUri: string | null,
  allowedOrigins: readonly string[],
): ConfigProblem[] {
  if (redirectUri === null) return [];
  const problems: ConfigProblem[] = [];
  // `environmentSchema`'s `z.url()` already guarantees this parses; a second
  // try/catch here would be dead code, not defence in depth.
  const url = new URL(redirectUri);

  if (url.protocol !== 'https:') {
    problems.push({
      key: 'PLAID_REDIRECT_URI',
      problem:
        `is "${redirectUri}", which is not https; Plaid refuses a non-https redirect_uri ` +
        'for an OAuth institution (INVALID_FIELD)',
      hint: 'use an https URL — Caddy terminates TLS in front of this process',
    });
  }

  if (!allowedOrigins.includes(url.origin)) {
    problems.push({
      key: 'PLAID_REDIRECT_URI',
      problem:
        `is "${redirectUri}", whose origin (${url.origin}) is not one of ` +
        `AUTH_ALLOWED_ORIGINS (${allowedOrigins.join(', ') || '(empty)'}) — Plaid Link would send ` +
        'the browser back to a page this application does not serve as itself',
      hint:
        'set PLAID_REDIRECT_URI to a path on the same origin as PUBLIC_HOST, e.g. ' +
        'https://personalfi.lan/link/oauth, or add its origin to AUTH_ALLOWED_ORIGINS',
    });
  }

  return problems;
}

/** A syntactically valid DNS hostname label sequence. No scheme, no port, no path. */
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u;

/**
 * A comma-separated egress allow-list, validated the same way for all three of
 * `NOTIFICATIONS_ALLOWED_HOSTS` (02-phase-2-dispatch.md §4 item 3;
 * wp2.4-notifications.md §8), `MARKET_DATA_ALLOWED_HOSTS` and
 * `CRYPTO_ALLOWED_HOSTS` (03-phase-3-dispatch.md §4 item 8).
 *
 * One function rather than three, and the `key` parameter is why: the three
 * lists differ only in which variable they came from and what a *good* entry
 * looks like in the hint, and three copies of these twenty lines is how the
 * second one ends up missing the IPv6 case. What the three do **not** share is
 * what an empty value means — deny-all for notifications, "no narrowing of the
 * code's own list" for the other two — and that difference is resolved by the
 * caller, in `loadConfig`, not here.
 *
 * Validated here — by hand, the same way `AUTH_ALLOWED_ORIGINS` is split by
 * hand a few lines up — rather than left entirely to
 * `@ctx/notifications`'s own `createEgressPolicy`, for two reasons. First,
 * `packages/config` may import nothing but `@core/kernel`, so it cannot call
 * that function to find out whether its own input is well-formed; a
 * misconfigured allow-list should fail the same fail-fast boot check every
 * other environment variable does, not surface as an unhandled `TypeError`
 * the first time a notification tries to send. Second, `compose.yml`'s
 * `${VAR:-}` convention (see `nullableUrlEnv`'s comment above) hands an
 * operator who has not set this an **empty string**, which must mean "no
 * hosts" — `createEgressPolicy`'s own `''.split(',')` would otherwise produce
 * `['']`, one empty allow-list entry, and throw.
 *
 * The two refusals mirror `createEgressPolicy`'s own (`egress.ts`) exactly,
 * because both exist for the same reason: an IP literal in the allow-list is a
 * second door to the private-range refusal the egress guard exists to
 * enforce, and a wildcard is one typo away from `*.attacker.example` matching
 * — on a list with at most a handful of entries, spelling each one out costs
 * nothing.
 */
function resolveAllowedHosts(
  key: 'NOTIFICATIONS_ALLOWED_HOSTS' | 'MARKET_DATA_ALLOWED_HOSTS' | 'CRYPTO_ALLOWED_HOSTS',
  raw: string,
  example: string,
): {
  readonly hosts: string[];
  readonly problems: ConfigProblem[];
} {
  const problems: ConfigProblem[] = [];
  const hosts: string[] = [];

  for (const entry of raw.split(',')) {
    const host = entry.trim().toLowerCase();
    if (host.length === 0) continue;

    if (host.includes('*')) {
      problems.push({
        key,
        problem: `contains "${host}", a wildcard — wildcards are not supported here`,
        hint: `list each destination hostname explicitly, comma-separated, e.g. ${example}`,
      });
      continue;
    }
    if (isIP(host) !== 0) {
      problems.push({
        key,
        problem: `contains "${host}", an IP literal — an allow-list entry must be a hostname`,
        hint:
          'a literal address would be a second door to the private-range refusal this allow-list ' +
          'exists to enforce; use the hostname a certificate would be issued for instead',
      });
      continue;
    }
    if (!HOSTNAME_PATTERN.test(host)) {
      problems.push({
        key,
        problem: `contains "${host}", which is not a syntactically valid hostname`,
        hint: 'each entry must be a bare hostname, no scheme, no port, no path',
      });
      continue;
    }
    hosts.push(host);
  }

  return { hosts: [...new Set(hosts)], problems };
}

/**
 * The three raw strings Plaid's `plaid_env` secret file may hold, per D16 and
 * the literal spec this rule was written against. Only the first two are
 * actually callable (`PLAID_CALLABLE_ENVIRONMENTS`) — 01 §1.2: "'Development'
 * no longer exists" as a Plaid API base path, and
 * `docs/evidence/phase-1/wp1.3-plaid.md` §1 pins `PLAID_ENVIRONMENTS` to
 * exactly `sandbox`/`production` and asserts "a third value throws". Accepting
 * `development` as *shaped* input and then refusing it by name — rather than
 * letting an unrecognised string fall through to `plaidBasePath`'s generic
 * "unknown plaid environment" at first API call — gives an operator who typed
 * the wrong word a boot-time problem with a fix, not a 502 during a sync.
 */
const PLAID_ENV_VALUES = ['sandbox', 'development', 'production'] as const;

/**
 * Validate and resolve `plaid_client_id` / `plaid_secret` / `plaid_env` into a
 * `PlaidConfig`, or `null` when Plaid is not configured.
 *
 * Feature-detection, not a requirement: `client_id`/`secret` absent is the
 * ordinary "this deployment has no Plaid connector" case and produces no
 * problem at all. Present-but-partial (one file with no matching other) *is* a
 * problem — a client id with no secret can never make a call, and catching that
 * at boot beats discovering it the first time a user clicks "Connect a bank".
 */
function resolvePlaid(
  secrets: Partial<Record<SecretName, Redacted<string>>>,
  env: EnvironmentConfig,
  problems: ConfigProblem[],
): PlaidConfig | null {
  const clientId = secrets.plaid_client_id;
  const secret = secrets.plaid_secret;
  const rawEnv = secrets.plaid_env;

  if (clientId === undefined && secret === undefined) {
    // Neither present: Plaid is simply not configured. A `plaid_env` file with
    // no credentials is unusual but harmless — nothing reads it — so it is not
    // flagged.
    return null;
  }
  if (clientId === undefined || secret === undefined) {
    const missing = clientId === undefined ? 'plaid_client_id' : 'plaid_secret';
    const present = clientId === undefined ? 'plaid_secret' : 'plaid_client_id';
    problems.push({
      key: `secret:${missing}`,
      problem: `is missing, but secret:${present} is present — Plaid cannot make a call with only one`,
      hint: `write the other half to \${SECRETS_DIR}/${missing} (mode 0400), or remove both to leave Plaid unconfigured`,
    });
    return null;
  }

  const rawEnvValue = rawEnv?.reveal() ?? 'sandbox';
  if (!(PLAID_ENV_VALUES as readonly string[]).includes(rawEnvValue)) {
    problems.push({
      key: 'secret:plaid_env',
      problem: `is not one of ${PLAID_ENV_VALUES.join(', ')}`,
      hint: 'write exactly `sandbox` or `production` to ${SECRETS_DIR}/plaid_env',
    });
    return null;
  }
  if (rawEnvValue === 'development') {
    problems.push({
      key: 'secret:plaid_env',
      problem:
        "is 'development', which Plaid retired as an API base path (01 §1.2 — 'Development no " +
        "longer exists'); PlaidEnvironments only defines sandbox and production",
      hint: 'use `sandbox` for testing; there is no development environment to fall back to',
    });
    return null;
  }
  const resolvedEnv = rawEnvValue as PlaidCallableEnvironment;

  if (resolvedEnv === 'production' && !env.PLAID_ALLOW_PRODUCTION) {
    problems.push({
      key: 'secret:plaid_env',
      problem:
        'is `production`, which calls Plaid for real money-adjacent data and a hard ten-Item ' +
        'cap that /item/remove does not free (D16) — refusing to boot without an explicit opt-in',
      hint:
        'set PLAID_ALLOW_PRODUCTION=true if this deployment really means to call Plaid ' +
        'Production, or write `sandbox` to ${SECRETS_DIR}/plaid_env if it does not',
    });
    return null;
  }

  const countryCodes = env.PLAID_COUNTRY_CODES.split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
  if (countryCodes.length === 0) {
    problems.push({
      key: 'PLAID_COUNTRY_CODES',
      problem: 'is empty; Link needs at least one ISO-3166-1 alpha-2 country code',
      hint: 'set PLAID_COUNTRY_CODES to a comma-separated list, e.g. US or US,CA',
    });
    return null;
  }

  return {
    clientId,
    secret,
    environment: resolvedEnv,
    clientName: env.PLAID_CLIENT_NAME,
    countryCodes: Object.freeze(countryCodes),
    language: env.PLAID_LANGUAGE,
    redirectUri: env.PLAID_REDIRECT_URI,
    webhookUrl: env.PLAID_WEBHOOK_URL,
  };
}

/**
 * Feature-detect `coinbase_key_name` / `coinbase_private_key`, the same way
 * `resolvePlaid` feature-detects its pair — including the present-but-partial
 * case, which is the half that earns this function its existence.
 *
 * Neither value is returned. `CoinbaseConfig` carries only `configured: true`
 * because `apps/api/src/domain.ts` needs nothing else: the connector signs
 * every request from the credential sealed into the `ConnectionHandle`, not
 * from a process-wide copy (wp3.5-coinbase.md §8.3). The bytes are still read
 * here — `config.secrets.coinbase_private_key` exists like any other declared
 * secret — but nothing in the composition root has a reason to reach for them,
 * and a `Redacted<string>` that no caller wants is a copy of a signing key
 * kept alive for the life of the process for nobody.
 *
 * **No validation of the key's *shape* happens here, deliberately.** Whether
 * the private key is a well-formed Ed25519 PKCS#8 PEM (and specifically not an
 * ECDSA key) is `@connector/coinbase`'s own check, at the point of use, where
 * it can say so in the connector's error vocabulary; `packages/config` may
 * import nothing but `@core/kernel` and has no way to parse a key. What boot
 * catches is the operator error `resolvePlaid` catches: one file written and
 * the other forgotten.
 */
function resolveCoinbase(
  secrets: Partial<Record<SecretName, Redacted<string>>>,
  problems: ConfigProblem[],
): CoinbaseConfig | null {
  const keyName = secrets.coinbase_key_name;
  const privateKey = secrets.coinbase_private_key;

  if (keyName === undefined && privateKey === undefined) return null;
  if (keyName === undefined || privateKey === undefined) {
    const missing = keyName === undefined ? 'coinbase_key_name' : 'coinbase_private_key';
    const present = keyName === undefined ? 'coinbase_private_key' : 'coinbase_key_name';
    problems.push({
      key: `secret:${missing}`,
      problem:
        `is missing, but secret:${present} is present — a CDP JWT needs both the key name ` +
        '(its `kid` and `sub`) and the private key that signs it',
      hint: `write the other half to \${SECRETS_DIR}/${missing} (mode 0400), or remove both to leave Coinbase unconfigured`,
    });
    return null;
  }

  return { configured: true };
}

function kekFloorProblems(
  params: Argon2Params,
  floor: Argon2Params,
  isProduction: boolean,
): ConfigProblem[] {
  const where = isProduction ? 'production' : 'development';
  const problems: ConfigProblem[] = [];
  const check = (key: string, value: number, minimum: number, unit: string): void => {
    if (value >= minimum) return;
    problems.push({
      key,
      problem: `${String(value)}${unit} is below the ${where} Argon2id floor of ${String(minimum)}${unit}`,
      hint:
        `raise ${key} to at least ${String(minimum)}${unit}. The KEK is derived once per boot, ` +
        'so the cost is paid once; see 03 §2.2 and P0-2.',
    });
  };
  check('KEK_ARGON2_MEMORY_KIB', params.memoryKiB, floor.memoryKiB, ' KiB');
  check('KEK_ARGON2_TIME_COST', params.timeCost, floor.timeCost, '');
  check('KEK_ARGON2_PARALLELISM', params.parallelism, floor.parallelism, '');
  return problems;
}

/**
 * The non-secret effective configuration, safe to log at boot and to record in
 * `config_snapshots` so "what changed?" is answerable after a behaviour shift.
 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    ...config.env,
    secretsPresent: Object.entries(config.secrets)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name),
  };
}

/**
 * The KDF parameters and duration, for the boot log line P0-2 asks for
 * ("startup log shows KDF params and duration"). Parameters are not secret — the
 * salt is stored in the clear beside the ciphertext too — but the passphrase and
 * the derived key are never in this object.
 */
export function describeKek(config: AppConfig, durationMs: number): Record<string, unknown> {
  return {
    kdf: 'argon2id',
    memoryKiB: config.kek.params.memoryKiB,
    timeCost: config.kek.params.timeCost,
    parallelism: config.kek.params.parallelism,
    floorMemoryKiB: config.kek.floor.memoryKiB,
    durationMs,
  };
}
