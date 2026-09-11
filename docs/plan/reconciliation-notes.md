# Panel reconciliation notes (working file for the master plan)

Conflicts and cross-memo findings that the master plan must resolve. Updated as memos land.

## R-A. Backend language: TypeScript (04) vs Go (03)
- 03 Security prefers Go on supply-chain grounds (smaller dep closure), but explicitly defers if TS wins and names SimpleWebAuthn as the most mature passkey lib.
- 04 Backend: TS/Node 26 + Fastify + Drizzle + PG18; pure-JS stack is native-module-free on Alpine (conditional on Postgres, not SQLite); Plaid SDKs are OpenAPI-generated so language is a non-differentiator; Monte Carlo fits in worker_threads.
- 05 Frontend: React 19 + Vite + TanStack, binds via OpenAPI; language-agnostic to backend.
- 06 DevOps: assumes TS; pnpm + pg-boss; musl mitigations documented (@node-rs/argon2, no better-sqlite3).
- **Decision: TypeScript.** Accept 03's condition: supply-chain controls (Renovate 7-day minimumReleaseAge, --ignore-scripts, dependency-count budget, lockfile pinning) become P0 not P1.

## R-B. Webhooks vs polling vs OAuth redirect
- 03, 06: zero public ingress; poll /transactions/sync.
- 01: recommends webhooks "never polling", AND flags that Production OAuth needs an HTTPS redirect URI (R2), claiming LAN-only can't link Chase/BofA.
- Verified 2026-09-10 (plaid.com/docs/link/oauth): the redirect URI is followed only by the end user's browser; no server-to-server call; must be HTTPS and registered in Dashboard; no requirement of public reachability.
- Verified (tailscale.com/kb/1153): Tailscale issues Let's Encrypt certs for <node>.<tailnet>.ts.net; MagicDNS resolves on tailnet devices; hostname lands in CT logs (pick a bland node name).
- **Decision: polling-only, zero public ingress. Redirect URI = https://<node>.<tailnet>.ts.net/link/oauth via Tailscale Serve.** Webhooks stay an optional compose profile. Accept and document the polling freshness floor (Plaid recommends /transactions/sync polling; choose 4–6 h cadence + manual "sync now"). 01's "never polling" is overridden by security posture; 01 itself notes Plaid requires polling as a fallback anyway.

## R-C. Vibe-Trading
- 03: fetched repo; it is a live-trading platform (14+ brokers, executes orders, 74+ MCP tools, agent loop). Treat as hostile-by-construction.
- 06: MIT licensed (verified), v0.1.15 (2026-09-09), Python 3.11+, FastAPI server, needs LLM keys. No copyleft risk; isolate anyway for blast radius. Its deps excluded from our license gate; runs on its own image, not Alpine.
- 04: exposes MCP tools over stdio; speak protocol, don't import. Data export is percentages-not-dollars.
- **Decision: separate image (upstream's or python:3.14-slim), own internal network, no DB, no broker write creds, app→sidecar only, strict JSON schema output, human-ack + step-up auth for any trade card. Phase 6.** Await 02 and 08 for the adapter contract details.

## R-D. Plaid access + product scope (01)
- Trial plan (2026-04-15): free, no business registration, 10-Item hard ratchet (/item/remove does not free slots), excludes Recurring Transactions & Enrich.
- Request only transactions + investments + liabilities. No Auth, no Identity (matches 03 P1-8).
- Build recurring detection in-house (matches 04 §5.1, await 07).
- Pending→posted = delete+insert with pending_transaction_id link → surrogate PK + overlay preservation (matches 04 §2.2).
- Trial→Production is a one-way door: do not apply "to see pricing".
- Crypto direct-to-exchange (Coinbase CDP, can_view only). Prototype the v3 ledger gap early (deposits/withdrawals/staking).
- Market data: Tiingo default, FRED macro, OpenFIGI mapping, CoinGecko Demo (attribution UI), yfinance opt-in only.

## R-E. Frontend (05) — no conflicts
- React 19 + Vite 7 + TanStack Router/Query; OpenAPI client via @hey-api/openapi-ts; visx charts; Tailwind v4 + shadcn (Base UI) vendored; Lucide; CVD-safe teal/vermilion money colors; Monte Carlo in a Web Worker client-side for slider interactivity (server engine remains the source of truth for saved scenarios — reconcile with 04 §5.6).

## R-F. Open decisions still needing an owner
- Passkey lockout recovery: 03 P0-4 says ≥2 authenticators + 10 recovery codes. Adopt. (Answers 04 Q2.)
- Backup destination: 06 recommends B2 with object lock (~$1/mo). Adopt as P0-11 target, local + B2.
- Ollama profile: keep as optional profile; 03 §8.4 wants local-model default for transaction-level data. Adopt: local-only default, cloud LLM allowed only for non-personal market queries.
- KEK custody: 03 §2.2 → systemd-creds/Docker secret now, TPM2-sealed later (P2-3), unlock page as recovery.
- On-chain wallets: 04 Q4 says v1 = Coinbase + manual only; 01 specced xpub/Esplora/Etherscan. Adopt 04's scoping: on-chain read-only balances in Phase 3b, not 3a.

## R-G. Additions after memos 07, 08, 09 landed (2026-09-11)
- **Node/PG versions:** 08 wrote "Node 22 LTS / PG 17"; 04 and 06 verified Node 26 and `postgres:18.4-alpine`. **Decision: Node 26, PG 18** (installed locally; Node 26 enters LTS Oct 2026).
- **Webhooks in Phase 1 (08):** removed; polling per R-B. Phase 1 effort reduced accordingly.
- **"Plaid production access is the longest-lead item" (08):** stale; Trial plan is auto-approved after identity verification (01). Still start signup in Phase 0.
- **Key custody scope:** 08 D5 (encrypt only provider secrets; key loss = re-link, not data loss) vs 03 §2 (also bulk-DEK for PII columns). **Decision:** provider/exchange/LLM secrets + channel configs row-level in P0; bulk column encryption of memos/descriptions is P2. Key-loss scope rule from 08 adopted.
- **Session length:** 09 Q8 (14-day trusted session) vs 03 (15 min idle / 8 h absolute). **Decision:** 03 defaults, with an explicit trusted-device toggle extending refresh to 14 days under rotation + reuse detection.
- **Budget default naming:** 07 "Envelope-lite" and 09 "flexible targets + rollover + sinking funds" are the same model. **Decision:** call it Envelope-lite; strict envelope and 50/30/20 are derived views.
- **Auth fallback:** 09 suggests password+TOTP fallback; 03 says passkey + TOTP + recovery codes, no password. **Decision:** no password; passkeys + TOTP + 10 recovery codes.
- **08 risk register (§9) was never written** (agent cut off). Written directly into the master plan §7.
- **02 memo was never written** (agent cut off); consolidated from its six completed sub-reports into `02-ecosystem-vibe-trading.md`.
- **Ghostfolio TWR/MWR:** prior-art research found these are unimplemented stubs; do not cite Ghostfolio for performance math. 07 §4 formulas are the reference.
- **Plaid PFC CSV:** no license grant found. Our taxonomy uses PFCv2 as structure only, with our own labels and descriptions; Plaid codes are mapped at runtime.
