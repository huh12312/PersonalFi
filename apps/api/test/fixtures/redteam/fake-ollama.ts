// SPDX-License-Identifier: MIT
/**
 * A scripted Ollama for the red-team harness: a real `node:http` server on
 * loopback speaking the two endpoints WP 5.2's adapter uses.
 *
 * The minimal shape of `packages/advisors/local-model/test/fake-ollama.ts`,
 * copied rather than imported (that package does not export its test tooling,
 * and a file in `apps/api` may not reach across a package root). One
 * difference is the point of it: the reply is a **function of the prompt the
 * server actually received** — `respond(messages)` — so the adversarial model
 * reads the bytes on the wire, after `renderPrompt` and the sanitiser, and
 * can only obey what survived them.
 *
 * Every chat request's body is recorded, so the harness asserts on the prompt
 * the model was sent, not on a second rendering of it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_MODEL_NAME = 'qwen2.5:7b-instruct-q4_K_M';
/** 64 hex, as Ollama reports it. Synthetic. */
export const FAKE_MODEL_DIGEST = '5e4d'.repeat(16);

export interface WireMessage {
  readonly role: string;
  readonly content: string;
}

export type Responder = (messages: readonly WireMessage[]) => string;

export interface FakeOllama {
  readonly port: number;
  /** Every `POST /api/chat` body's messages, in order. */
  readonly prompts: (readonly WireMessage[])[];
  respond: Responder;
  close(): Promise<void>;
}

function line(content: string, done: boolean, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    model: FAKE_MODEL_NAME,
    created_at: '2026-09-30T12:00:00.000Z',
    message: { role: 'assistant', content },
    done,
    ...extra,
  })}\n`;
}

/** `host` defaults to IPv4 loopback; `'::'` listens dual-stack (a `localhost` smoke run of the live script). */
export async function startFakeOllama(respond: Responder, host = '127.0.0.1'): Promise<FakeOllama> {
  const prompts: (readonly WireMessage[])[] = [];
  const state = { respond };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '/';
      if (req.method === 'GET' && path === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [{ name: FAKE_MODEL_NAME, model: FAKE_MODEL_NAME, digest: FAKE_MODEL_DIGEST }],
          }),
        );
        return;
      }
      // WP 9.5 (C5-2): the model is always loaded here, so the adapter's
      // warm-up never fires and every chat this server sees is a narration.
      if (req.method === 'GET' && path === '/api/ps') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: FAKE_MODEL_NAME, model: FAKE_MODEL_NAME }] }));
        return;
      }
      if (req.method === 'POST' && path === '/api/chat') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages: WireMessage[];
        };
        prompts.push(body.messages);
        let reply: string;
        try {
          reply = state.respond(body.messages);
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error) }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const pieces = reply.match(/[\s\S]{1,512}/gu) ?? [];
        for (const piece of pieces) res.write(line(piece, false));
        res.end(
          line('', true, {
            done_reason: 'stop',
            total_duration: 1_000_000,
            prompt_eval_count: 800,
            eval_count: pieces.length,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end('{"error":"not found"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    prompts,
    get respond() {
      return state.respond;
    },
    set respond(value: Responder) {
      state.respond = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
