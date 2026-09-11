// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config';

/**
 * One root config with a project per package.
 *
 * Unit projects must not need Postgres: the whole point of pure kernel types and
 * pure engines is that most of the suite runs in milliseconds. The `db`
 * integration project is separate and skips itself when `DATABASE_URL` is unset,
 * so `pnpm test` works on a laptop with nothing running.
 */
export default defineConfig({
  test: {
    projects: [
      {
        root: './packages/kernel',
        test: { name: 'kernel', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        root: './packages/config',
        test: { name: 'config', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        root: './packages/db',
        test: {
          name: 'db',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          // Applying migrations is not parallel-safe against one database.
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        root: './apps/api',
        test: { name: 'api', include: ['test/**/*.test.ts'], environment: 'node' },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/cli/**'],
    },
  },
});
