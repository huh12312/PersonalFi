// SPDX-License-Identifier: MIT
/**
 * WP 5.2 — the adapter reaches the network only through `@core/platform`'s
 * local-endpoint transport. Three lines, and this file is the third:
 *
 *   1. `scripts/eslint-boundaries.js`, layer `advisor-local-model`:
 *      kernel, platform, contracts and `zod`; `allowNodeBuiltins: false`.
 *   2. `eslint.config.js`: `no-restricted-globals` for `fetch` and
 *      `WebSocket` on this package — a global needs no import, so a layer
 *      rule cannot see it.
 *   3. This test: it reads the shipped sources (`src/`, not tests) and fails
 *      on any builtin, any import outside the three packages, any dynamic
 *      import or `require`, and any network-shaped global — and it checks
 *      that lines 1 and 2 are still configured, so deleting either is red
 *      here even if nobody runs the linter.
 *
 * The scanner is proved non-vacuous against planted sources at the bottom.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const REPO = join(HERE, '..', '..', '..', '..');

const ALLOWED_PACKAGES = new Set(['@core/kernel', '@core/platform', '@core/contracts', 'zod']);
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** Globals that open a connection or a process, or read the environment. */
const FORBIDDEN_GLOBALS: readonly [string, RegExp][] = [
  ['fetch', /(?<![\w.$])fetch\s*\(|globalThis\s*(?:\.\s*|\[\s*['"`])fetch/u],
  ['WebSocket', /\bWebSocket\b/u],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/u],
  ['EventSource', /\bEventSource\b/u],
  ['process', /\bprocess\s*\./u],
  ['require', /(?<![\w.$])require\s*\(/u],
  ['dynamic import', /(?<![\w.$])import\s*\(/u],
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`\\])\/\/.*$/gmu, '$1');
}

export function violationsIn(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const match of code.matchAll(
    /(?:^|[\s;}])(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/gu,
  )) {
    const specifier = match[1] ?? '';
    if (specifier.startsWith('./')) continue;
    if (BUILTINS.has(specifier) || specifier.startsWith('node:'))
      found.push(`builtin ${specifier}`);
    else if (!ALLOWED_PACKAGES.has(specifier)) found.push(`package ${specifier}`);
  }
  for (const match of code.matchAll(/(?:^|[\s;])import\s*['"]([^'"]+)['"]/gu)) {
    found.push(`side-effect import ${match[1] ?? ''}`);
  }
  for (const [name, pattern] of FORBIDDEN_GLOBALS) {
    if (pattern.test(code)) found.push(`global ${name}`);
  }
  return found;
}

describe('structure', () => {
  it('the adapter imports no node builtin and calls no global fetch', () => {
    const files = readdirSync(SRC).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThanOrEqual(8);
    const report: Record<string, string[]> = {};
    for (const file of files) {
      const violations = violationsIn(readFileSync(join(SRC, file), 'utf8'));
      if (violations.length > 0) report[file] = violations;
    }
    expect(report).toEqual({});
    // No test lives in src/: the builtin exemption for tests must not cover shipped code.
    expect(readdirSync(SRC).filter((name) => name.endsWith('.test.ts'))).toEqual([]);

    // Line one: the layer is still there, with builtins off.
    const boundaries = readFileSync(join(REPO, 'scripts', 'eslint-boundaries.js'), 'utf8');
    const layer =
      /name:\s*'advisor-local-model',\s*prefix:\s*'packages\/advisors\/local-model\/',\s*allow:\s*\[([^\]]*)\],\s*allowNodeBuiltins:\s*false/u.exec(
        boundaries,
      );
    expect(layer, 'the advisor-local-model layer with allowNodeBuiltins: false').not.toBeNull();
    expect(layer?.[1]).not.toMatch(/@ctx\//u);

    // Line two: the global ban is still scoped to this package.
    const eslintConfig = readFileSync(join(REPO, 'eslint.config.js'), 'utf8');
    const block =
      /files:\s*\['packages\/advisors\/local-model\/\*\*\/\*\.ts'\][\s\S]*?'no-restricted-globals'[\s\S]*?name:\s*'fetch'[\s\S]*?name:\s*'WebSocket'/u;
    expect(block.test(eslintConfig), 'no-restricted-globals fetch/WebSocket for the adapter').toBe(
      true,
    );
  });

  it('WP 10.6: the only absolute URLs in shipped code are the three hosted providers, each in one policy', () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith('.ts'));
    const urls = new Set<string>();
    for (const file of files) {
      const code = stripComments(readFileSync(join(SRC, file), 'utf8'));
      for (const match of code.matchAll(/https?:\/\/[A-Za-z0-9.-]+/gu)) urls.add(match[0]);
    }
    // `https://${host}` is built from HOSTED_MODEL_HOSTS; the one literal is
    // OpenRouter's attribution Referer, a header value, never dialled.
    expect([...urls].sort()).toEqual(['https://github.com']);
    const hosted = stripComments(readFileSync(join(SRC, 'hosted.ts'), 'utf8'));
    expect(hosted.match(/createEgressPolicy\(/gu)).toHaveLength(1);
    expect(hosted).toMatch(/allowedHosts:\s*\[host\]/u);
    expect(hosted).toMatch(/const host = HOSTED_MODEL_HOSTS\[provider\]/u);
    expect(hosted).toMatch(
      /const url = `https:\/\/\$\{host\}\$\{HOSTED_MODEL_PATHS\[provider\]\}`/u,
    );
  });

  it('the scanner is not vacuous: each planted violation is caught', () => {
    const planted: [string, string][] = [
      ["import http from 'node:http';", 'builtin node:http'],
      ["import { request } from 'https';", 'builtin https'],
      ["export { x } from 'node:net';", 'builtin node:net'],
      ["import { Ollama } from 'ollama';", 'package ollama'],
      ["import { thing } from '@ctx/insights';", 'package @ctx/insights'],
      ["import 'undici';", 'side-effect import undici'],
      ["const r = await fetch('http://ollama:11434/api/tags');", 'global fetch'],
      ['const r = await globalThis.fetch(url);', 'global fetch'],
      ["const r = globalThis['fetch'];", 'global fetch'],
      ['const ws = new WebSocket(url);', 'global WebSocket'],
      ['const host = process.env.OLLAMA_HOST;', 'global process'],
      ["const net = require('net');", 'global require'],
      ["const m = await import('node:http');", 'global dynamic import'],
    ];
    for (const [source, expected] of planted) {
      expect(violationsIn(source), source).toContain(expected);
    }
    // …and the things the real sources do are not flagged.
    expect(
      violationsIn(
        "import { canonicalJson } from '@core/platform';\n// fetch( in a comment\nconst url = 'http://x'; // fetch(\nimport type { Clock } from '@core/kernel';",
      ),
    ).toEqual([]);
  });
});
