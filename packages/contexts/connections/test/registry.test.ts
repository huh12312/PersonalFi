// SPDX-License-Identifier: MIT
/**
 * The registry and the manifests, which together are how the UI renders a
 * provider it has never heard of.
 *
 * 08 §2.7's test of whether the abstraction is right is that adding a provider
 * needs no UI change. That is a claim about *data*: the "Add a connection"
 * screen reads `registry.manifests()`, and the only way WP 1.3's Plaid adapter
 * can appear there without a component edit is if every field the screen needs
 * is on the manifest and validated. So this suite checks the manifests the three
 * shipped adapters actually publish against the wire schema the API will serve,
 * rather than checking that an object literal has some keys.
 */
import { describe, expect, it } from 'vitest';
import { ConnectionsError } from '../src/errors.ts';
import { ConnectorRegistry, type RegisteredConnector } from '../src/registry.ts';
import { connectorManifestSchema } from '../src/schemas.ts';
import {
  CSV_MANIFEST,
  CsvImportConnector,
  MANUAL_MANIFEST,
  ManualConnector,
  ManualStore,
  SEED_MANIFEST,
  SeedConnector,
} from './harness.ts';

/** The three adapters WP 1.2 ships, each with the manifest it publishes. */
function shipped(): RegisteredConnector[] {
  return [
    { connector: new ManualConnector({ store: new ManualStore() }), manifest: MANUAL_MANIFEST },
    { connector: new CsvImportConnector(), manifest: CSV_MANIFEST },
    { connector: new SeedConnector(), manifest: SEED_MANIFEST },
  ];
}

describe('connector manifests', () => {
  it('every shipped adapter publishes a manifest the API can serve', () => {
    for (const { manifest } of shipped()) {
      // `.parse`, not a hand-rolled field check: this is the same schema
      // `GET /connectors` will validate its response against in WP 1.5, so a
      // manifest that would fail there fails here instead.
      expect(() => connectorManifestSchema.parse(manifest)).not.toThrow();
    }
  });

  it('gives the UI an icon key rather than a URL or a piece of markup', () => {
    for (const { manifest } of shipped()) {
      // A server-controlled string the browser would fetch or render is a hole.
      // Asset keys are lower_snake and resolve inside the bundle; an unknown one
      // renders a generic glyph, which is what makes a new adapter renderable on
      // the day it registers.
      expect(manifest.iconKey).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(manifest.iconKey).not.toContain('/');
    }
  });

  it('names a different provider id per adapter', () => {
    const providers = shipped().map(({ manifest }) => manifest.provider);
    // `accounts.provider` and the natural key `(user_id, provider,
    // provider_account_id)` are built from this: two adapters sharing an id
    // would make a seeded account and a hand-entered account collide.
    expect(new Set(providers).size).toBe(providers.length);
  });

  it('describes a link flow the "add a connection" screen can branch on', () => {
    const byProvider = new Map(shipped().map(({ manifest }) => [manifest.provider, manifest]));
    expect(byProvider.get('manual')?.linkKind).toBe('manual_entry');
    expect(byProvider.get('file_import')?.linkKind).toBe('file_upload');
  });
});

describe('ConnectorRegistry', () => {
  it('looks an adapter up by the provider id its rows carry', () => {
    const registry = new ConnectorRegistry(shipped());
    for (const { connector } of shipped()) {
      expect(registry.get(connector.provider).provider).toBe(connector.provider);
      expect(registry.has(connector.provider)).toBe(true);
    }
  });

  it('refuses a manifest that describes a different adapter', () => {
    const connector = new ManualConnector({ store: new ManualStore() });
    // It would render the wrong icon and, worse, be looked up under an id the
    // adapter never writes into `accounts.provider`.
    expect(() => new ConnectorRegistry([{ connector, manifest: CSV_MANIFEST }])).toThrow(
      ConnectionsError,
    );
  });

  it('refuses an unregistered provider as a domain error, not a retryable one', () => {
    const registry = new ConnectorRegistry(shipped());
    let thrown: unknown;
    try {
      registry.get('plaid');
    } catch (error) {
      thrown = error;
    }
    // A connection row naming a provider nobody registered means a module is
    // disabled or a deployment is missing an adapter. Classifying it as a
    // `ConnectorError` would have the orchestrator back off and retry for six
    // hours to reach the same answer.
    expect(thrown).toBeInstanceOf(ConnectionsError);
    expect((thrown as ConnectionsError).code).toBe('connections.unknown_provider');
  });

  it('sorts manifests so the screen does not reorder itself between requests', () => {
    const names = new ConnectorRegistry(shipped())
      .manifests()
      .map((manifest) => manifest.displayName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
