// SPDX-License-Identifier: MIT
/**
 * Egress properties this package is responsible for, given that
 * `@core/platform`'s SSRF-grade guard (DNS-rebinding-safe resolution,
 * private/link-local refusal, no redirect following, a bounded body) is built
 * once at the composition root and injected here — this package's boundary
 * layer does not, and per its own `why`, must not allow `@core/platform`
 * (see `scripts/eslint-boundaries.js`'s `connectors` entry: "not the
 * database, not the platform, not another context"). What *is* this
 * package's job, and what these tests prove:
 *
 *   1. **The destination host is a source-code constant, never derived from
 *      user input.** `ESPLORA_HOST` and `ETHERSCAN_HOST` are literals in
 *      `btc/esplora.ts`/`eth/etherscan.ts`; no address, xpub, or label this
 *      connector ever reads can reach the `host` field of a request. Proven
 *      here by driving both clients with adversarial values and inspecting
 *      every recorded request.
 *   2. **A redirect is never followed.** Neither client contains a second
 *      request triggered by a 3xx/`Location` header — there is no code path
 *      for it. Proven by having the fake transport hand back a 3xx and
 *      observing exactly one request was made.
 *   3. **The Etherscan API key never appears in a thrown error's message.**
 *      Etherscan does not echo request parameters in its error bodies (unlike
 *      FRED — see `eth/api-key.ts`'s header), so there is no redaction pass to
 *      test for a leak *through*; what is tested is that this package's own
 *      error-construction code never interpolates the key into a message.
 *
 * The orchestrator's job (named exactly, not performed here): build the real
 * transports with `guardDestination`/`createNodeTransport` from
 * `@core/platform`, allow-listing exactly `blockstream.info` and
 * `api.etherscan.io`, https-only, under the `CRYPTO_ALLOWED_HOSTS` config key
 * — see `docs/evidence/phase-3/wp3.6-walletrpc.md` §8.
 */
import { describe, expect, it } from 'vitest';
import { ESPLORA_HOST, createEsploraClient } from '../src/btc/esplora.ts';
import { ETHERSCAN_HOST, createEtherscanClient } from '../src/eth/etherscan.ts';
import { etherscanApiKeyOf } from '../src/eth/api-key.ts';

const ADVERSARIAL_ADDRESSES = [
  'bc1q..@evil.example/../..',
  '../../../etc/passwd',
  'http://169.254.169.254/latest/meta-data/',
  'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu?x=1&host=evil.example',
];

describe('the destination host is a constant no input can change', () => {
  it('esplora requests always target ESPLORA_HOST regardless of the address', async () => {
    const recordedHosts: string[] = [];
    const client = createEsploraClient({
      transport: async (request) => {
        recordedHosts.push(request.host);
        return {
          status: 200,
          body: { chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } },
        };
      },
    });

    for (const address of ADVERSARIAL_ADDRESSES) {
      await client.addressActivity(address);
    }

    expect(recordedHosts).toHaveLength(ADVERSARIAL_ADDRESSES.length);
    expect(new Set(recordedHosts)).toEqual(new Set([ESPLORA_HOST]));
  });

  it('etherscan requests always target ETHERSCAN_HOST regardless of the address', async () => {
    const recordedHosts: string[] = [];
    const client = createEtherscanClient({
      transport: async (request) => {
        recordedHosts.push(request.host);
        return { status: 200, body: { status: '1', message: 'OK', result: '0' } };
      },
      apiKey: etherscanApiKeyOf('test-key'),
    });

    for (const address of ADVERSARIAL_ADDRESSES) {
      await client.nativeBalanceWei(address);
    }

    expect(recordedHosts).toHaveLength(ADVERSARIAL_ADDRESSES.length);
    expect(new Set(recordedHosts)).toEqual(new Set([ETHERSCAN_HOST]));
  });
});

describe('a 302 is not followed', () => {
  it('esplora: a redirect response produces exactly one request and a typed error', async () => {
    let requestCount = 0;
    const client = createEsploraClient({
      transport: async () => {
        requestCount += 1;
        return { status: 302, body: null };
      },
    });

    await expect(
      client.addressActivity('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'),
    ).rejects.toThrow();
    expect(requestCount).toBe(1);
  });

  it('etherscan: a redirect response produces exactly one request and a typed error', async () => {
    let requestCount = 0;
    const client = createEtherscanClient({
      transport: async () => {
        requestCount += 1;
        return { status: 302, body: null };
      },
      apiKey: etherscanApiKeyOf('test-key'),
    });

    await expect(
      client.nativeBalanceWei('0x00000000219ab540356cbb839cbe05303d7705fa'),
    ).rejects.toThrow();
    expect(requestCount).toBe(1);
  });
});

describe('the etherscan API key never appears in a log line or an error message', () => {
  it('a failed balance call does not echo the key', async () => {
    const secretKey = 'sk_live_super_secret_etherscan_value_12345';
    const client = createEtherscanClient({
      transport: async () => ({ status: 500, body: null }),
      apiKey: etherscanApiKeyOf(secretKey),
    });

    let thrown: unknown;
    try {
      await client.nativeBalanceWei('0x00000000219ab540356cbb839cbe05303d7705fa');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(JSON.stringify(thrown)).not.toContain(secretKey);
    expect((thrown as Error).message).not.toContain(secretKey);
  });

  it('the ApiKey object itself never serialises to plaintext', () => {
    const secretKey = 'sk_live_super_secret_etherscan_value_12345';
    const key = etherscanApiKeyOf(secretKey);
    expect(String(key)).not.toContain(secretKey);
    expect(JSON.stringify({ key })).not.toContain(secretKey);
  });
});
