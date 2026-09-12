// SPDX-License-Identifier: MIT
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { boundariesPlugin, CRYPTO_PRIMITIVES } from './scripts/eslint-boundaries.js';

/**
 * Flat config. Three layers:
 *
 *   1. baseline correctness rules for every TypeScript file;
 *   2. the cross-cutting bans the memos call for — `process.env` outside
 *      `@core/config`, and wall-clock reads outside the kernel's `Clock`;
 *   3. the dependency rule, enforced by `personalfi/layer-imports`.
 *
 * Layer 3 is the point. Discipline that isn't mechanised is a wish: a comment in
 * a README will not stop a context importing another context at 23:00 on a
 * Thursday, and by the time it matters the graph is a ball of mud.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.drizzle/**',
      'packages/contracts/openapi/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { personalfi: boundariesPlugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'personalfi/layer-imports': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // `process.env` has exactly one legitimate reader (08 §6.1). Config that can be
  // read from anywhere cannot be validated anywhere.
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    // Test files and the fixtures they boot are exempt: a harness that spawns a
    // worker process has to read the environment it was given, and a test that
    // waits for a deadline has to read a wall clock.
    ignores: ['packages/config/src/**', '**/*.test.ts', '**/test/**', '**/drizzle.config.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration through @core/config, which validates it at boot. ' +
            'Add the key to packages/config/src/schema.ts instead.',
        },
      ],
    },
  },

  // Wall-clock reads go through `Clock` (08 §6.5). Time-dependent bugs are the
  // dominant bug class in budgeting and recurring detection, and an injected
  // clock is what makes those tests deterministic rather than flaky.
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    ignores: ['packages/kernel/src/clock.ts', '**/*.test.ts', '**/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Inject a Clock from @core/kernel instead of calling Date.now().',
        },
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message: 'Inject a Clock from @core/kernel instead of constructing new Date().',
        },
      ],
    },
  },

  // Cryptography has exactly one legitimate call site (03 §2, WP 0.2).
  //
  // `personalfi/layer-imports` already denies the primitive packages everywhere
  // outside `packages/secretbox/`. This adds the two halves that an allow-list
  // cannot express: `node:crypto` is a *builtin*, allowed at every layer for
  // `readFile` and friends, and within `@core/secretbox` itself the primitives
  // must stay in `src/primitives.ts` rather than spreading across the package.
  //
  // The failure this prevents is not a broken cipher. It is the second call site
  // that reuses a nonce, drops the AAD, or compares a tag with `===`.
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    ignores: ['packages/secretbox/src/primitives.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:crypto',
              message:
                'Cryptography lives in @core/secretbox. Use SecretBox.seal/open, or one of the ' +
                'primitives it re-exports (randomBytes, sha256, constantTimeEqual).',
            },
            {
              name: 'crypto',
              message: 'Use @core/secretbox; and prefer the node: prefix for builtins.',
            },
          ],
          patterns: CRYPTO_PRIMITIVES.map((name) => ({
            group: [name, `${name}/*`],
            message:
              `${name} may be imported only in packages/secretbox/src/primitives.ts, the single ` +
              'audited crypto call site. Reach it through @core/secretbox.',
          })),
        },
      ],
    },
  },

  {
    files: [
      '**/*.test.ts',
      '**/test/**/*.ts',
      'scripts/**/*.ts',
      'packages/db/src/cli/**/*.ts',
      'apps/api/src/cli/**/*.ts',
    ],
    rules: { 'no-console': 'off' },
  },

  // Config files and scripts are plain JS and are not part of the type program.
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
