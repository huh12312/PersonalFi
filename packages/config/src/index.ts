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
  type AppConfig,
  type LoadConfigOptions,
  type PublicEnvironmentConfig,
} from './load.ts';
export { ConfigError, type ConfigProblem } from './errors.ts';
export { redact, isRedacted, REDACTED_MARKER, type Redacted } from './redacted.ts';
export {
  environmentSchema,
  SECRET_SPECS,
  type EnvironmentConfig,
  type SecretName,
} from './schema.ts';
