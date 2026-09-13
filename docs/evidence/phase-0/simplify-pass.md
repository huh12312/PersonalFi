# Phase 0 simplify pass

Quality-only pass over `apps/api/src`, `apps/web/src`, and the `packages/*/src`
this repo owns. No behaviour change, no test or gate weakened, no dependency
added or removed.

Net across owned paths: **42 files changed, 378 insertions, 470 deletions**,
plus 4 new extracted modules (151 lines).

Verification: `pnpm typecheck` green, `pnpm --filter @app/web typecheck` green,
`pnpm exec eslint apps packages` clean, `pnpm exec prettier --check` clean on
every owned path, `pnpm run openapi` produces a **byte-identical**
`packages/contracts/openapi/openapi.json` (no wire change).

---

## Starting state

`HEAD` (`101e63d`) was a snapshot of a previous agent killed mid-edit.
`pnpm typecheck` was red with 11 `Cannot find name 'problems'` errors.

| file:line                                   | before → after                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/auth.ts:27`            | `import { AppError, problemSchema }` → `import { AppError, problems }` — `problems()` was already defined in `problem.ts:41`; only the import was missing. Typecheck green.                                                                                                       |
| `apps/web/src/api/pending-contracts.ts:110` | pre-existing `TS2379`: `let body = init.body` passed an explicit `body: undefined` into `RequestInit` under `exactOptionalPropertyTypes`. Now spread conditionally, so a safe method still reaches `fetch` with no body at all (the assertion `pending-contracts.test.ts` makes). |

---

## apps/api + @ctx/identity

| file:line                                           | before → after                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/auth.ts` (5 sites)             | remaining `400/401/403/409/429/503: problemSchema` entries → `...problems(...)`. All 29 `problemSchema` lines are now 11 `problems()` calls.                              |
| `apps/api/src/routes/auth.ts:86`                    | added `isoInstant` / `count` scalar aliases; 9 inline `z.string()`/`z.number().int()` now name what they carry.                                                           |
| `apps/api/src/routes/auth.ts:98`                    | TOTP regex `/^[0-9]{6,8}$/` declared once as `totpToken` (was twice).                                                                                                     |
| `apps/api/src/routes/auth.ts:101`                   | `trustedDevice: z.boolean().default(false)` declared once (was twice).                                                                                                    |
| `apps/api/src/routes/auth.ts:108`                   | `SECOND_AUTHENTICATOR_TARGET = 2`, used at both `< 2` sites (register-verify and credential-list) which must agree.                                                       |
| `apps/api/src/routes/auth.ts:173`                   | `contextOf()` annotated `: RequestContext`.                                                                                                                               |
| `apps/api/src/routes/auth.ts:737`                   | `serialiseCredential` takes `CredentialSummary` from `@ctx/identity` instead of a hand-copied 9-field type (done at HEAD; retained).                                      |
| `apps/api/src/routes/health.ts:8,162`               | last `problemSchema` → `problems(503)`.                                                                                                                                   |
| `apps/api/src/routes/health.ts:100`                 | extracted `toReadyBody()`; the `/ready` handler no longer builds a 20-line literal inline. `unavailable()` and `collectDegradedReasons()` were already extracted at HEAD. |
| `apps/api/src/platform.ts:45`                       | dead `Platform.pool` field removed (no reader anywhere).                                                                                                                  |
| `apps/api/src/platform.ts:53`                       | `BuildPlatformOptions.flagDefaults` / `.metrics` removed — never supplied by any caller incl. tests; defaults inlined.                                                    |
| `apps/api/src/auth/runtime.ts:73`                   | dead `SecurityRuntime.unlockState()` removed (the `SecretBox.unlockState()` of the same name is live and untouched).                                                      |
| `apps/api/src/auth/runtime.ts:93`                   | `users()` memoised into `#users`; `UserService` is stateless over `db`/`clock`, both fixed for the runtime's life, and `/auth/unlock-state` is polled.                    |
| `apps/api/src/auth/csrf.ts:27`                      | `newCsrfToken` un-exported (internal only). **No change to hashing or token size.**                                                                                       |
| `apps/api/src/plugins/`                             | empty directory removed.                                                                                                                                                  |
| `identity/src/db.ts:27`                             | dead `asOptionalBytes` removed.                                                                                                                                           |
| `identity/src/users.ts:112,127`                     | two inline `sha256(new TextEncoder().encode(token))` → the existing `hashToken()`. Byte-identical; `sha256` import dropped. **`csrf.ts` hashing untouched.**              |
| `identity/src/totp.ts:53`                           | dead `TotpServiceOptions.issuer` removed; default hoisted to `TOTP_ISSUER`.                                                                                               |
| `identity/src/recovery.ts:36,45`                    | dead `RecoveryCodeServiceOptions.hashParams` removed; `RECOVERY_CODE_HASH_PARAMS` un-exported. **Argon2 parameters unchanged.**                                           |
| `identity/src/webauthn.ts:398,402`                  | `base64UrlToBytes` / `bytesToBase64Url` un-exported (internal only) and dropped from the barrel.                                                                          |
| `identity/src/rate-limit.ts:183`, `webauthn.ts:376` | "WP 0.3's job runner" narration → the actual reason the row is safe to delete.                                                                                            |

## kernel / config / db / platform / testkit / seed

| file:line                            | before → after                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/src/index.ts:31,34`        | dead `redactionSchema` / `eventEnvelopeSchema` exports dropped.                                                                                                 |
| `platform/src/events/envelope.ts:22` | `redactionSchema` un-exported (still used internally by `newEventSchema`).                                                                                      |
| `platform/src/events/envelope.ts:47` | `eventEnvelopeSchema` was only ever read as `typeof` — `EventEnvelope` now derives from `newEventSchema` directly and the unused runtime schema object is gone. |
| `config/src/redacted.ts:3`           | `REDACTED_MARKER` was declared inline with no comment; now says why it is exported (the `apps/api` log redactor censors with the same string).                  |

Already done at HEAD and verified, not re-done: `kernel/src/result.ts` deleted +
barrel updated; `resetTypeParsersForTest` and `readJob` removed;
`tryAcquireAdvisoryLease`/`tryAcquireNamedAdvisoryLease` collapsed onto a shared
`tryAcquire`; `loadGolden`/`expectGolden` collapsed onto `readGolden`;
`RecordingLogger extends PlatformLogger`.

## apps/web/src

| file:line                                           | before → after                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/pending-contracts.ts:2`                        | 26-line header → 13 lines: what the generated client lacks (CSRF, empty-body, credentials), that migration is a call-shape change to `Options()`/`Mutation()` factories, and that 11 of 18 `/auth/*` operations are mirrored. The old header's "seven call sites" list and "all eighteen" claim were both stale. |
| `api/pending-contracts.ts:133,136,145,160`          | four zod schema consts un-exported (internal only); their inferred types stay exported.                                                                                                                                                                                                                          |
| `lib/theme.ts:63`                                   | new `useThemeToggle()` — the resolved value, the flip, and the destination label, replacing three hand-rolled copies in `TopBar`, `CommandPalette` and `LoginScreen`.                                                                                                                                            |
| `lib/webauthn-error.ts`                             | **new.** Shared `describeWebauthnError(cause, copy)` + `STEP_UP_ERROR_COPY`, replacing four copies of the `NotAllowedError` branch.                                                                                                                                                                              |
| `features/auth/use-step-up-unlock.ts`               | **new.** `useStepUpUnlock(onUnlocked)` — the step-up ceremony shared by `LockScreen` and `IdleLockOverlay`, which differed only in what they do on success.                                                                                                                                                      |
| `features/auth/AuthCard.tsx`                        | **new.** The full-screen auth card, replacing four copies (`Frame`, `CenteredCard`, `AuthScreenFrame`, and `LockScreen`'s inline version).                                                                                                                                                                       |
| `components/patterns/IconCircle.tsx`                | **new.** The 48px tinted circle, replacing two near-identical local `IconCircle`/`Icon` components with disjoint tone sets plus two inline copies.                                                                                                                                                               |
| `lib/money.ts:20`                                   | `WireMoney` alias removed; `parseWireMoney` and `Money.tsx` name the kernel's `MoneyJson` directly. The wire-shape rationale moved onto `parseWireMoney`.                                                                                                                                                        |
| `lib/money.ts:27`                                   | `MoneySign` un-exported.                                                                                                                                                                                                                                                                                         |
| `lib/persisted-store.ts:13`                         | `PersistedStore` un-exported.                                                                                                                                                                                                                                                                                    |
| `app/shell/CommandPalette.tsx:29`                   | literal `Cache^H^H^H^H^Hstyle` typo fixed.                                                                                                                                                                                                                                                                       |
| `app/shell/TopBar.tsx:38`                           | stale path `packages/api/pending-contracts.ts` → `src/api/pending-contracts.ts`.                                                                                                                                                                                                                                 |
| `types/jest-axe.d.ts:6`, `jest-axe-matchers.d.ts:4` | stale `routes/dev.kitchen-sink.test.tsx` → `routes/-dev.kitchen-sink.test.tsx` (the real filename).                                                                                                                                                                                                              |
| 13 files                                            | `gate-remediation-web.md <id>` / `WP 0.x` citations stripped, every reason kept. `_app.tsx` keeps the fetchQuery-vs-getSession reason as instructed.                                                                                                                                                             |

---

## Skipped, with reason

1. **`identity`'s `asDate`/`asOptionalDate` → platform's `toInstant`/`toInstantOrNull`.**
   The boundary lint does allow `identity → @core/platform`, but the behaviour is
   **not** identical: `asDate(value: unknown)` accepts only a `Date` and throws on
   anything else, while `toInstant(value: Date | string)` parses strings. Identity
   queries through raw `pg`, which returns `Date`, so the substitution would widen
   what is accepted at the row boundary for no gain, and would need a cast at every
   call site (`row['x']` is `unknown`). The brief required identical behaviour.

2. **testkit's `silentMigrationLogger` → platform's `silentLogger`.** Not
   type-compatible. `MigrationLogger.info(message: string)` vs
   `PlatformLogger.info(obj: Record<string, unknown>, msg?: string)` — different
   first parameter, so the substitution does not compile.

3. **Unifying seed's `pretty` with testkit's `serialize`.** Both are
   `` `${JSON.stringify(v, null, 2)}\n` ``, but `@core/seed` depends only on
   `@core/kernel` and `@core/testkit` is test tooling. There is no shared home
   without a new cross-dependency, so — per the brief — left alone.

4. **`BuildAppOptions.clock` (`apps/api/src/app.ts:42`).** Listed as dead and it
   is unsupplied, but it carries an explicit doc comment naming it a test seam
   ("so a session-expiry test does not have to wait eight hours"). Removing a
   documented seam is a judgement call, not a cleanup; left in place.
   `TotpServiceOptions.issuer` and `RecoveryCodeServiceOptions.hashParams` were
   removed because they are undocumented and unused.

5. **`IconCircle` for `EmptyState.tsx:48` and `routes/__root.tsx:29`.** Both carry
   extra attributes the shared component does not model (`aria-hidden` on the
   circle; `size={24} strokeWidth={1.75}`). Converting would either drop the
   accessibility attribute or widen the component's API for two call sites.

6. **`M-4` comment in `sessions.ts` and the `trustProxy` comment in `app.ts`** —
   excluded by the brief, untouched.

---

## Reported, not changed

- **Privacy-icon polarity is inverted between `TopBar` and `CommandPalette`.**
  `TopBar.tsx:77` renders `hideAmounts ? EyeOff : Eye`; `CommandPalette.tsx:93`
  renders `hideAmounts ? Eye : EyeOff`. Labels agree in both. Which is correct is
  **genuinely ambiguous**: `TopBar`'s privacy button sets `aria-pressed`, making
  it a state toggle whose icon should show current state; the palette entry is a
  command whose icon should show the action. Note that the _theme_ icon is
  action-oriented in both, which argues for the palette. Needs a product
  decision, not a refactor.

- **`credentialId` wire-name drift** (`auth.ts`'s `credentialSchema.credentialId`
  is the base64url credential id, while the `DELETE /auth/credentials/:credentialId`
  route parameter is the row's UUID). Left alone as instructed — it is a wire
  change, not a cleanup.

- **`ApiError` (`pending-contracts.ts:56`)** is exported but has no external
  consumer. Left exported: it is the error type every hook in the file can
  throw, so a call site adding a `catch` will want to name it.

---

## Tests

Counts before and after are equal; nothing was skipped, relaxed or deleted.

| suite                                                                                            | before                | after                 |
| ------------------------------------------------------------------------------------------------ | --------------------- | --------------------- |
| root vitest, non-db projects (kernel, config, platform, seed, secretbox, identity, api, testkit) | 271 passed, 4 skipped | 271 passed, 4 skipped |
| `identity-db`, `api-db`, `secretbox-db`                                                          | 143 passed            | 143 passed            |
| `@app/web` (vitest)                                                                              | 40 passed             | 40 passed             |

**Two failures in `|db| test/migrate.test.ts` are not from this pass.** They are
raised by `packages/db/migrations/0004_ledger.sql`, an uncommitted file belonging
to the concurrent ledger work, which declares `refund_confidence DOUBLE PRECISION`
(line 295) and `confidence DOUBLE PRECISION` (line 415). The migration-type gate
is doing exactly its job; the fix belongs to that work stream.
