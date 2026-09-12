// SPDX-License-Identifier: MIT

/**
 * Shared between `openapi-ts.config.ts` (the real generation target) and
 * `scripts/check-openapi-drift.mjs` (generates into a throwaway directory and
 * diffs it against the committed — well, gitignored-but-CI-built — output).
 * Plain `.mjs` so the drift-check script can `import()` it directly without
 * needing a TypeScript loader.
 */
/**
 * The JSDoc annotation matters, not just documents: without it, TypeScript
 * (via `allowJs`/`checkJs` in tsconfig.node.json) infers `plugins[2].name` as
 * the widened type `string` instead of the literal `'@hey-api/sdk'` the
 * `UserConfig` union needs to discriminate on, and both `openapi-ts.config.ts`
 * and `scripts/check-openapi-drift.ts` fail to typecheck.
 *
 * @param {string} outputPath
 * @returns {import('@hey-api/openapi-ts').UserConfig}
 */
export function buildOpenApiConfig(outputPath) {
  return {
    input: '../../packages/contracts/openapi/openapi.json',
    output: {
      path: outputPath,
      clean: true,
    },
    plugins: [
      '@hey-api/client-fetch',
      '@hey-api/typescript',
      { name: '@hey-api/sdk', operations: { strategy: 'single' } },
      '@tanstack/react-query',
    ],
  };
}
