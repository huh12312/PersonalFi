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
 *     kernel    imports nothing but its own two decimal/uuid primitives
 *       ^
 *     config, contracts, db
 *       ^
 *     platform  — the outbox, the queue, the scheduler, flags. NEVER a context:
 *                 the whole reason the outbox exists is that platform does not
 *                 know who is listening.
 *       ^
 *     contexts  — may use kernel/config/db/contracts/platform, NEVER another context
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
 * Cryptographic primitive libraries. Importable **only** inside
 * `packages/secretbox/`, and within that package only from `src/primitives.ts`
 * (the second half of that rule lives in `eslint.config.js`, because it is a
 * file-path restriction rather than a layer one).
 *
 * This is the mechanised form of 03 §2: envelope encryption is worth nothing if a
 * second call site elsewhere in the tree reaches for `createCipheriv`, picks a
 * 12-byte nonce from `Math.random`, and forgets the AAD. Protocol libraries that
 * happen to contain crypto — `@simplewebauthn/server`, `otpauth` — are not on this
 * list: they are allow-listed to `@ctx/identity` by the layer policy below,
 * because a passkey implementation is an authentication protocol, not a primitive
 * anyone could misuse into a nonce reuse.
 */
const CRYPTO_PRIMITIVES = ['@noble/ciphers', '@noble/hashes', 'hash-wasm'];

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
    name: 'testkit',
    prefix: 'packages/testkit/',
    allow: ['@core/kernel', '@core/db', '@core/platform', 'drizzle-orm', 'pg', ...UNIVERSAL],
    allowNodeBuiltins: true,
    why:
      'Test infrastructure shared by every *-db suite: a scratch database per suite, ' +
      'process-spawning helpers, golden-fixture I/O. Depends on nothing above db/platform ' +
      'so no context ever needs @core/testkit as a production dependency.',
  },
  {
    name: 'seed',
    prefix: 'packages/seed/',
    allow: ['@core/kernel', ...UNIVERSAL],
    allowNodeBuiltins: true,
    why:
      'The demo-seed generator is a pure function of a seed integer. It produces typed ' +
      'in-memory data (Phase 1 maps it to real schema) and must not depend on @core/db: ' +
      'it owns no table (see OWNERSHIP.md).',
  },
  {
    name: 'platform',
    prefix: 'packages/platform/',
    allow: [
      '@core/kernel',
      '@core/db',
      '@core/testkit',
      'drizzle-orm',
      'pg',
      'cron-parser',
      ...UNIVERSAL,
    ],
    allowNodeBuiltins: true,
    why:
      '@core/platform is infrastructure every context depends on, so it must depend ' +
      'on none of them. A platform that imported @ctx/ledger to check one thing would ' +
      'put the outbox downstream of the context the outbox exists to decouple, and ' +
      'the cycle would be permanent.',
  },
  {
    name: 'secretbox',
    prefix: 'packages/secretbox/',
    // `drizzle-orm` is here for `schema/encryption-keys.ts` only. The runtime
    // path deliberately uses raw parameterised SQL (see `src/store.ts`); the
    // Drizzle definition exists so `lint:schema-ownership` can see the claim on
    // `encryption_keys` and so a later migration tool can see the shape.
    allow: [
      '@core/kernel',
      '@core/config',
      '@core/db',
      'drizzle-orm',
      ...CRYPTO_PRIMITIVES,
      ...UNIVERSAL,
    ],
    allowNodeBuiltins: true,
    why:
      'The cryptography chokepoint. It is the only package allowed to import a ' +
      'cipher, a KDF or a hash, and in exchange it imports nothing above ' +
      'infrastructure: it must never know what a Plaid item or a session is.',
  },
  {
    name: 'identity',
    prefix: 'packages/contexts/identity/',
    // The authentication protocol libraries live here and nowhere else. They are
    // listed against this one context rather than all of them because a context
    // that needs to verify a WebAuthn assertion is, by definition, this context.
    allow: [
      '@core/kernel',
      '@core/config',
      '@core/db',
      '@core/contracts',
      '@core/platform',
      '@core/secretbox',
      '@simplewebauthn/server',
      'otpauth',
      'drizzle-orm',
      ...UNIVERSAL,
    ],
    allowNodeBuiltins: true,
    why:
      'Identity owns authentication. It reaches primitives only through ' +
      '@core/secretbox — a direct cipher import here would defeat the chokepoint.',
  },
  {
    name: 'ledger',
    prefix: 'packages/contexts/ledger/',
    // The production set is the generic context set. The two additions are
    // dev-only and are declared as `devDependencies` in this package's
    // package.json, which is where that distinction is actually recorded — the
    // layer rule cannot express "test files only" for a `test/` directory, and
    // the alternative was an `eslint-disable` in the test harness, which buys
    // the same looseness while hiding it from anyone reading this file:
    //
    //   * `@core/testkit` — the scratch database every `*-db` suite runs on;
    //   * `@core/seed` — the demo dataset `loadSeedDataset` is graded against.
    //     Note that `src/seed-loader.ts` does **not** import it: the loader
    //     declares the dataset shape structurally (`SeedDatasetLike`) precisely
    //     so the shipped context does not depend on a fixture generator. Only
    //     `test/harness.ts` imports it, and if that ever changes, this comment
    //     is the thing a reviewer should object to.
    allow: [
      '@core/kernel',
      '@core/config',
      '@core/db',
      '@core/contracts',
      '@core/platform',
      '@core/secretbox',
      '@core/testkit',
      '@core/seed',
      'drizzle-orm',
      'pg',
      ...UNIVERSAL,
    ],
    allowNodeBuiltins: true,
    why:
      'Ledger is the system of record: it depends on the kernel and on infrastructure, ' +
      'and on no other context. Everything it needs from one arrives as a domain event, ' +
      'and everything another context needs from it leaves as one.',
  },
  {
    // WP 1.2. Two additions to the generic context set, both deliberate:
    //
    //   * `@connector/*` — the `Connector` port and the adapters that implement
    //     it. These are **not** contexts: they own no table, hold no database
    //     handle, and sit below `@ctx/connections` exactly as `@core/db` sits
    //     below `@ctx/ledger`. The port has to live outside this context because
    //     the `crossContext` check below denies `packages/connectors/*` ->
    //     `@ctx/connections`, so a port declared inside the context could not be
    //     imported by the adapters that implement it (packages/connectors/port/OWNERSHIP.md).
    //   * `@core/testkit`, `@core/seed` — dev-only, declared as `devDependencies`
    //     in this package's package.json, same arrangement and same caveat as
    //     the `ledger` entry above. No file under `src/` imports either one.
    //
    // Note what is *absent*: `@ctx/ledger`. Connections depends on the Ledger
    // (its OWNERSHIP.md says so) but it may not import it — the boundary rule is
    // unconditional, and its own error message names the alternative: "through a
    // domain event or its published port". So `LedgerWriter` in
    // `src/ledger-writer.ts` is an injected port and `apps/api` wires the real
    // ledger into it (WP 1.5). If that ever becomes a direct import, this
    // comment is the thing a reviewer should object to.
    name: 'connections',
    prefix: 'packages/contexts/connections/',
    allow: [
      '@core/kernel',
      '@core/config',
      '@core/db',
      '@core/contracts',
      '@core/platform',
      '@core/secretbox',
      '@core/testkit',
      '@core/seed',
      '@connector/port',
      '@connector/manual',
      '@connector/csv',
      'drizzle-orm',
      ...UNIVERSAL,
    ],
    allowNodeBuiltins: true,
    why:
      'Connections owns the provider seam. It depends on the port and its adapters, ' +
      'on infrastructure, and on no other context: the Ledger arrives as an injected ' +
      'LedgerWriter from the composition root, which is what keeps "swap the aggregator" ' +
      'a one-context change.',
  },
  {
    // WP 1.3. The Plaid adapter, and the *only* place `plaid` may be imported.
    //
    // This sits before the generic `connectors` entry because `layerFor` takes
    // the first matching prefix, and it exists as its own layer rather than as
    // one more name on the shared allow-list for a reason worth stating: the
    // layer policy is keyed by path prefix, not by package, so listing `plaid`
    // against `packages/connectors/` would let *every* adapter import it. A
    // SimpleFIN or Akahu adapter reaching for Plaid's client is not a hypothetical
    // tidiness concern — it is how "swap the aggregator" (D16's whole reason for
    // the port) quietly stops being a config change, because the replacement
    // adapter grows a dependency on the thing it was meant to replace.
    //
    // Everything else here is exactly the generic connector set. The rule of the
    // layer is unchanged: an adapter may reach its own provider's client and
    // nothing else — not the database, not the platform, not another context.
    name: 'connector-plaid',
    prefix: 'packages/connectors/plaid/',
    allow: ['@core/kernel', '@core/secretbox', '@connector/port', 'plaid', ...UNIVERSAL],
    allowNodeBuiltins: true,
    why:
      'The Plaid adapter maps Plaid shapes to canonical ones and returns them. `plaid` is ' +
      'allow-listed here and nowhere else, so no other adapter can take a dependency on the ' +
      'provider the port exists to make replaceable.',
  },
  {
    // WP 1.2. One package per provider adapter, plus `port` — the interface they
    // implement and the canonical fact shapes they produce.
    //
    // The allow-list is deliberately tiny. An adapter is "provider shape ->
    // canonical shape", which 08 §2.7 observes "is almost always pure functions";
    // giving it a database handle or the outbox would let a provider-specific
    // quirk reach the system of record without passing through the orchestrator,
    // and the per-page atomic commit is the orchestrator's invariant to hold.
    // `@core/secretbox` is here for `sha256` only — the `fingerprint` every
    // adapter must produce (08 §2.5) — and the cipher restriction in
    // eslint.config.js still applies.
    name: 'connectors',
    prefix: 'packages/connectors/',
    // No provider SDK here. Each one is allow-listed against its own package —
    // see the `connector-plaid` entry above — so that an adapter can reach its
    // own provider's client and no other adapter can reach it at all.
    allow: ['@core/kernel', '@core/secretbox', '@connector/port', ...UNIVERSAL],
    allowNodeBuiltins: true,
    why:
      'A provider adapter maps provider shapes to canonical ones and returns them. It ' +
      'never writes to the database, never persists a credential, and never decides ' +
      'retry policy — the orchestrator in @ctx/connections owns all three.',
  },
  {
    // The production set is the generic context set. The two additions are
    // dev-only and are declared as `devDependencies` in this package's
    // package.json, same arrangement as the `ledger` entry above:
    //
    //   * `@core/testkit` — the scratch database `categorization-db` runs on;
    //   * `@core/seed` — the deterministic demo dataset the golden accuracy
    //     set (`test/golden-harness.ts`) is graded against.
    //
    // Both are imported only from `test/`, which is why `test/harness.ts`
    // could stand in with three `eslint-disable-next-line` directives until
    // this entry landed (docs/evidence/phase-1/wp1.4-categorization.md §5).
    name: 'categorization',
    prefix: 'packages/contexts/categorization/',
    allow: [
      '@core/kernel',
      '@core/config',
      '@core/db',
      '@core/contracts',
      '@core/platform',
      '@core/secretbox',
      '@core/testkit',
      '@core/seed',
      'drizzle-orm',
      ...UNIVERSAL,
    ],
    allowNodeBuiltins: true,
    why:
      'Categorization is a context: it depends on the kernel and on infrastructure, ' +
      'and on no other context. @core/testkit and @core/seed are dev-only, used only ' +
      'from test/.',
  },
  {
    // Phase 2 WP 2.2/2.3 (docs/plan/02-phase-2-dispatch.md §4 shared files).
    // Same shape as `categorization`: the named layer exists so test/ may use
    // @core/testkit and @core/seed. Note what is absent: `@ctx/ledger`. The
    // engine groups on `merchantId` (D25) and receives ledger rows through a
    // port WP 2.3 adapts in apps/api — never through an import.
    name: 'recurring',
    prefix: 'packages/contexts/recurring/',
    allow: [
      '@core/kernel',
      '@core/config',
      '@core/db',
      '@core/contracts',
      '@core/platform',
      '@core/secretbox',
      '@core/testkit',
      '@core/seed',
      'drizzle-orm',
      ...UNIVERSAL,
    ],
    allowNodeBuiltins: true,
    why:
      'Recurring is a context: it depends on the kernel and on infrastructure, ' +
      'and on no other context. @core/testkit and @core/seed are dev-only, used only ' +
      'from test/.',
  },
  {
    name: 'context',
    prefix: 'packages/contexts/',
    allow: [
      '@core/kernel',
      '@core/config',
      '@core/db',
      '@core/contracts',
      '@core/platform',
      '@core/secretbox',
      'drizzle-orm',
      ...UNIVERSAL,
    ],
    allowNodeBuiltins: true,
    why:
      'A context may depend on the shared kernel and on infrastructure, never on ' +
      'another context. Where a cycle seems necessary the answer is a domain event ' +
      'through @core/platform, not an import. Anything it must encrypt goes through ' +
      '@core/secretbox.',
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
  // The two nested package tiers: bounded contexts, and provider adapters. Both
  // are `packages/<tier>/<name>`, so the root is three segments, not two. Miss
  // this and the `escapes` check silently stops working for the whole tier — a
  // relative import from `connectors/csv/src` into `connectors/manual/src`
  // would resolve inside `packages/connectors/` and be waved through.
  if (
    relativePath.startsWith('packages/contexts/') ||
    relativePath.startsWith('packages/connectors/')
  ) {
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

    // A `test/` directory is test tooling as much as a `*.test.ts` file is: a
    // harness, a fixture builder, a shared conformance suite. `eslint.config.js`
    // already grants `**/test/**` the same exemption twice — from the
    // `process.env` ban and from the `new Date()` ban — and the alternative here
    // was an `eslint-disable` at the top of every harness, which buys the same
    // looseness while hiding it from anyone reading this file. The exemption is
    // still narrow: it adds `vitest` and `fast-check`, and nothing else.
    const isTest = relativePath.endsWith('.test.ts') || /(^|\/)test\//.test(relativePath);
    const allowed = isTest ? [...layer.allow, ...TEST_ONLY] : layer.allow;
    const allowNodeBuiltins = layer.allowNodeBuiltins || isTest;

    const packageRoot = packageRootOf(relativePath);
    // A layer may be scoped to a single context (`identity`), so key the package
    // name off the path rather than the layer name: getting this wrong would make
    // a context's imports of *itself* look like a cross-context violation.
    const contextName = relativePath.startsWith('packages/contexts/')
      ? `@ctx/${relativePath.split('/')[2]}`
      : relativePath.startsWith('packages/connectors/')
        ? `@connector/${relativePath.split('/')[2]}`
        : `@core/${layer.name}`;

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

export { LAYERS, CRYPTO_PRIMITIVES };
