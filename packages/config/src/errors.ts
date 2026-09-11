// SPDX-License-Identifier: MIT

export interface ConfigProblem {
  /** The env var or secret name, e.g. `DATABASE_URL` or `secret:database_url`. */
  readonly key: string;
  /** What is wrong. Never contains the offending value if the key is a secret. */
  readonly problem: string;
  /** What to do about it. */
  readonly hint: string;
}

/**
 * Raised once, at boot, listing *every* problem rather than the first.
 *
 * A container that starts in a half-configured state and fails at 03:15 during a
 * sync is far worse than one that never starts.
 */
export class ConfigError extends Error {
  readonly code = 'config.invalid';
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    const lines = problems.map((p) => `  - ${p.key}: ${p.problem}\n      fix: ${p.hint}`);
    super(
      `configuration is invalid; ${problems.length} problem(s) found:\n${lines.join('\n')}\n` +
        'See .env.example and docs/CONVENTIONS.md "Configuration".',
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}
