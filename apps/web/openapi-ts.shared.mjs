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
      {
        name: '@hey-api/client-fetch',
        // gate-remediation-web.md M-2: the OpenAPI document's `servers` entry
        // is `http://127.0.0.1:8080` (a dev convenience, not a deployment
        // fact — Caddy proxies the SPA and the API from the same origin).
        // `baseUrl: false` stops the generator from baking that absolute URL
        // into `client.gen.ts` at all; `runtimeConfigPath` below sets the
        // *real* default (relative baseUrl + same-origin credentials) in a
        // hand-written file this generator never overwrites, so the fix
        // survives every `pnpm --filter @app/web gen` regardless of what the
        // contract's `servers` field says.
        baseUrl: false,
        runtimeConfigPath: './src/api/client-runtime-config.ts',
      },
      '@hey-api/typescript',
      { name: '@hey-api/sdk', operations: { strategy: 'single' } },
      '@tanstack/react-query',
    ],
  };
}
