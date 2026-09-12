// SPDX-License-Identifier: MIT

/**
 * Shared between `openapi-ts.config.ts` (the real generation target) and
 * `scripts/check-openapi-drift.mjs` (generates into a throwaway directory and
 * diffs it against the committed — well, gitignored-but-CI-built — output).
 * Plain `.mjs` so the drift-check script can `import()` it directly without
 * needing a TypeScript loader.
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
      { name: '@hey-api/sdk', asClass: false },
      '@tanstack/react-query',
    ],
  };
}
