// SPDX-License-Identifier: MIT
/**
 * `/market-data/*` — the source ladder, the budgets, the licence obligations,
 * and a guarded "does my key work?" call.
 *
 * WP 3.9 over WP 3.4. The one property this file exists to hold is negative and
 * is asserted rather than promised:
 *
 * > **No response from this router ever contains an API key value.**
 *
 * Presence is a `boolean`. That is not a stylistic preference — 01 §4.3 and D5
 * put provider keys in `${SECRETS_DIR}/<file>` specifically so they never appear
 * in an environment, a `docker inspect`, or a crash dump, and a settings screen
 * that echoed one back would undo all of it over HTTPS. `@ctx/integrations`'
 * `ApiKey` already renders as `[redacted]` through `toString`, `toJSON` and
 * `util.inspect`, so even an accidental spread cannot leak one; this file goes
 * further and never puts an `ApiKey` in a response object at all, deriving
 * presence from `config.secrets` directly.
 * `apps/api/test/db/market-data-routes.test.ts` → `'the settings response
 * contains no API key value'` plants a synthetic key in the harness's secrets
 * directory and asserts its bytes appear in **no** response body from this
 * router.
 *
 * ## Attribution travels with the settings, not only with the prices
 *
 * `ATTRIBUTIONS[provider].surfaces` includes `'settings'` for CoinGecko and
 * FRED, so this screen is one of the places the licence binds. The obligation —
 * the exact string, the link, whether a logo is required, and the quoted clause
 * — is in the payload, because 01 §4.3's point is that *a UI cannot render an
 * obligation it was never told about*. A paraphrase of a licence condition is a
 * new licence condition, so the strings are carried verbatim.
 *
 * ## Both writes need a step-up assertion
 *
 * `PUT /market-data/priority` decides which provider's number becomes the price
 * of everything the user owns, and `POST /market-data/test-fetch` spends a real
 * request against a real key on a real egress path. Neither is a preference; the
 * first restates the portfolio and the second is the one route in this work
 * package that leaves the machine. Same guard `POST /connections` carries.
 *
 * ## The runtime is built per request, on purpose
 *
 * `createMarketDataRuntime` constructs adapters and rate budgets and performs no
 * I/O. Building it per request (rather than holding one) is what lets
 * `hydrateMarketDataBudgets` prime the budgets from `market_data_runs` on every
 * read without double-counting the same spend into a long-lived budget object —
 * `hydrate` appends, so a held runtime would inflate its own usage on each call
 * until the settings screen reported a budget that had never been spent.
 */
import type { AppConfig } from '@core/config';
import { DateOnly } from '@core/kernel';
import {
  ATTRIBUTIONS,
  MARKET_DATA_PROVIDERS,
  redactedMessageOf,
  type MarketDataProvider,
  type PriceSource,
  type SourceOutcome,
} from '@ctx/integrations';
import { ladderRows } from '@ctx/investments';
import { PRICE_SOURCES, priceSourcePriority } from '@ctx/investments/schema';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { newId } from '@core/kernel';
import { z } from 'zod';
import {
  createMarketDataRunRecorder,
  createMarketDataRuntime,
  hydrateMarketDataBudgets,
  MARKET_DATA_KEYED_PROVIDERS,
  type MarketDataKeyedProvider,
  type MarketDataView,
  type StoredMarketDataKeys,
} from '../domain.ts';
import { validateMarketDataKey } from '../market-data-keys.ts';
import { AppError, problems } from '../problem.ts';
import { dateOnly, isoInstant } from '../wire.ts';
import {
  eraseCredentialKey,
  listMarketDataKeyStatuses,
  MARKET_DATA_KEY_MIN_LENGTH,
  removeProviderCredentials,
  setMarketDataKey,
} from '@ctx/connections';
import { recordSecurityEvent } from '@ctx/identity';
import type { HttpTransport, Resolver } from '@core/platform';
import { contextOf } from './connections.ts';
import { mapDomainErrors } from './domain-errors.ts';
import type { RouteDeps } from './deps.ts';
import { todayFor } from './investments.ts';

/**
 * Which `config.secrets` entry holds each provider's key.
 *
 * A record rather than a template on the provider name, so that adding a
 * provider without a secret declaration fails to compile here instead of
 * silently reporting `keyPresent: false` forever.
 */
const KEY_SECRET: Readonly<Record<MarketDataProvider, keyof AppConfig['secrets'] | null>> =
  Object.freeze({
    tiingo: 'tiingo_api_key',
    fred: 'fred_api_key',
    coingecko: 'coingecko_api_key',
    openfigi: 'openfigi_api_key',
    // 01 §4.2: opt-in, best-effort, no adapter, no key file. Present so this
    // record stays exhaustive over the union.
    yfinance: null,
  });

const attributionWire = z
  .object({
    provider: z.string(),
    required: z.boolean(),
    /** The exact string the licence specifies. Never a paraphrase. */
    text: z.string(),
    linkUrl: z.string().nullable(),
    logoRequired: z.boolean(),
    surfaces: z.array(z.string()),
    /** The clause, quoted, so a reviewer can check the claim rather than trust it. */
    clause: z.string(),
    redistribution: z.enum(['forbidden', 'permitted_with_attribution', 'unrestricted']),
  })
  .meta({ id: 'Attribution' });

const providerWire = z
  .object({
    provider: z.string(),
    /**
     * **Presence, never a value.** There is no field on this object that could
     * hold a key, which is the property the exit test asserts. True for a key
     * from the operator's file or the holder's store (WP 10.4).
     */
    keyPresent: z.boolean(),
    /** WP 10.4: where the key in force came from. `none` for yfinance, which takes no key. */
    keySource: z.enum(['file', 'stored', 'none']),
    /** `false` when no key, or when `MARKET_DATA_ALLOWED_HOSTS` narrowed it out. */
    registered: z.boolean(),
    capabilities: z.object({
      prices: z.boolean(),
      fx: z.boolean(),
      macro: z.boolean(),
      search: z.boolean(),
    }),
    /** What this source has spent against its published windows. */
    budget: z.array(
      z.object({ label: z.string(), used: z.int().nonnegative(), limit: z.int().nonnegative() }),
    ),
    attribution: attributionWire,
  })
  .meta({ id: 'MarketDataProviderSettings' });

const ladderWire = z.object({
  securityKind: z.string(),
  sources: z.array(z.object({ source: z.enum(PRICE_SOURCES), rung: z.int().positive() })),
});

interface LadderRow extends Record<string, unknown> {
  security_kind: string;
  source: (typeof PRICE_SOURCES)[number];
  rung: number;
  enabled: boolean;
}

function attributionWireOf(provider: MarketDataProvider): z.infer<typeof attributionWire> {
  const attribution = ATTRIBUTIONS[provider];
  return {
    provider: attribution.provider,
    required: attribution.required,
    text: attribution.text,
    linkUrl: attribution.linkUrl,
    logoRequired: attribution.logoRequired,
    surfaces: [...attribution.surfaces],
    clause: attribution.clause,
    redistribution: attribution.redistribution,
  };
}

/**
 * One line per provider, from the RUNBOOK's secrets table, so the settings card
 * says what the key is for in the same words the operator's documentation does.
 */
const KEY_PURPOSE: Readonly<Record<MarketDataKeyedProvider, string>> = Object.freeze({
  tiingo: 'Equity, ETF and fund end-of-day closes.',
  fred: 'Macro series and FX rates.',
  coingecko: 'Crypto prices (Demo plan).',
  openfigi:
    'Symbol-to-FIGI mapping. Answers anonymously without a key, at 10 jobs per batch instead of 100.',
});

/** The provider as a holder reads it, for the fixed error copy. */
const DISPLAY_NAME: Readonly<Record<MarketDataKeyedProvider, string>> = Object.freeze({
  tiingo: 'Tiingo',
  fred: 'FRED',
  coingecko: 'CoinGecko',
  openfigi: 'OpenFIGI',
});

const credentialsStatusWire = z
  .object({
    provider: z.enum(MARKET_DATA_KEYED_PROVIDERS),
    purpose: z.string().describe('What the key is for, one line, from the RUNBOOK.'),
    source: z
      .enum(['file', 'stored', 'none'])
      .describe(
        "`file`: the operator's secret file supplies the key (it wins; read-only here). " +
          "`stored`: this holder's key, sealed in the install. `none`: neither.",
      ),
    configured: z.boolean().describe('True when a key is in force (file or stored).'),
    anonymous: z
      .boolean()
      .describe('OpenFIGI only: no key, and the anonymous tier is in use (10 jobs per request).'),
    keyHint: z
      .string()
      .nullable()
      .describe('The last four characters of the stored key. Never the key.'),
    storedAt: isoInstant.nullable().describe('When the stored key was first saved.'),
    rotatedAt: isoInstant.nullable().describe('When the stored key was last replaced.'),
    narrowedOut: z
      .boolean()
      .describe("True when MARKET_DATA_ALLOWED_HOSTS excludes this provider's host."),
  })
  .meta({ id: 'MarketDataCredentialsStatus' });

type CredentialsStatus = z.infer<typeof credentialsStatusWire>;

/**
 * A pasted API key. Lenient on the alphabet the four providers use (hex, a
 * UUID, CoinGecko's `CG-` prefix), strict about length: at least
 * `MARKET_DATA_KEY_MIN_LENGTH`, so the four-character hint is at most a quarter
 * of it. Whitespace a paste carries is trimmed, never stored.
 */
const keyBody = z.object({
  key: z
    .string()
    .trim()
    .min(MARKET_DATA_KEY_MIN_LENGTH)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, hyphen and underscore only')
    .describe('The API key. Validated with the provider, sealed, and never echoed back.'),
});

const providerParams = z.object({ provider: z.enum(MARKET_DATA_KEYED_PROVIDERS) });

/** The audit kinds `@ctx/identity` defines (WP 10.1). The detail carries the provider only. */
const EVENT_KIND = {
  set: 'provider_credentials.set',
  rotated: 'provider_credentials.rotated',
  removed: 'provider_credentials.removed',
} as const;

export interface MarketDataRouteOptions {
  /** WP 10.4: the holder's stored keys (`createStoredMarketDataKeys`). Absent ⇒ files only. */
  readonly storedKeys?: StoredMarketDataKeys;
  /** WP 10.4: a test seam, the socket under every adapter (validation and test-fetch). */
  readonly transport?: HttpTransport;
  /** WP 10.4: a test seam, DNS for the egress guard. */
  readonly resolve?: Resolver;
}

export const marketDataRoutes = (
  deps: RouteDeps,
  options: MarketDataRouteOptions = {},
): FastifyPluginAsyncZod => {
  const { guards, database, clock, config, pool } = deps;

  /**
   * The holder's view, built per request (see this file's header for why) from
   * the operator's files and, where a file is empty, the holder's stored key.
   */
  const viewFor = (userId: string): Promise<MarketDataView> =>
    createMarketDataRuntime({
      secrets: config.secrets,
      allowedHosts: config.marketData.allowedHosts,
      clock,
      ...(options.storedKeys === undefined ? {} : { storedKeys: options.storedKeys }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
    }).forUser(userId);

  const fileHasKey = (provider: MarketDataProvider): boolean => {
    const name = KEY_SECRET[provider];
    return name !== null && config.secrets[name] !== undefined;
  };

  async function statusFor(
    userId: string,
    provider: MarketDataKeyedProvider,
  ): Promise<CredentialsStatus> {
    const narrowedOut = narrowedOutOf(provider, config.marketData.allowedHosts);
    if (fileHasKey(provider)) {
      return {
        provider,
        purpose: KEY_PURPOSE[provider],
        source: 'file',
        configured: true,
        anonymous: false,
        keyHint: null,
        storedAt: null,
        rotatedAt: null,
        narrowedOut,
      };
    }
    const stored = (await listMarketDataKeyStatuses(database, userId)).get(provider);
    return {
      provider,
      purpose: KEY_PURPOSE[provider],
      source: stored === undefined ? 'none' : 'stored',
      configured: stored !== undefined,
      anonymous: provider === 'openfigi' && stored === undefined && !narrowedOut,
      keyHint: stored?.keyHint ?? null,
      storedAt: stored === undefined ? null : stored.createdAt.toISOString(),
      rotatedAt:
        stored?.rotatedAt === undefined || stored.rotatedAt === null
          ? null
          : stored.rotatedAt.toISOString(),
      narrowedOut,
    };
  }

  async function audit(
    kind: (typeof EVENT_KIND)[keyof typeof EVENT_KIND],
    outcome: 'success' | 'failure' | 'blocked',
    userId: string,
    detail: Record<string, unknown>,
    request: Parameters<typeof guards.contextOf>[0],
  ): Promise<void> {
    await recordSecurityEvent(pool, clock, {
      kind,
      outcome,
      userId,
      detail,
      context: guards.contextOf(request),
    });
  }

  return async (app) => {
    app.get(
      '/market-data/settings',
      {
        schema: {
          operationId: 'getMarketDataSettings',
          summary: 'Source priority, key presence, budgets and the licence obligations',
          description:
            'Key **presence** only — there is no field in this response that could carry a key ' +
            'value, and the exit test plants a synthetic key and asserts its bytes appear ' +
            'nowhere. `attribution` carries the exact licence string and its quoted clause, ' +
            'because a UI cannot render an obligation it was never told about (01 §4.3).',
          tags: ['market-data'],
          response: {
            200: z.object({
              providers: z.array(providerWire),
              ladders: z.array(ladderWire),
              /** Every obligation that binds on *this* screen. */
              settingsAttributions: z.array(attributionWire),
              allowedHostsNarrowed: z.boolean(),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const runtime = await viewFor(session.userId);
        // Prime the budgets from the run ledger so the numbers on this screen
        // are the real day's spend rather than this process's uptime.
        await hydrateMarketDataBudgets(database, session.userId, runtime.budgets, clock);

        const now = clock.now();
        const registered = new Map(runtime.sources.map((source) => [source.provider, source]));
        const providers = MARKET_DATA_PROVIDERS.map((provider) => {
          const source = registered.get(provider);
          const budget = runtime.budgets.get(provider);
          const keySource =
            provider === 'yfinance' ? ('none' as const) : runtime.keySources[provider];
          return {
            provider,
            keyPresent: keySource !== 'none',
            keySource,
            // OpenFIGI is not a `PriceSource` — it is the resolver's mapper —
            // so "registered" for it means the mapper exists, not that a price
            // source does. Reported truthfully rather than as a false `false`.
            registered: provider === 'openfigi' ? runtime.figi !== undefined : source !== undefined,
            capabilities: source?.capabilities ?? {
              prices: false,
              fx: false,
              macro: false,
              search: false,
            },
            budget:
              source !== undefined
                ? source.budget(now).map((entry) => ({ ...entry }))
                : budget === undefined
                  ? []
                  : budget.spent(now).map((entry) => ({
                      label: entry.window.label,
                      used: entry.used,
                      limit: entry.window.limit,
                    })),
            attribution: attributionWireOf(provider),
          };
        });

        const ladderRowsRead = await database.execute<LadderRow>(sql`
          SELECT security_kind, source, rung, enabled
            FROM price_source_priority
           WHERE user_id = ${session.userId}::uuid
           ORDER BY security_kind, rung
        `);
        const byKind = new Map<string, { source: LadderRow['source']; rung: number }[]>();
        for (const row of ladderRowsRead.rows) {
          if (!row.enabled) continue;
          const list = byKind.get(row.security_kind) ?? [];
          list.push({ source: row.source, rung: row.rung });
          byKind.set(row.security_kind, list);
        }

        return {
          providers,
          ladders: [...byKind]
            .map(([securityKind, sources]) => ({ securityKind, sources }))
            .sort((a, b) => a.securityKind.localeCompare(b.securityKind)),
          settingsAttributions: MARKET_DATA_PROVIDERS.filter(
            (provider) =>
              ATTRIBUTIONS[provider].required &&
              ATTRIBUTIONS[provider].surfaces.includes('settings'),
          ).map(attributionWireOf),
          allowedHostsNarrowed: config.marketData.allowedHosts.length > 0,
        };
      },
    );

    app.put(
      '/market-data/priority',
      {
        schema: {
          operationId: 'putMarketDataPriority',
          summary: 'Reorder the price-source ladder for one security kind',
          description:
            'Needs a step-up assertion: this decides which provider’s number becomes the price ' +
            'of everything the user owns. Rung numbers are **computed**, not accepted — ' +
            '`user_override` is pinned to 1 and `last_known` to 99 by CHECK constraints, and a ' +
            'client that could choose them could disable the one rung a human controls.',
          tags: ['market-data'],
          body: z.object({
            securityKind: z.enum([
              'equity',
              'etf',
              'mutual_fund',
              'crypto',
              'bond',
              'cash',
              'other',
            ]),
            sources: z.array(z.enum(PRICE_SOURCES)).min(1),
          }),
          response: {
            200: ladderWire,
            ...problems(400, 401, 403, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const seen = new Set(request.body.sources);
        if (seen.size !== request.body.sources.length) {
          throw new AppError({
            status: 400,
            code: 'market_data.duplicate_rung',
            title: 'Bad Request',
            detail: 'a source may appear in the ladder at most once',
            family: 'user',
          });
        }

        const rows = ladderRows(session.userId, request.body.securityKind, request.body.sources);

        await database.transaction(async (tx) => {
          // Replace, never merge: a ladder is an ordered whole, and an upsert
          // per rung would leave a source the user removed sitting at its old
          // rung, still answering.
          await tx
            .delete(priceSourcePriority)
            .where(
              and(
                eq(priceSourcePriority.userId, session.userId),
                eq(priceSourcePriority.securityKind, request.body.securityKind),
              ),
            );
          await tx.insert(priceSourcePriority).values(
            rows.map((row) => ({
              id: newId(),
              userId: row.userId,
              securityKind: row.securityKind,
              rung: row.rung,
              source: row.source,
            })),
          );
        });

        return {
          securityKind: request.body.securityKind,
          sources: rows.map((row) => ({ source: row.source, rung: row.rung })),
        };
      },
    );

    app.post(
      '/market-data/test-fetch',
      {
        schema: {
          operationId: 'testMarketDataFetch',
          summary: 'One guarded live call to a provider, to prove a key works',
          description:
            'Needs a step-up assertion — this is the only route in this work package that ' +
            'leaves the machine. It goes through the **existing** `PriceSource`, so it inherits ' +
            'WP 2.4’s egress allow-list, the literal-IP and private-address refusals, the ' +
            'timeout and the rate budget, and it spends against that budget like any other ' +
            'call. With no key configured it answers `skipped_no_key` and makes no request at ' +
            'all. No response field can carry a key value, and any provider error text is run ' +
            'through `redactedMessageOf` before it is returned.',
          tags: ['market-data'],
          body: z.object({
            provider: z.enum(MARKET_DATA_PROVIDERS),
            /** A ticker for Tiingo, a coin id for CoinGecko. Ignored by FRED. */
            symbol: z.string().min(1).max(64).optional(),
            date: dateOnly.optional(),
          }),
          response: {
            200: z.object({
              provider: z.string(),
              operation: z.literal('test_fetch'),
              /** `ok`, `no_data`, `skipped_no_key`, `rate_limited`, `refused` or `error`. */
              outcome: z.enum([
                'ok',
                'no_data',
                'skipped_no_key',
                'rate_limited',
                'refused',
                'error',
              ]),
              /** Present on `ok`: what came back, with its attribution. */
              quote: z
                .object({
                  date: dateOnly,
                  value: z.string(),
                  currency: z.string().nullable(),
                  attribution: attributionWire,
                })
                .nullable(),
              /** Redacted before it is returned. Never provider-authored raw text. */
              detail: z.string().nullable(),
              refusalCode: z.string().nullable(),
              retryAfterMs: z.int().nonnegative().nullable(),
              budget: z.array(
                z.object({
                  label: z.string(),
                  used: z.int().nonnegative(),
                  limit: z.int().nonnegative(),
                }),
              ),
            }),
            ...problems(400, 401, 403, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const provider = request.body.provider;
        const runtime = await viewFor(session.userId);
        await hydrateMarketDataBudgets(database, session.userId, runtime.budgets, clock);
        const source: PriceSource | undefined = runtime.sources.find(
          (candidate) => candidate.provider === provider,
        );
        const startedAt = clock.now();
        const date = request.body.date ?? (await todayFor(deps));
        const budgetOf = (): { label: string; used: number; limit: number }[] =>
          source === undefined ? [] : source.budget(clock.now()).map((entry) => ({ ...entry }));

        if (source === undefined) {
          // No key, or narrowed out of the allow-list. Either way no request is
          // made, and the honest answer is a configuration state and not a
          // failure (§6 of the dispatch: "Phase 3 completes with zero keys").
          return {
            provider,
            operation: 'test_fetch' as const,
            outcome: 'skipped_no_key' as const,
            quote: null,
            detail:
              `No ${provider} price source is registered: either no key is set (by file or in ` +
              'Settings) or MARKET_DATA_ALLOWED_HOSTS excludes its host.',
            refusalCode: null,
            retryAfterMs: null,
            budget: [],
          };
        }

        let outcome: SourceOutcome<{ date: string; value: string; currency: string | null }>;
        try {
          if (source.capabilities.prices) {
            const symbol = request.body.symbol;
            if (symbol === undefined) {
              throw new AppError({
                status: 400,
                code: 'market_data.symbol_required',
                title: 'Bad Request',
                detail: `${provider} prices a subject; pass a symbol (a ticker, or a coin id).`,
                family: 'user',
              });
            }
            const result = await source.price({
              subject:
                provider === 'coingecko'
                  ? { kind: 'coin_id', coinId: symbol }
                  : { kind: 'ticker', symbol, mic: null },
              date,
              currency: 'USD',
            });
            outcome =
              result.kind === 'ok'
                ? {
                    kind: 'ok',
                    value: {
                      date: result.value.date,
                      value: result.value.close,
                      currency: result.value.currency,
                    },
                  }
                : result;
          } else if (source.capabilities.fx) {
            // FRED. `fxRate` is the one `PriceSource` method it implements that
            // proves the key end to end without this route having to know a
            // series id.
            const result = await source.fxRate('USD', 'EUR', date);
            outcome =
              result.kind === 'ok'
                ? {
                    kind: 'ok',
                    value: { date: result.value.date, value: result.value.rate, currency: 'EUR' },
                  }
                : result;
          } else {
            outcome = { kind: 'error', detail: `${provider} exposes no testable operation` };
          }
        } catch (error) {
          if (error instanceof AppError) throw error;
          outcome = { kind: 'error', detail: redactedMessageOf(error, runtime.keys) };
        }

        const finishedAt = clock.now();
        const kind = outcome.kind;
        // Recorded, so the manual test spends against the same ledger the
        // nightly refresh does. A test fetch that was invisible to
        // `market_data_runs` would be a way to spend a free tier's daily
        // allowance without the budget ever noticing.
        await createMarketDataRunRecorder(database).record({
          userId: session.userId,
          provider,
          operation: 'test_fetch',
          startedAt,
          finishedAt,
          outcome:
            kind === 'ok'
              ? 'ok'
              : kind === 'no_data'
                ? 'partial'
                : kind === 'skipped_no_key'
                  ? 'skipped_no_key'
                  : kind === 'rate_limited'
                    ? 'rate_limited'
                    : kind === 'refused'
                      ? 'refused'
                      : 'failed',
          requestsMade: kind === 'skipped_no_key' ? 0 : 1,
          unitsSpent: kind === 'skipped_no_key' ? 0 : 1,
          symbolsAsked: 1,
          rowsWritten: 0,
          refusalCode: kind === 'refused' ? outcome.code : null,
          errorMessage:
            kind === 'error' || kind === 'no_data' || kind === 'rate_limited'
              ? redactSafely(outcome.detail, runtime)
              : null,
          retryAfterMs: kind === 'rate_limited' ? outcome.retryAfterMs : null,
        });

        return {
          provider,
          operation: 'test_fetch' as const,
          outcome: kind === 'ok' ? ('ok' as const) : kind,
          quote:
            outcome.kind === 'ok'
              ? {
                  date: DateOnly.is(outcome.value.date) ? outcome.value.date : date,
                  value: outcome.value.value,
                  currency: outcome.value.currency,
                  attribution: attributionWireOf(provider),
                }
              : null,
          detail:
            outcome.kind === 'no_data' ||
            outcome.kind === 'error' ||
            outcome.kind === 'rate_limited' ||
            outcome.kind === 'refused'
              ? redactSafely(outcome.detail, runtime)
              : null,
          refusalCode: outcome.kind === 'refused' ? outcome.code : null,
          retryAfterMs: outcome.kind === 'rate_limited' ? outcome.retryAfterMs : null,
          budget: budgetOf(),
        };
      },
    );

    // -------------------------------------------------------------------------
    // WP 10.4: a holder's own market-data keys, beside the settings they feed.
    //
    // GET needs a session and never returns a key: where it comes from, the
    // four-character hint, dates. PUT and DELETE need a fresh step-up (D21), as
    // Plaid's do — the moment a provider credential enters or leaves the
    // install. The operator's non-empty secret file wins: GET says `file`, PUT
    // is refused with 409 rather than stored and silently ignored. PUT checks
    // the key with one cheap live call through the existing adapter before
    // anything is sealed (`market-data-keys.ts`). The worker picks a change up
    // from `connections.ProviderCredentialsChanged` within its 30 s cache; this
    // process builds its view per request, so it sees the change at once.
    // -------------------------------------------------------------------------

    app.get(
      '/market-data/providers/:provider/credentials',
      {
        schema: {
          operationId: 'getMarketDataCredentials',
          summary: 'Where a market-data key comes from, without the key',
          description:
            "Whether a key for this provider is in force, and whether it is the operator's " +
            'secret file (read-only here), this holder’s stored key, or neither — and for ' +
            'OpenFIGI, whether the anonymous tier is in use. Carries the last four characters ' +
            'of a stored key and its dates. The key is never returned (WP 10.4).',
          tags: ['market-data'],
          params: providerParams,
          response: { 200: credentialsStatusWire, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return statusFor(session.userId, request.params.provider);
      },
    );

    app.put(
      '/market-data/providers/:provider/credentials',
      {
        schema: {
          operationId: 'putMarketDataCredentials',
          summary: 'Store (or replace) this holder’s key for one market-data provider',
          description:
            'Needs a step-up assertion (D21). Checks the key with the provider (one cheap ' +
            'authenticated call through the existing adapter) before sealing it under the KEK. ' +
            "409 when the operator's secret file supplies this provider's key; 409 " +
            '`market_data.provider_narrowed_out` when MARKET_DATA_ALLOWED_HOSTS excludes the ' +
            'host; 422 when the provider refuses the key; 502 when it cannot be reached. ' +
            'Nothing is stored unless the provider accepted the key. The response is the GET ' +
            'shape; the key is never returned.',
          tags: ['market-data'],
          params: providerParams,
          body: keyBody,
          response: {
            200: credentialsStatusWire,
            ...problems(400, 401, 403, 409, 422, 502, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const provider = request.params.provider;
        const { key } = request.body;
        if (fileHasKey(provider)) {
          throw new AppError({
            status: 409,
            code: 'provider_credentials.managed_by_files',
            title: 'Conflict',
            detail:
              `The ${DISPLAY_NAME[provider]} key is supplied by the operator's secret file, which takes ` +
              `precedence. Empty ${String(KEY_SECRET[provider])} in the secrets directory to ` +
              'use a stored key.',
            family: 'domain',
          });
        }
        const { secretBox } = deps.connections();

        const startedAt = clock.now();
        const validation = await validateMarketDataKey({
          provider,
          key,
          allowedHosts: config.marketData.allowedHosts,
          clock,
          ...(options.transport === undefined ? {} : { transport: options.transport }),
          ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
        });
        if (validation.verdict !== 'narrowed_out') {
          // The check spends against the same ledger the nightly refresh does,
          // as a test fetch: a validation invisible to `market_data_runs` would
          // be a way to spend a free tier without the budget noticing.
          await createMarketDataRunRecorder(database).record({
            userId: session.userId,
            provider,
            operation: 'test_fetch',
            startedAt,
            finishedAt: clock.now(),
            outcome:
              validation.verdict === 'accepted'
                ? 'ok'
                : validation.verdict === 'rejected'
                  ? 'refused'
                  : 'failed',
            requestsMade: 1,
            unitsSpent: 1,
            symbolsAsked: 1,
            rowsWritten: 0,
            refusalCode:
              validation.verdict === 'rejected' ? `http_${String(validation.status)}` : null,
            errorMessage: null,
            retryAfterMs: null,
          });
        }
        if (validation.verdict !== 'accepted') {
          await audit(
            EVENT_KIND.set,
            validation.verdict === 'narrowed_out' ? 'blocked' : 'failure',
            session.userId,
            { provider, reason: validation.verdict },
            request,
          ).catch(() => undefined);
          // Fixed copy only: a provider's prose is never repeated to the client.
          if (validation.verdict === 'narrowed_out') {
            throw new AppError({
              status: 409,
              code: 'market_data.provider_narrowed_out',
              title: 'Conflict',
              detail:
                `MARKET_DATA_ALLOWED_HOSTS excludes ${DISPLAY_NAME[provider]}'s host, so the key cannot be ` +
                'checked or used. Nothing was saved.',
              family: 'domain',
            });
          }
          if (validation.verdict === 'rejected') {
            throw new AppError({
              status: 422,
              code: 'provider_credentials.rejected',
              title: 'Unprocessable Content',
              detail:
                `${DISPLAY_NAME[provider]} did not accept this key (HTTP ${String(validation.status)}). Check ` +
                'that it is the whole key, copied from your account with the provider. Nothing was saved.',
              family: 'connector',
            });
          }
          throw new AppError({
            status: 502,
            code: 'provider_credentials.provider_unavailable',
            title: 'Bad Gateway',
            detail: `${DISPLAY_NAME[provider]} could not be reached to check this key. Nothing was saved.`,
            family: 'connector',
          });
        }

        const result = await mapDomainErrors(() =>
          database.transaction((tx) =>
            setMarketDataKey(
              tx,
              { provider, key, secretBox },
              contextOf(deps, session.userId, String(request.id)),
            ),
          ),
        );
        await audit(
          result.rotated ? EVENT_KIND.rotated : EVENT_KIND.set,
          'success',
          session.userId,
          { provider },
          request,
        );
        return statusFor(session.userId, provider);
      },
    );

    app.delete(
      '/market-data/providers/:provider/credentials',
      {
        schema: {
          operationId: 'deleteMarketDataCredentials',
          summary: 'Remove this holder’s stored key for one market-data provider',
          description:
            'Needs a step-up assertion (D21). Deletes the sealed row and retires its key. ' +
            "Revokes nothing at the provider. Leaves an operator's secret file untouched. " +
            'Idempotent. Returns the GET shape.',
          tags: ['market-data'],
          params: providerParams,
          response: { 200: credentialsStatusWire, ...problems(401, 403, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const provider = request.params.provider;
        const { secretBox } = deps.connections();
        const removed = await mapDomainErrors(() =>
          database.transaction((tx) =>
            removeProviderCredentials(
              tx,
              { provider },
              contextOf(deps, session.userId, String(request.id)),
            ),
          ),
        );
        if (removed) {
          // After the delete committed: retiring a key is not transactional.
          await eraseCredentialKey(secretBox, session.userId, provider).catch(() => undefined);
          await audit(EVENT_KIND.removed, 'success', session.userId, { provider }, request);
        }
        return statusFor(session.userId, provider);
      },
    );
  };
};

/**
 * `@ctx/integrations`' own host per keyed provider, for the narrowing check the
 * status reports. Mirrors `domain.ts`'s `MARKET_DATA_PROVIDER_HOSTS`.
 */
const KEYED_PROVIDER_HOSTS: Readonly<Record<MarketDataKeyedProvider, string>> = Object.freeze({
  tiingo: 'api.tiingo.com',
  fred: 'api.stlouisfed.org',
  coingecko: 'api.coingecko.com',
  openfigi: 'api.openfigi.com',
});

function narrowedOutOf(provider: MarketDataKeyedProvider, narrowing: readonly string[]): boolean {
  return narrowing.length > 0 && !narrowing.includes(KEYED_PROVIDER_HOSTS[provider]);
}

/**
 * Belt **and** braces on provider-authored text.
 *
 * The adapters already redact, and `ApiKey.toString()` is `[redacted]`. This
 * runs the message past every key this process holds one more time on the way
 * out of the HTTP boundary, because the cost is a string scan and the failure it
 * prevents is a key in a response body.
 */
function redactSafely(text: string, runtime: MarketDataView): string {
  return redactedMessageOf(new Error(text), runtime.keys);
}
