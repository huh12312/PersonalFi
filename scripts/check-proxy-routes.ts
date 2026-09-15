#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * gate-security-review.md F-4/C-1a/C-1b — the control whose *absence* let F-4
 * ship: nothing compared `docker/Caddyfile`'s proxied prefixes to
 * `packages/contracts/openapi/openapi.json`'s actual routes. WP 1.5 and WP
 * 1.3b brought the contract from three top-level prefixes to eleven; the
 * Caddyfile still only proxied the original three, so the other eight fell
 * through to the SPA catch-all and answered `200 text/html` for every real
 * API call — silently wrong, not an error, and nothing failed a build over it
 * for a full phase.
 *
 * C-1a's fix is a namespace, not a bigger prefix list: the API is proxied
 * whole, at `handle_path /api/*`, which is also `servers[0].url` in the
 * OpenAPI document. This script is what keeps that equivalence from rotting
 * again — parses the contract's `servers` entry and its top-level path
 * prefixes, parses `docker/Caddyfile` for every `reverse_proxy` directive
 * that targets the `api` service, and fails loudly if:
 *
 *   1. no such directive exists, or more than one does (a stray extra prefix
 *      reaching the api — the exact shape a careless future edit would take);
 *   2. the one that exists is not a `handle_path` (which strips the matched
 *      prefix before proxying — a plain `handle` does not, and an unstripped
 *      proxy against an API that mounts nothing under the matched prefix is
 *      the Phase 0 M-3 bug this file's own header describes);
 *   3. its matched pattern does not exactly equal `${servers[0].url}/*`; or
 *   4. any top-level prefix in the contract's `paths` would not be reachable
 *      through that pattern.
 *
 * No external dependencies: this is intentionally a small hand-rolled,
 * quote-aware brace parser rather than a real Caddyfile grammar — the file it
 * reads is small, human-maintained, and this script's own fixture-based
 * self-test (`--self-test`) pins the exact shapes it needs to parse.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const OPENAPI_PATH = join(REPO_ROOT, 'packages', 'contracts', 'openapi', 'openapi.json');
const CADDYFILE_PATH = join(REPO_ROOT, 'docker', 'Caddyfile');

/** The upstream Caddy proxies the API to — see `docker/Caddyfile`'s `(app_routes)` snippet. */
const API_UPSTREAM = /^api:\d+$/;

interface Block {
  /** Everything before the opening `{`, trimmed (e.g. `handle_path /api/*`). */
  readonly header: string;
  /** Everything between the matching `{` `}` pair, exclusive. */
  readonly body: string;
}

/**
 * Strips `#`-to-end-of-line comments, respecting double-quoted strings (the
 * `Content-Security-Policy` header value is one long quoted string and must
 * never have anything inside it treated as a comment start — it contains no
 * `#`, but being careful here costs nothing).
 */
export function stripComments(text: string): string {
  let out = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === '#' && !inQuotes) {
      const newline = text.indexOf('\n', i);
      if (newline === -1) break;
      i = newline - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Splits `text` into its depth-0 `{ ... }` blocks, quote-aware so a `{` or
 * `}` inside a quoted string (this Caddyfile's Plaid CSP placeholders,
 * `{plaid_script_src}` etc., sit *inside* the `Content-Security-Policy "..."`
 * value) never perturbs brace depth. Text outside any block (bare directives,
 * snippet names with no body yet) is not returned — every caller here only
 * wants named blocks.
 */
export function splitTopLevelBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let depth = 0;
  let inQuotes = false;
  let headerStart = 0;
  let bodyStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth < 0) throw new Error('check-proxy-routes: unbalanced braces in Caddyfile');
      if (depth === 0 && bodyStart !== -1) {
        blocks.push({
          header: text.slice(headerStart, bodyStart - 1).trim(),
          body: text.slice(bodyStart, i),
        });
        headerStart = i + 1;
        bodyStart = -1;
      }
    }
  }
  if (depth !== 0) throw new Error('check-proxy-routes: unbalanced braces in Caddyfile');
  return blocks;
}

export interface ProxyBlock {
  /** `handle_path` or `handle` (the directive keyword). */
  readonly directive: string;
  /** The matcher token, e.g. `/api/*`, or `undefined` for a bare `handle {}` catch-all. */
  readonly pattern: string | undefined;
}

/** Every `handle`/`handle_path` block, anywhere in `(app_routes)`, whose body proxies to the api service. */
export function findApiProxyBlocks(caddyfileText: string): ProxyBlock[] {
  const clean = stripComments(caddyfileText);
  const topLevel = splitTopLevelBlocks(clean);
  const appRoutes = topLevel.find((b) => b.header === '(app_routes)');
  if (appRoutes === undefined) {
    throw new Error("check-proxy-routes: no '(app_routes)' snippet found in docker/Caddyfile");
  }

  const children = splitTopLevelBlocks(appRoutes.body);
  const proxying: ProxyBlock[] = [];
  for (const child of children) {
    const reverseProxyMatch = /reverse_proxy\s+(\S+)/.exec(child.body);
    if (reverseProxyMatch === undefined || reverseProxyMatch === null) continue;
    if (!API_UPSTREAM.test(reverseProxyMatch[1] ?? '')) continue;
    const [directive, ...rest] = child.header.split(/\s+/);
    proxying.push({ directive: directive ?? '', pattern: rest[0] });
  }

  // Defense in depth: every `reverse_proxy api:*` in the *whole file* must be
  // one we just accounted for inside `(app_routes)`. If this count is higher,
  // something proxies to the api from outside the one snippet every listener
  // imports — a second, unaudited path in.
  const wholeFileMatches = clean.match(/reverse_proxy\s+api:\d+/g) ?? [];
  const accountedFor = proxying.length;
  if (wholeFileMatches.length !== accountedFor) {
    throw new Error(
      `check-proxy-routes: found ${String(wholeFileMatches.length)} reverse_proxy directive(s) ` +
        `targeting the api service in docker/Caddyfile, but only ${String(accountedFor)} are inside ` +
        "a recognised handle/handle_path block in '(app_routes)' — a stray proxy exists outside the " +
        'audited snippet.',
    );
  }

  return proxying;
}

interface OpenApiDoc {
  readonly servers?: { url: string }[];
  readonly paths: Record<string, unknown>;
}

/** The first path segment of every operation, e.g. `/auth/session` -> `/auth`. */
export function topLevelPrefixes(doc: OpenApiDoc): string[] {
  const prefixes = new Set<string>();
  for (const path of Object.keys(doc.paths)) {
    const segment = path.split('/')[1];
    if (segment !== undefined && segment !== '') prefixes.add(`/${segment}`);
  }
  return [...prefixes].sort();
}

/** `pattern` is Caddy `handle_path`/`handle` shorthand: a literal path, or `<prefix>/*`. */
export function matchesCaddyPattern(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return false;
}

function main(): number {
  const openapi = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiDoc;
  const caddyfileText = readFileSync(CADDYFILE_PATH, 'utf8');

  const errors: string[] = [];

  const serverUrl = openapi.servers?.[0]?.url;
  if (serverUrl === undefined || !serverUrl.startsWith('/')) {
    errors.push(
      `packages/contracts/openapi/openapi.json: expected servers[0].url to be an absolute path ` +
        `(e.g. "/api"), got ${JSON.stringify(openapi.servers)}.`,
    );
    for (const e of errors) console.error(`check-proxy-routes: FAIL — ${e}`);
    return 1;
  }
  const prefix = serverUrl === '/' ? '' : serverUrl.replace(/\/$/, '');
  const expectedPattern = `${prefix}/*`;

  const proxyBlocks = findApiProxyBlocks(caddyfileText);

  if (proxyBlocks.length === 0) {
    errors.push(
      'docker/Caddyfile: no handle/handle_path block in (app_routes) proxies to the api service ' +
        '(expected one routing exactly ' +
        expectedPattern +
        ').',
    );
  } else if (proxyBlocks.length > 1) {
    errors.push(
      `docker/Caddyfile: ${String(proxyBlocks.length)} blocks proxy to the api service, expected ` +
        `exactly 1: ${proxyBlocks.map((b) => `${b.directive} ${b.pattern ?? '(bare)'}`).join(', ')}. ` +
        'Every path the api answers must be reachable through one audited prefix, not several.',
    );
  } else {
    const [block] = proxyBlocks;
    if (block?.directive !== 'handle_path') {
      errors.push(
        `docker/Caddyfile: the block proxying to the api uses '${block?.directive ?? '(unknown)'}', ` +
          "not 'handle_path' — 'handle' does not strip the matched prefix before proxying, which 404s " +
          'every request against an api that mounts nothing under that prefix (Phase 0 M-3).',
      );
    }
    if (block?.pattern !== expectedPattern) {
      errors.push(
        `docker/Caddyfile: the api is proxied at '${block?.pattern ?? '(bare handle, no pattern)'}', ` +
          `but packages/contracts/openapi/openapi.json's servers[0].url is '${serverUrl}' — expected ` +
          `the Caddyfile to route exactly '${expectedPattern}'.`,
      );
    }
  }

  const prefixes = topLevelPrefixes(openapi);
  if (prefixes.length === 0) {
    errors.push('packages/contracts/openapi/openapi.json: no paths found — is the contract empty?');
  }
  for (const contractPrefix of prefixes) {
    const combined = `${prefix}${contractPrefix}`;
    if (!matchesCaddyPattern(expectedPattern, combined)) {
      errors.push(
        `packages/contracts/openapi/openapi.json declares '${contractPrefix}', which the proxy ` +
          `would serve at '${combined}' — not reachable through docker/Caddyfile's routed prefix ` +
          `'${expectedPattern}'.`,
      );
    }
  }

  if (errors.length > 0) {
    console.error('check-proxy-routes: FAIL\n');
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`\n${String(errors.length)} problem(s).`);
    return 1;
  }

  console.log(
    `check-proxy-routes: PASS — docker/Caddyfile routes exactly '${expectedPattern}' to the api, ` +
      `matching packages/contracts/openapi/openapi.json's servers[0].url ('${serverUrl}') and covering ` +
      `all ${String(prefixes.length)} contract prefix(es): ${prefixes.join(', ')}.`,
  );
  return 0;
}

// Only run when executed directly (not when imported by the self-test).
if (process.argv[1] === import.meta.filename) {
  process.exit(main());
}
