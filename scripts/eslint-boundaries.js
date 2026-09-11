// SPDX-License-Identifier: MIT
/**
 * `personalfi/layer-imports` — the dependency rule, mechanised.
 *
 * The architecture memo states the rule as a diagram; this file is the only
 * version of it that can actually hold. It is a local ESLint rule rather than
 * `eslint-plugin-boundaries` or `dependency-cruiser` for two reasons: the policy
 * below is an *allow-list* (everything not named is denied), which glob-based
 * plugins express badly, and it is one fewer third-party package in a repo whose
 * threat model includes supply-chain attacks (decision D14).
 *
 * The rule it enforces:
 *
 *     kernel   imports nothing but its own two decimal/uuid primitives
 *       ^
 *     config, contracts, db
 *       ^
 *     contexts  — may use kernel/config/db/contracts, NEVER another context
 *       ^
 *     apps      — the composition root; the only layer allowed to wire things up
 */
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages every layer may use: pure, side-effect-free, no I/O. */
const UNIVERSAL = ['zod'];

/**
 * Test tooling, allowed in `*.test.ts` at every layer.
 *
 * The kernel's rule is that *shipped* kernel code imports nothing; a property
 * test for `Money.allocate` is not shipped kernel code. Keeping the exemption
 * this narrow means the rule still catches a production import that sneaks into
 * a file named like a test.
 */
const TEST_ONLY = ['vitest', 'fast-check'];

/**
 * Layer policy, most specific path prefix first.
 *
 * `allow` lists bare package names (subpaths are matched by prefix, so `@core/db`
 * covers `@core/db/columns`). `node:` builtins are controlled by `allowNodeBuiltins`.
 */
const LAYERS = [
  {
    name: 'kernel',
    prefix: 'packages/kernel/',
    allow: ['decimal.js', 'uuid'],
    allowNodeBuiltins: false,
    why:
      'The kernel is the one module every context agrees on. It imports nothing — ' +
      'not the database, not Fastify, not a provider SDK — so that a change to ' +
      'infrastructure can never ripple into the type every other package depends on.',
  },
  {
    name: 'config',
    prefix: 'packages/config/',
    allow: ['@core/kernel', ...UNIVERSAL],
    allowNodeBuiltins: true,
    why: 'Configuration is read once, at boot, and depends on nothing but the kernel.',
  },
  {
    name: 'contracts',
    prefix: 'packages/contracts/',
    allow: ['@core/kernel', ...UNIVERSAL],
    allowNodeBuiltins: true,
    why: 'Wire contracts are data. They must not depend on an implementation.',
  },
  {
    name: 'db',
    prefix: 'packages/db/',
    allow: ['@core/kernel', '@core/config', 'drizzle-orm', 'drizzle-kit', 'pg', ...UNIVERSAL],
    allowNodeBuiltins: true,
    why:
      '@core/db must not import a context: contexts own their own tables and import ' +
      'the column vocabulary from here, so the arrow points one way only.',
  },
  {
    name: 'context',
    prefix: 'packages/contexts/',
    allow: [
      '@core/kernel',
      '@core/config',
      '@core/db',
      '@core/contracts',
      'drizzle-orm',
      ...UNIVERSAL,
    ],
    allowNodeBuiltins: true,
    why:
      'A context may depend on the shared kernel and on infrastructure, never on ' +
      'another context. Where a cycle seems necessary the answer is a domain event, ' +
      'not an import.',
  },
  {
    name: 'app',
    prefix: 'apps/',
    allow: null, // composition root: allowed to wire anything together
    allowNodeBuiltins: true,
    why: '',
  },
];

function toPosix(value) {
  return value.split(sep).join('/');
}

function layerFor(relativePath) {
  return LAYERS.find((layer) => relativePath.startsWith(layer.prefix));
}

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The workspace package a file belongs to, e.g. `packages/contexts/ledger`. */
function packageRootOf(relativePath) {
  if (relativePath.startsWith('packages/contexts/')) {
    return relativePath.split('/').slice(0, 3).join('/');
  }
  if (relativePath.startsWith('packages/') || relativePath.startsWith('apps/')) {
    return relativePath.split('/').slice(0, 2).join('/');
  }
  return null;
}

const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce the PersonalFi layer dependency rule.' },
    schema: [],
    messages: {
      denied: "{{layer}} may not import '{{specifier}}'. {{why}}",
      crossContext:
        "'{{specifier}}' is another bounded context. {{contextName}} must talk to it through a " +
        'domain event or its published port, never a direct import (decision D8).',
      escapes:
        "'{{specifier}}' resolves outside {{packageRoot}}. Reach across packages by their package " +
        'name so the dependency is declared and lintable, never by a relative path.',
      builtin: "{{layer}} may not import the Node builtin '{{specifier}}'. {{why}}",
    },
  },

  create(context) {
    const absolute = context.filename ?? context.getFilename();
    const relativePath = toPosix(relative(REPO_ROOT, absolute));
    if (relativePath.startsWith('..')) return {};

    const layer = layerFor(relativePath);
    if (layer === undefined || layer.allow === null) return {};

    const isTest = relativePath.endsWith('.test.ts');
    const allowed = isTest ? [...layer.allow, ...TEST_ONLY] : layer.allow;
    const allowNodeBuiltins = layer.allowNodeBuiltins || isTest;

    const packageRoot = packageRootOf(relativePath);
    const contextName =
      layer.name === 'context' ? `@ctx/${relativePath.split('/')[2]}` : `@core/${layer.name}`;

    function check(node, specifierNode) {
      if (specifierNode?.type !== 'Literal' || typeof specifierNode.value !== 'string') return;
      const specifier = specifierNode.value;

      if (specifier.startsWith('.')) {
        if (packageRoot === null) return;
        const resolved = toPosix(relative(REPO_ROOT, resolve(dirname(absolute), specifier)));
        if (!resolved.startsWith(`${packageRoot}/`)) {
          context.report({
            node: specifierNode,
            messageId: 'escapes',
            data: { specifier, packageRoot },
          });
        }
        return;
      }

      if (specifier.startsWith('node:')) {
        if (!allowNodeBuiltins) {
          context.report({
            node: specifierNode,
            messageId: 'builtin',
            data: { layer: contextName, specifier, why: layer.why },
          });
        }
        return;
      }

      const pkg = packageOf(specifier);

      // Its own package name: harmless, and how a test file refers to its subject.
      if (packageRoot !== null && pkg === contextName) return;

      if (pkg.startsWith('@ctx/') && pkg !== contextName) {
        context.report({
          node: specifierNode,
          messageId: 'crossContext',
          data: { specifier, contextName },
        });
        return;
      }

      if (!allowed.includes(pkg)) {
        context.report({
          node: specifierNode,
          messageId: 'denied',
          data: { layer: contextName, specifier, why: layer.why },
        });
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node, node.source);
      },
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
    };
  },
};

export const boundariesPlugin = {
  meta: { name: 'personalfi' },
  rules: { 'layer-imports': rule },
};

export { LAYERS };
