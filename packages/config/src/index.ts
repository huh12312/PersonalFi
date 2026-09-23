// SPDX-License-Identifier: MIT
/**
 * `@core/config` — typed configuration, validated once at boot.
 *
 * Nothing outside this package reads `process.env`. That is a lint rule, not a
 * convention: config that can be read from anywhere cannot be validated anywhere.
 */
export {
  loadConfig,
  describeConfig,
  describeKek,
  PLAID_CALLABLE_ENVIRONMENTS,
  type AllowedHostsConfig,
  type AppConfig,
  type CoinbaseConfig,
  type KekConfig,
  type LoadConfigOptions,
  type NotificationsConfig,
  type PlaidCallableEnvironment,
  type PlaidConfig,
  type PublicEnvironmentConfig,
} from './load.ts';
export {
  assessKekMemory,
  describeKekMemory,
  readCgroupMemoryLimitBytes,
  KEK_MEMORY_WARN_RATIO,
  type KekMemoryBudget,
} from './memory.ts';
export { ConfigError, type ConfigProblem } from './errors.ts';
export { redact, isRedacted, REDACTED_MARKER, type Redacted } from './redacted.ts';
export {
  environmentSchema,
  SECRET_SPECS,
  KEK_ARGON2_FLOORS,
  type Argon2Params,
  type EnvironmentConfig,
  type SecretName,
} from './schema.ts';
