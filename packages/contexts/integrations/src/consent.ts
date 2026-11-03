// SPDX-License-Identifier: MIT
/**
 * The holder half of an opt-in market-data provider (WP 12.6, D33;
 * docs/research/14 §3 "Consent (the holder half)").
 *
 * Yahoo through yfinance needs two independent halves before a single request
 * leaves the machine:
 *
 *   1. **The operator's** — `YAHOO_FINANCE_ENABLED=true` in `.env` and the
 *      `yahoo` compose profile up. Without it the worker never builds the
 *      adapter (`createMarketDataRuntime`), and the adapter itself refuses
 *      (`createYfinancePriceSource`'s `operatorEnabled`).
 *   2. **The holder's** — a standing consent here, to the *current* text
 *      version and its sha256. The text is the composition root's
 *      (`apps/api/src/yahoo-consent.ts`), because the hash is computed with
 *      `@core/secretbox` there, as the narrator's is.
 *
 * `standingConsentHolds` is what the adapter asks before **every** request, so
 * a consent withdrawn between the worker caching its view and the next call
 * still stops that call. Withdrawing is never a delete: `withdrawn_at` is set,
 * and the row stays as the record of what was agreed and when.
 *
 * Every function takes the caller's executor; call `give`/`withdraw` inside a
 * transaction, so the priority change the route makes alongside commits with it.
 */
import type { Database } from '@core/db';
import { newId, type Clock } from '@core/kernel';
import { and, eq, isNull } from 'drizzle-orm';
import { marketDataConsents, type ConsentedMarketDataProvider } from '../schema/index.ts';

export type ConsentExecutor = Pick<Database, 'select' | 'insert' | 'update'>;

/** The wording a holder is shown, by version, with the sha256 of its exact bytes. */
export interface ConsentText {
  readonly version: string;
  /** `sha256:` + 64 lowercase hex. */
  readonly sha256: string;
}

export interface MarketDataConsentView {
  readonly provider: ConsentedMarketDataProvider;
  readonly consentTextVersion: string;
  readonly consentTextSha256: string;
  readonly consentedAt: Date;
}

/** The standing consent, whatever its version, or `null`. */
export async function readMarketDataConsent(
  executor: Pick<Database, 'select'>,
  userId: string,
  provider: ConsentedMarketDataProvider,
): Promise<MarketDataConsentView | null> {
  const rows = await executor
    .select({
      provider: marketDataConsents.provider,
      consentTextVersion: marketDataConsents.consentTextVersion,
      consentTextSha256: marketDataConsents.consentTextSha256,
      consentedAt: marketDataConsents.consentedAt,
    })
    .from(marketDataConsents)
    .where(
      and(
        eq(marketDataConsents.userId, userId),
        eq(marketDataConsents.provider, provider),
        isNull(marketDataConsents.withdrawnAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Does a standing consent to exactly `current` (version **and** bytes) exist? */
export function consentIsCurrent(
  consent: MarketDataConsentView | null,
  current: ConsentText,
): boolean {
  return (
    consent !== null &&
    consent.consentTextVersion === current.version &&
    consent.consentTextSha256 === current.sha256
  );
}

/** One read: the holder half, for the adapter's per-request gate. */
export async function standingConsentHolds(
  executor: Pick<Database, 'select'>,
  userId: string,
  provider: ConsentedMarketDataProvider,
  current: ConsentText,
): Promise<boolean> {
  return consentIsCurrent(await readMarketDataConsent(executor, userId, provider), current);
}

/**
 * Record the holder's consent to `current`. Idempotent for the same text; a
 * standing consent to an older text is withdrawn first, so there is at most one
 * standing row (the partial unique index holds it too).
 */
export async function giveMarketDataConsent(
  executor: ConsentExecutor,
  input: {
    readonly userId: string;
    readonly provider: ConsentedMarketDataProvider;
    readonly current: ConsentText;
    readonly clock: Clock;
  },
): Promise<MarketDataConsentView> {
  const existing = await readMarketDataConsent(executor, input.userId, input.provider);
  if (consentIsCurrent(existing, input.current) && existing !== null) return existing;
  const now = input.clock.now();
  if (existing !== null) {
    await withdrawMarketDataConsent(executor, { ...input });
  }
  await executor.insert(marketDataConsents).values({
    id: newId(),
    userId: input.userId,
    provider: input.provider,
    consentTextVersion: input.current.version,
    consentTextSha256: input.current.sha256,
    consentedAt: now,
  });
  return {
    provider: input.provider,
    consentTextVersion: input.current.version,
    consentTextSha256: input.current.sha256,
    consentedAt: now,
  };
}

/** Withdraw the standing consent, if any. Returns whether one was standing. */
export async function withdrawMarketDataConsent(
  executor: ConsentExecutor,
  input: {
    readonly userId: string;
    readonly provider: ConsentedMarketDataProvider;
    readonly clock: Clock;
  },
): Promise<boolean> {
  const rows = await executor
    .update(marketDataConsents)
    .set({ withdrawnAt: input.clock.now() })
    .where(
      and(
        eq(marketDataConsents.userId, input.userId),
        eq(marketDataConsents.provider, input.provider),
        isNull(marketDataConsents.withdrawnAt),
      ),
    )
    .returning({ id: marketDataConsents.id });
  return rows.length > 0;
}
