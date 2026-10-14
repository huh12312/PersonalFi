// SPDX-License-Identifier: MIT
/**
 * The OpenFIGI HTTP adapter — *'120 symbols are two batched requests, not
 * 120'*.
 *
 * WP 3.1 declared the `FigiMapper` port and left the adapter to this WP,
 * because OpenFIGI is an egress surface and 03 §5.2's lesson is that *"the
 * second implementation of an allow-list is where the hole is"*. So the port
 * lives in `@ctx/investments`, the socket lives here, and the two are matched
 * structurally in the composition root rather than by a cross-context import
 * that `personalfi/layer-imports` forbids.
 *
 * ## Why batching is a correctness claim and not an optimisation
 *
 * The budget is 25,000 *jobs* per minute (01 §4.1) — jobs, not requests — so
 * `cost` is the batch size. A hundred and twenty symbols sent one at a time
 * would be 120 requests for the same 120 jobs, which is both slower and, on a
 * free anonymous key, a good way to be throttled into a resolution failure that
 * looks like "this security does not exist".
 *
 * ## Why position is a correctness claim
 *
 * OpenFIGI returns one result per job **in the order the jobs were sent**, with
 * no echo of the input. A caller that re-derived the association by matching
 * `idValue` back would get it wrong for exactly the case that matters: two jobs
 * with the same ticker and different `micCode`.
 */
import { describe, expect, it } from 'vitest';
import { createProviderClient } from '../src/http.ts';
import { policyFor } from '../src/egress.ts';
import { apiKeyOf } from '../src/secrets.ts';
import { createFakeTransport, jsonResponse } from '../src/adapters/fake.ts';
import {
  OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST,
  OPENFIGI_MAX_JOBS_PER_REQUEST,
  createOpenFigiMapper,
  type FigiMapJob,
} from '../src/adapters/openfigi.ts';

const NOW = new Date('2026-09-21T03:45:00.000Z');
const now = (): Date => NOW;
const PUBLIC = () => Promise.resolve(['93.184.216.34']);
const KEY = apiKeyOf('openfigi', 'a-long-enough-test-key-000000');

/** Answer every job in a POSTed batch with a distinct FIGI, positionally. */
function batchEcho() {
  return createFakeTransport((request) => {
    const jobs = JSON.parse(request.body ?? '[]') as { idValue: string }[];
    return jsonResponse(
      jobs.map((job) => ({
        data: [
          { figi: `BBG${job.idValue.padEnd(9, 'X')}`, ticker: job.idValue, name: job.idValue },
        ],
      })),
    );
  });
}

function jobs(count: number): FigiMapJob[] {
  return Array.from({ length: count }, (_, i) => ({
    idType: 'TICKER' as const,
    idValue: `SYM${String(i).padStart(3, '0')}`,
    micCode: null,
  }));
}

function mapperOver(transport: ReturnType<typeof createFakeTransport>, key = KEY) {
  return createOpenFigiMapper({
    client: createProviderClient({
      provider: 'openfigi',
      policy: policyFor('openfigi'),
      transport: transport.transport,
      resolve: PUBLIC,
    }),
    key,
    now,
  });
}

describe('the OpenFIGI adapter', () => {
  it('120 symbols are two batched requests, not 120', async () => {
    const transport = batchEcho();
    const mapper = mapperOver(transport);

    const outcomes = await mapper.map(jobs(120));

    // Two requests: 100 + 20.
    expect(transport.requests).toHaveLength(2);
    expect(mapper.requestCount()).toBe(2);
    expect(JSON.parse(transport.requests[0]?.body ?? '[]')).toHaveLength(100);
    expect(JSON.parse(transport.requests[1]?.body ?? '[]')).toHaveLength(20);

    // One outcome per job, all of them.
    expect(outcomes).toHaveLength(120);
    expect(outcomes.every((o) => o.status === 'matched')).toBe(true);

    // Billed in jobs, not requests: 120 jobs against 25,000/minute.
    const [window] = mapper.budget(NOW);
    expect(window?.used).toBe(120);
    expect(window?.limit).toBe(25_000);
  });

  it('results stay in the order the jobs were sent', async () => {
    // The case that breaks a re-matching implementation: the same ticker at two
    // venues. Position is the only thing that distinguishes them.
    const transport = createFakeTransport(() =>
      jsonResponse([
        { data: [{ figi: 'BBG000B9XRY4', exchCode: 'UN', ticker: 'AAPL' }] },
        { data: [{ figi: 'BBG000B9XY55', exchCode: 'UW', ticker: 'AAPL' }] },
      ]),
    );
    const outcomes = await mapperOver(transport).map([
      { idType: 'TICKER', idValue: 'AAPL', micCode: 'XNYS' },
      { idType: 'TICKER', idValue: 'AAPL', micCode: 'XNAS' },
    ]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.status).toBe('matched');
    if (outcomes[0]?.status !== 'matched') throw new Error('unreachable');
    expect(outcomes[0].mappings[0]?.figi).toBe('BBG000B9XRY4');
    if (outcomes[1]?.status !== 'matched') throw new Error('unreachable');
    expect(outcomes[1].mappings[0]?.figi).toBe('BBG000B9XY55');
  });

  it('batches at 10 without a key, because anonymous is a real mode', async () => {
    // Unlike the three price sources, OpenFIGI genuinely works without a key at
    // a tenth of the batch size. Refusing to use it would make symbol mapping
    // unavailable on an install that has not created that key yet — a
    // degradation, not a failure (dispatch §6).
    const transport = batchEcho();
    const mapper = mapperOver(transport, apiKeyOf('openfigi', ''));

    const outcomes = await mapper.map(jobs(25));

    expect(OPENFIGI_MAX_JOBS_PER_REQUEST).toBe(100);
    expect(OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST).toBe(10);
    // 10 + 10 + 5.
    expect(transport.requests).toHaveLength(3);
    expect(outcomes).toHaveLength(25);
    // And no empty key header is sent — which would earn a 401 that looks like
    // a bad key rather than an anonymous call.
    for (const request of transport.requests) {
      expect(request.headers['x-openfigi-apikey']).toBeUndefined();
    }
  });

  it(
    'without a key, the budget is the published anonymous tier — 25 requests/minute, billed by ' +
      'request — not the keyed 25,000 jobs/minute (WP 4.12b, C-8)',
    async () => {
      const transport = batchEcho();
      const mapper = mapperOver(transport, apiKeyOf('openfigi', ''));

      // 3 requests (10 + 10 + 5), so 3 requests spent — never 25 jobs spent
      // against a jobs-denominated window.
      await mapper.map(jobs(25));

      const [window] = mapper.budget(NOW);
      expect(window?.limit).toBe(25);
      expect(window?.used).toBe(3);
    },
  );

  it('"No identifier found" is a no_match, anything else is an error', async () => {
    // A fact about the identifier versus a fault in the call. Recording a
    // transient fault as `no_match` would write a permanent, wrong conclusion
    // about a security the user owns.
    const transport = createFakeTransport(() =>
      jsonResponse([
        { error: 'No identifier found.' },
        { error: 'Invalid idType value.' },
        { data: [] },
      ]),
    );
    const outcomes = await mapperOver(transport).map([
      { idType: 'TICKER', idValue: 'NOPE', micCode: null },
      { idType: 'TICKER', idValue: 'BAD', micCode: null },
      { idType: 'TICKER', idValue: 'EMPTY', micCode: null },
    ]);

    expect(outcomes[0]?.status).toBe('no_match');
    expect(outcomes[1]?.status).toBe('error');
    // An empty `data` array is a no-match too — the provider answered, and its
    // answer was "nothing".
    expect(outcomes[2]?.status).toBe('no_match');
  });

  it('a failed batch yields one error per job, preserving the positional contract', async () => {
    // The caller indexes into the result by job position. A batch that failed
    // wholesale must still return the same number of entries or every
    // association after it shifts by one.
    const transport = createFakeTransport(() => jsonResponse({ error: 'upstream' }, 500));
    const outcomes = await mapperOver(transport).map(jobs(7));

    expect(outcomes).toHaveLength(7);
    expect(outcomes.every((o) => o.status === 'error')).toBe(true);
  });

  it('a result array that does not line up is an error, not a silent mis-association', async () => {
    // Three jobs, two results. Zipping them would associate job 3's identity
    // with nothing and job 2's FIGI with job 2 by luck.
    const transport = createFakeTransport(() =>
      jsonResponse([{ data: [{ figi: 'BBG1' }] }, { data: [{ figi: 'BBG2' }] }]),
    );
    const outcomes = await mapperOver(transport).map(jobs(3));

    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.status === 'error')).toBe(true);
    if (outcomes[0]?.status !== 'error') throw new Error('unreachable');
    expect(outcomes[0].message).toContain('does not line up');
  });

  it('sends the key in a header and JSON in the body', async () => {
    const transport = batchEcho();
    await mapperOver(transport).map(jobs(1));

    const request = transport.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.headers['x-openfigi-apikey']).toBe('a-long-enough-test-key-000000');
    expect(request?.headers['content-type']).toBe('application/json');
    // `micCode: null` is omitted rather than sent as null — OpenFIGI rejects a
    // null there.
    expect(request?.body).not.toContain('null');
  });

  it('D29: sends exchCode on a US-composite job and parses compositeFIGI', async () => {
    // A bare US-dollar ticker is asked as `TICKER` + `exchCode: US` with no
    // `micCode`; the answer's per-venue lines carry the composite FIGI the
    // resolver establishes identity on. A line without one parses as `null`.
    const transport = createFakeTransport(() =>
      jsonResponse([
        {
          data: [
            { figi: 'BBG000BDTF76', ticker: 'VTI', exchCode: 'US', compositeFIGI: 'BBG000BDTF76' },
            { figi: 'BBG000BDTG11', ticker: 'VTI', exchCode: 'UP' },
          ],
        },
        { data: [{ figi: 'BBG000BHTMY2', compositeFIGI: 'BBG000BHTMY2' }] },
      ]),
    );
    const outcomes = await mapperOver(transport).map([
      { idType: 'TICKER', idValue: 'VTI', micCode: null, exchCode: 'US' },
      { idType: 'ID_ISIN', idValue: 'US9229087690', micCode: null },
    ]);

    expect(JSON.parse(transport.requests[0]?.body ?? 'null')).toEqual([
      { idType: 'TICKER', idValue: 'VTI', exchCode: 'US' },
      { idType: 'ID_ISIN', idValue: 'US9229087690' },
    ]);
    expect(outcomes[0]).toEqual({
      status: 'matched',
      mappings: [
        {
          figi: 'BBG000BDTF76',
          name: null,
          ticker: 'VTI',
          exchCode: 'US',
          securityType: null,
          marketSector: null,
          compositeFigi: 'BBG000BDTF76',
        },
        {
          figi: 'BBG000BDTG11',
          name: null,
          ticker: 'VTI',
          exchCode: 'UP',
          securityType: null,
          marketSector: null,
          compositeFigi: null,
        },
      ],
    });
    if (outcomes[1]?.status !== 'matched') throw new Error('expected a match');
    expect(outcomes[1].mappings[0]?.compositeFigi).toBe('BBG000BHTMY2');
  });

  it('an empty job list makes no request at all', async () => {
    const transport = batchEcho();
    const outcomes = await mapperOver(transport).map([]);
    expect(outcomes).toEqual([]);
    expect(transport.requests).toHaveLength(0);
  });

  it('SABOTAGE: unbatched mapping would cost 120 requests for the same 120 jobs', async () => {
    // The negative control. One job per call is what a naive implementation
    // does, and it is indistinguishable from the batched one by result — only
    // the request count tells them apart, which is why the request count is
    // what the exit test asserts.
    const transport = batchEcho();
    const mapper = mapperOver(transport);

    for (const job of jobs(120)) await mapper.map([job]);
    expect(transport.requests).toHaveLength(120);

    // The batched path, for contrast.
    const batched = batchEcho();
    await mapperOver(batched).map(jobs(120));
    expect(batched.requests).toHaveLength(2);
  });
});
