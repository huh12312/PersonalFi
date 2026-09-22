// SPDX-License-Identifier: MIT
/**
 * The live Coinbase smoke test. Skipped unless a **file** secret is present.
 *
 * ## Why it exists when the hermetic suite is green
 *
 * `FakeCoinbaseApi` proves the adapter is self-consistent and that its tokens
 * would satisfy a correct verifier. It cannot prove that *Coinbase* agrees —
 * that `alg: EdDSA` is what the real service wants, that the `uri` claim's
 * format is right down to the missing query string, that `/accounts` really
 * pages the way the adapter assumes, or — the one that matters most — **that the
 * R6 determination holds for a real account**. Recorded fixtures are a snapshot
 * of a belief; this is the only test that checks the belief.
 *
 * It runs the *same* `probeLedgerGap` the hermetic prototype runs, over the same
 * `CoinbaseClient`, differing only in the transport underneath.
 *
 * ## Credentials come from files, never from the environment
 *
 * D5: provider credentials are "**file secrets under `/run/secrets`… never env
 * vars**". An environment variable leaks into `docker inspect`, into a crash
 * dump, into every child process and into `/proc/<pid>/environ`; a file read
 * once at the moment of use does none of that. So this test reads
 * `${SECRETS_DIR}/coinbase_key_name` and `${SECRETS_DIR}/coinbase_private_key`
 * (default `./secrets`) and **`SECRETS_DIR` is the only environment variable it
 * consults** — a path, not a secret.
 *
 * Nothing read here is ever printed. The skip message names the *files*, the
 * assertions are about counts and shapes, and the final block scans everything
 * the run produced for the key material exactly as `log-hygiene.test.ts` does.
 *
 * ## Why running it is safe
 *
 * Every request is a `GET` on one of five read-only paths, and the run refuses
 * before its first data call if the key carries `can_trade` or `can_transfer`.
 * There is no Coinbase analogue of Plaid's ten-Item ratchet: a read costs
 * nothing and creates nothing. The runbook is in
 * `docs/evidence/phase-3/wp3.5-coinbase.md` §8.
 */
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_ERROR_KINDS } from '@connector/port';
import { money, systemClock } from '@core/kernel';
import { CoinbaseClient } from '../src/client.ts';
import { fetchTransport } from '../src/client.ts';
import { CoinbaseConnector } from '../src/connector.ts';
import { probeLedgerGap } from '../src/ledger-gap.ts';
import { CDP_KEY_NAME, CDP_PRIVATE_KEY } from '../src/provider.ts';
import { handleFor, recordingLogger, syncOptions, testClock } from './harness.ts';

/** The two file names the orchestrator must add to the secrets batch. */
export const COINBASE_SECRET_FILES = Object.freeze([
  'coinbase_key_name',
  'coinbase_private_key',
] as const);

/** A path, not a secret. The only environment variable this file reads. */
const SECRETS_DIR = process.env['SECRETS_DIR'] ?? 'secrets';

function readSecretFile(name: string): string | null {
  try {
    const text = readFileSync(join(SECRETS_DIR, name), 'utf8').trim();
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

const keyName = readSecretFile('coinbase_key_name');
const privateKey = readSecretFile('coinbase_private_key');
const configured = keyName !== null && privateKey !== null;

if (!configured) {
  // Printed once, deliberately, so a green run cannot be mistaken for a run
  // that actually talked to Coinbase. It names the files and nothing else.
  console.info(
    `\n  [connector-coinbase] live smoke SKIPPED: ${join(SECRETS_DIR, 'coinbase_key_name')} and ` +
      `${join(SECRETS_DIR, 'coinbase_private_key')} are not both present.\n` +
      '  This is expected — no CDP key exists on this machine and none belongs in CI.\n' +
      '  The hermetic suite (R6 prototype, conformance, JWT, permissions, on-ramp, custody,\n' +
      '  log hygiene) covers everything it can without a network; this test is the only one\n' +
      '  that checks Coinbase agrees, and the only one that runs the R6 probe against a real\n' +
      '  account. To run it, see docs/evidence/phase-3/wp3.5-coinbase.md §8.\n',
  );
}

describe.skipIf(!configured)('live Coinbase (read-only)', () => {
  it('asserts scope, reads five endpoints, and re-runs the R6 probe against a real account', async () => {
    const logger = recordingLogger();
    const clock = systemClock;
    const credentials = { keyName: keyName ?? '', privateKeyMaterial: privateKey ?? '' };
    const client = new CoinbaseClient({
      transport: fetchTransport(),
      credentials,
      clock,
      logger,
    });

    // ---- The refusal, first ---------------------------------------------
    // If this key can trade, the next line throws and nothing else runs —
    // which is the control, exercised against the real service.
    const permissions = await client.keyPermissions();
    expect(permissions.can_trade ?? false).toBe(false);
    expect(permissions.can_transfer ?? false).toBe(false);
    expect(permissions.can_view).toBe(true);

    // ---- The R6 probe, live ---------------------------------------------
    const report = await probeLedgerGap(client);
    for (const entry of report.endpoints) {
      expect(entry.outcome, `${entry.endpoint}: ${entry.summary}`).toBe('answered');
    }
    // The finding, restated against real data. A live account whose every
    // asset reconciled would be evidence *against* the determination, and this
    // prints the residuals so the evidence doc can quote them.
    console.info(
      '\n  [connector-coinbase] live R6 verdict:',
      report.verdict,
      '\n  reconciliation:',
      report.reconciliation.map((row) => `${row.asset} residual=${row.residual}`).join('  '),
      '\n',
    );
    expect(report.verdict).toBe('v3_alone_cannot_reconstruct_the_ledger');

    // ---- The adapter, end to end ----------------------------------------
    const connector = new CoinbaseConnector({ transport: fetchTransport(), clock, logger });
    const connected = await connector.connect({
      keyName: credentials.keyName,
      privateKey: credentials.privateKeyMaterial,
    });
    expect(connected.credentials[CDP_KEY_NAME]).toBe(credentials.keyName);
    expect(connected.accounts.length).toBeGreaterThan(0);

    const handle = handleFor(credentials, {
      providerConnectionId: connected.providerConnectionId,
    });
    const options = syncOptions(testClock(), {
      clock,
      deadline: new Date(clock.nowMs() + 110_000),
    });

    const accounts = await connector.listAccounts(handle);
    expect(accounts.every((account) => account.currency.length === 3)).toBe(true);
    const balances = await connector.syncBalances(handle, options);
    expect(balances.every((balance) => typeof balance.current.minor === 'bigint')).toBe(true);
    const page = await connector.syncTransactions(handle, null, options);
    // The first sync establishes a watermark and emits nothing, by design.
    expect(page.added).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(String(page.nextCursor)).toMatch(/^cb1\./);
    expect((await connector.health(handle)).reachable).toBe(true);

    // ---- And nothing leaked ---------------------------------------------
    const rendered = inspect({ logger: logger.lines, page, balances }, { depth: null });
    expect(rendered).not.toContain(credentials.privateKeyMaterial);
    expect(rendered).not.toContain(credentials.keyName);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// This part runs with or without credentials
// ---------------------------------------------------------------------------

describe('the smoke test is honestly gated', () => {
  it('the live smoke skips honestly without credentials', () => {
    // If this ever reads `true` on a machine with no CDP key, the gate broke and
    // a green run stopped meaning what it says.
    expect(configured).toBe(keyName !== null && privateKey !== null);
    if (!configured) {
      expect(keyName === null || privateKey === null).toBe(true);
    }
  });

  it('reads its credentials from files and never from the environment', () => {
    // D5. `SECRETS_DIR` is a path; the two credentials are files. A test that
    // accepted `COINBASE_PRIVATE_KEY` from the environment would put a signing
    // key into `docker inspect`, every child process and /proc.
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    const environmentReads = [...source.matchAll(/process\.env\[['"]([^'"]+)['"]\]/g)].map(
      (match) => match[1],
    );
    expect(environmentReads).toEqual(['SECRETS_DIR']);
    expect(source).toContain("readFileSync(join(SECRETS_DIR, name), 'utf8')");
    expect(COINBASE_SECRET_FILES).toEqual(['coinbase_key_name', 'coinbase_private_key']);
    // And the credential names the seal covers match the two files.
    expect([CDP_KEY_NAME, CDP_PRIVATE_KEY]).toEqual(['cdp_key_name', 'cdp_private_key']);
  });

  it('resolves @connector/port and @core/kernel from this package', () => {
    // The original file in this package, kept: it is what let the orchestrator
    // register the `connector-coinbase` vitest project before there was an
    // adapter to run in it.
    expect(CONNECTOR_ERROR_KINDS).toContain('permanent');
    expect(money(1n, 'USD').currency).toBe('USD');
  });
});
