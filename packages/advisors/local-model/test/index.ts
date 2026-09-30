// SPDX-License-Identifier: MIT
/**
 * `@advisor/local-model/test` — the fake Ollama server, for a consumer
 * outside this package.
 *
 * `apps/api/test/db/phase5-wiring.test.ts` (05-phase-5-dispatch.md §4 W-C)
 * needs a `local.narrator` run through the **real** adapter
 * (`createLocalModelAdapter`) and the real local-endpoint transport, killed
 * at each of the four levels while the model is genuinely mid-reply —
 * `fake-ollama.ts`'s `ChatMode: { kind: 'endless' }` is exactly the double
 * WP 5.2's own `test/ollama-client.test.ts` proves an abort against, and W-C
 * reuses it rather than building a second one a layer up that could quietly
 * stop matching the real adapter's behaviour.
 *
 * This package's second `exports` entry (`package.json`'s
 * `"./test": "./test/index.ts"`), added deliberately narrow, the
 * `@connector/plaid/test` precedent: nothing under `src/` imports it, it
 * performs no I/O of its own (it starts a real `node:http` server only when
 * a caller calls `startFakeOllama`), and it is documented here rather than a
 * new dependency being added to reach the same fixture.
 */
export {
  startFakeOllama,
  type ChatMode,
  type FakeModel,
  type FakeOllama,
  type RecordedRequest,
} from './fake-ollama.ts';
