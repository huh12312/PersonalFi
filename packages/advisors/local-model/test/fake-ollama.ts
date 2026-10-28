// SPDX-License-Identifier: MIT
/**
 * A fake Ollama: a real `node:http` server speaking the endpoints the adapter
 * uses — `GET /api/tags`, a streamed `POST /api/chat`, and (WP 9.5, C5-2)
 * `GET /api/ps` and the non-streamed warm-up `POST /api/chat`. The model
 * starts **loaded** (`loaded: true`), so a test that does not ask about the
 * warm-up never sees one; a warm-up loads it.
 *
 * **Where it lives, and why here.** The adapter's layer denies every node
 * builtin (`scripts/eslint-boundaries.js`, `advisor-local-model`,
 * `allowNodeBuiltins: false`), but the same rule treats any file under a
 * `test/` directory as test tooling and lifts the builtin ban for it
 * (`eslint-boundaries.js`, the `isTest` exemption beside
 * `allowNodeBuiltins`). `@core/testkit` was the other candidate and is not
 * reachable: the layer's allow-list is kernel, platform and contracts only.
 * So the fake sits beside the tests that use it, and `test/structure.test.ts`
 * scans `src/` — the shipped code — for builtins, not `test/`.
 *
 * It records every request (method, path, parsed body) and every chat
 * socket's close, so a test can say "no prompt was sent" and "the socket was
 * closed mid-generation" about the server's own observations rather than the
 * client's.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeModel {
  readonly name: string;
  /** As Ollama reports it: 64 hex characters, no `sha256:`. */
  readonly digest: string;
}

export type ChatMode =
  /** Stream `reply` a few characters per line, then a done line. */
  | { readonly kind: 'reply'; readonly reply: string; readonly doneReason?: string }
  /** Stream forever, one line every `intervalMs`, until the client goes. */
  | { readonly kind: 'endless'; readonly intervalMs: number; readonly lineBytes?: number }
  /** Answer with a status and no stream. */
  | { readonly kind: 'status'; readonly status: number; readonly body?: string }
  /**
   * WP 11.5c: the reply chosen per request from the chat body — one fake
   * serving two query types in one job (Ask's compile, then its narrate).
   */
  | { readonly kind: 'respond'; readonly respond: (body: unknown) => string };

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface FakeOllama {
  readonly port: number;
  readonly requests: RecordedRequest[];
  /** One entry per chat request: whether its socket has closed, and how many bytes were written to it. */
  readonly chats: { closed: boolean; linesWritten: number }[];
  models: FakeModel[];
  chat: ChatMode;
  /** What `GET /api/ps` reports. A warm-up sets it. */
  loaded: boolean;
  /** Every warm-up (`stream: false`) chat's body, in order. Not in `chats`. */
  readonly warmUps: unknown[];
  /** The warm-up's answer status; anything but 200 leaves the model unloaded. */
  warmUpStatus: number;
  close(): Promise<void>;
}

const MODEL_ENTRY = (model: FakeModel): Record<string, unknown> => ({
  name: model.name,
  model: model.name,
  modified_at: '2026-09-17T21:37:49Z',
  size: 4_683_087_332,
  digest: model.digest,
  details: {
    format: 'gguf',
    family: 'qwen2',
    parameter_size: '7.6B',
    quantization_level: 'Q4_K_M',
  },
});

export async function startFakeOllama(initial: {
  models: FakeModel[];
  chat: ChatMode;
}): Promise<FakeOllama> {
  const requests: RecordedRequest[] = [];
  const chats: { closed: boolean; linesWritten: number }[] = [];
  const warmUps: unknown[] = [];

  const state = { models: initial.models, chat: initial.chat, loaded: true, warmUpStatus: 200 };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const path = req.url ?? '/';
      requests.push({ method: req.method ?? '?', path, body });

      if (req.method === 'GET' && path === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: state.models.map(MODEL_ENTRY) }));
        return;
      }
      if (req.method === 'GET' && path === '/api/ps') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: state.loaded ? state.models.map(MODEL_ENTRY) : [] }));
        return;
      }
      if (
        req.method === 'POST' &&
        path === '/api/chat' &&
        (body as { stream?: unknown } | null)?.stream === false
      ) {
        warmUps.push(body);
        if (state.warmUpStatus !== 200) {
          res.writeHead(state.warmUpStatus);
          res.end('{"error":"warm-up refused"}');
          return;
        }
        state.loaded = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: '{' },
            done: true,
            done_reason: 'length',
            eval_count: 1,
          }),
        );
        return;
      }
      if (req.method === 'POST' && path === '/api/chat') {
        const record = { closed: false, linesWritten: 0 };
        chats.push(record);
        res.socket?.on('close', () => {
          record.closed = true;
        });
        const mode: ChatMode =
          state.chat.kind === 'respond'
            ? { kind: 'reply', reply: state.chat.respond(body) }
            : state.chat;
        serveChat(mode, res, record);
        return;
      }
      res.writeHead(404);
      res.end('{"error":"not found"}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    requests,
    chats,
    get models() {
      return state.models;
    },
    set models(value: FakeModel[]) {
      state.models = value;
    },
    get chat() {
      return state.chat;
    },
    set chat(value: ChatMode) {
      state.chat = value;
    },
    get loaded() {
      return state.loaded;
    },
    set loaded(value: boolean) {
      state.loaded = value;
    },
    get warmUpStatus() {
      return state.warmUpStatus;
    },
    set warmUpStatus(value: number) {
      state.warmUpStatus = value;
    },
    warmUps,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function line(content: string, done: boolean, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    model: 'qwen2.5:7b-instruct-q4_K_M',
    created_at: '2026-09-29T12:00:00.000Z',
    message: { role: 'assistant', content },
    done,
    ...extra,
  })}\n`;
}

function serveChat(
  mode: ChatMode,
  res: http.ServerResponse,
  record: { closed: boolean; linesWritten: number },
): void {
  if (mode.kind === 'respond')
    throw new Error('a respond mode is resolved to a reply before serving');
  if (mode.kind === 'status') {
    res.writeHead(mode.status, { 'content-type': 'application/json' });
    res.end(mode.body ?? '{"error":"model is loading"}');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  if (mode.kind === 'reply') {
    const pieces = mode.reply.match(/[\s\S]{1,6}/gu) ?? [];
    for (const piece of pieces) {
      res.write(line(piece, false));
      record.linesWritten += 1;
    }
    res.end(
      line('', true, {
        done_reason: mode.doneReason ?? 'stop',
        total_duration: 1_000_000,
        prompt_eval_count: 812,
        eval_count: pieces.length,
      }),
    );
    return;
  }
  const filler = 'x'.repeat(Math.max(1, (mode.lineBytes ?? 64) - 120));
  const timer = setInterval(() => {
    if (record.closed) {
      clearInterval(timer);
      return;
    }
    res.write(line(filler, false));
    record.linesWritten += 1;
  }, mode.intervalMs);
  res.on('close', () => clearInterval(timer));
}
