// SPDX-License-Identifier: MIT
/**
 * The registry's per-holder (dynamic) providers (WP 10.1).
 *
 * A provider whose credentials a holder stored in the product exists only while
 * those credentials do, so the registry answers "is it there?" per holder, caches
 * the answer briefly, and forgets it when told the credentials changed.
 */
import { mutableClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { ConnectionsError } from '../src/errors.ts';
import { ConnectorRegistry, type DynamicConnector } from '../src/registry.ts';
import {
  CSV_MANIFEST,
  CsvImportConnector,
  MANUAL_MANIFEST,
  ManualConnector,
  ManualStore,
} from './harness.ts';

/** The manual adapter wearing another provider id, so no extra dependency is needed. */
function dynamicEntry(
  resolve: DynamicConnector['resolve'],
  provider = 'manual-alt',
): DynamicConnector {
  return {
    provider,
    manifest: { ...MANUAL_MANIFEST, provider, displayName: 'Per holder' },
    resolve,
  };
}

class AltConnector extends ManualConnector {
  override readonly provider: string;
  constructor(provider: string) {
    super({ store: new ManualStore() });
    this.provider = provider;
  }
}

const CLOCK_START = '2026-10-12T12:00:00.000Z';

describe('dynamic providers', () => {
  it('resolves per holder, and the sync lookups never see a dynamic provider', async () => {
    const registry = new ConnectorRegistry([
      { connector: new CsvImportConnector(), manifest: CSV_MANIFEST },
    ]);
    const asked: string[] = [];
    registry.registerDynamic(
      dynamicEntry(async (userId) => {
        asked.push(userId);
        return userId === 'holder-a' ? new AltConnector('manual-alt') : null;
      }),
    );

    expect(await registry.hasFor('manual-alt', 'holder-a')).toBe(true);
    expect(await registry.hasFor('manual-alt', 'holder-b')).toBe(false);
    expect((await registry.connectorFor('manual-alt', 'holder-a')).provider).toBe('manual-alt');
    await expect(registry.connectorFor('manual-alt', 'holder-b')).rejects.toBeInstanceOf(
      ConnectionsError,
    );

    // A holder's answer is never another holder's: the manifest list is per holder too.
    expect((await registry.manifestsFor('holder-a')).map((m) => m.provider)).toContain(
      'manual-alt',
    );
    expect((await registry.manifestsFor('holder-b')).map((m) => m.provider)).not.toContain(
      'manual-alt',
    );

    // The synchronous surface is the static registrations alone.
    expect(registry.has('manual-alt')).toBe(false);
    expect(registry.manifests().map((m) => m.provider)).not.toContain('manual-alt');
    expect(asked.length).toBeGreaterThan(0);
  });

  it('caches an answer for the TTL, and invalidate forgets it', async () => {
    const clock = mutableClock(CLOCK_START);
    const registry = new ConnectorRegistry([], { clock, dynamicTtlMs: 30_000 });
    let calls = 0;
    let available = false;
    registry.registerDynamic(
      dynamicEntry(async () => {
        calls += 1;
        return available ? new AltConnector('manual-alt') : null;
      }),
    );

    expect(await registry.hasFor('manual-alt', 'h')).toBe(false);
    expect(await registry.hasFor('manual-alt', 'h')).toBe(false);
    expect(calls).toBe(1);

    // The credentials arrive. Within the TTL the cached "no" stands...
    available = true;
    expect(await registry.hasFor('manual-alt', 'h')).toBe(false);
    // ...until the event says they changed.
    registry.invalidate('manual-alt');
    expect(await registry.hasFor('manual-alt', 'h')).toBe(true);
    expect(calls).toBe(2);

    // And with no event at all, the TTL still bounds how stale a process can be.
    available = false;
    expect(await registry.hasFor('manual-alt', 'h')).toBe(true);
    clock.advanceMs(30_001);
    expect(await registry.hasFor('manual-alt', 'h')).toBe(false);
  });

  it('a resolve that began before an invalidation cannot repopulate the cache with its stale answer', async () => {
    const registry = new ConnectorRegistry([], { clock: mutableClock(CLOCK_START) });
    let release: (value: ManualConnector | null) => void = () => undefined;
    let calls = 0;
    registry.registerDynamic(
      dynamicEntry(() => {
        calls += 1;
        if (calls === 1) {
          return new Promise<ManualConnector | null>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve(new AltConnector('manual-alt'));
      }),
    );

    const inflight = registry.hasFor('manual-alt', 'h');
    registry.invalidate('manual-alt'); // the credentials changed while the read was in flight
    release(null); // the read, taken before the change, answers "none"
    expect(await inflight).toBe(false);
    // The stale "none" was not cached: the next ask re-reads and sees the new credentials.
    expect(await registry.hasFor('manual-alt', 'h')).toBe(true);
    expect(calls).toBe(2);
  });

  it('a static registration wins over a dynamic one for the same provider', async () => {
    const staticConnector = new ManualConnector({ store: new ManualStore() });
    const registry = new ConnectorRegistry([
      { connector: staticConnector, manifest: MANUAL_MANIFEST },
    ]);
    let asked = false;
    registry.registerDynamic(
      dynamicEntry(async () => {
        asked = true;
        return new AltConnector(MANUAL_MANIFEST.provider);
      }, MANUAL_MANIFEST.provider),
    );
    expect(await registry.hasFor(MANUAL_MANIFEST.provider, 'h')).toBe(true);
    // The operator's registration is the one handed back, not the holder's.
    expect(await registry.connectorFor(MANUAL_MANIFEST.provider, 'h')).toBe(staticConnector);
    expect(
      (await registry.manifestsFor('h')).filter((m) => m.provider === MANUAL_MANIFEST.provider),
    ).toHaveLength(1);
    expect(asked).toBe(false);
  });

  it('refuses a manifest that names a different provider than its entry', () => {
    const registry = new ConnectorRegistry();
    expect(() =>
      registry.registerDynamic({
        provider: 'a',
        manifest: { ...MANUAL_MANIFEST, provider: 'b' },
        resolve: async () => null,
      }),
    ).toThrow(ConnectionsError);
  });
});
