// SPDX-License-Identifier: MIT
/**
 * `@connector/walletrpc/test` — the fakes and the harness, for other
 * packages' suites.
 *
 * `package.json` has declared this subpath export since WP 3.6, but the
 * barrel it points at (`./test/index.ts`) never existed — the Phase 3 gate's
 * O-5 observation (`docs/evidence/phase-3/gate-security-review.md` §4.2).
 * Nothing outside this package imported it before now, so the gap was silent.
 * `apps/api/test/db/wallet-holdings-valuation.test.ts` (C-2) is the first
 * consumer, and it needs exactly what `@connector/coinbase/test`'s own
 * barrel exports for the same reason: a hermetic fake and a harness, without
 * reaching past this package's public surface into `src/` by path.
 */
export {
  EMPTY_SCAN_STATE,
  InMemoryWalletAddressStore,
  createFakeEsploraTransport,
  createFakeEtherscanTransport,
  type FakeEsploraOptions,
  type FakeEtherscanOptions,
} from './fake.ts';

export { FIXED_NOW, connectWallet, handleFor, harness, type HarnessOptions } from './harness.ts';
