// SPDX-License-Identifier: MIT
/**
 * `@core/testkit` — shared test infrastructure (WP 0.6).
 *
 * Generalised from `packages/platform/test/harness.ts` (WP 0.3) so every
 * `*-db` project in `vitest.config.ts` — db, platform, secretbox, identity, and
 * whatever bounded context needs one next — shares one scratch-database
 * implementation, one process-spawning drill harness, and one golden-fixture
 * format, instead of five copies drifting apart one bug fix at a time.
 *
 * Never imported by production code. It is dev/test tooling: a scratch
 * database, a recording logger, a deterministic clock, process-spawning drills,
 * golden fixtures. See `OWNERSHIP.md`.
 *
 * Lives in `test/`, not `src/` — see "Why this package's source lives in
 * test/, not src/" in `OWNERSHIP.md` before moving anything out of it.
 */
export {
  ADMIN_URL,
  createTestDatabase,
  endPool,
  type CreateTestDatabaseOptions,
  type TestDatabase,
} from './database.ts';
export { recordingLogger, type RecordingLogger } from './logger.ts';
export { waitFor, type WaitForOptions } from './wait.ts';
export { spawnProcess, type SpawnedProcess, type SpawnProcessOptions } from './process.ts';
export { withTempSecretsDir } from './secrets.ts';
export {
  loadGolden,
  expectGolden,
  goldenUpdateRequested,
  type GoldenLocation,
  type ExpectGoldenOptions,
} from './golden.ts';
export { toInstant, toInstantOrNull, type TimestampValue } from './instant.ts';

// `fixedClock` already lives in `@core/kernel` (WP 0.1); re-exported here so a
// test file that is otherwise entirely `@core/testkit` (database + clock +
// logger) does not need a second import line for one function.
export { fixedClock, type Clock } from '@core/kernel';
