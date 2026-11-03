# 14 — Yahoo Finance through `yfinance`, as an opt-in component

**Status.** Design, 2026-11-02, for WP 12.6. Chris: "I want to enable the yahoo finance python as
an optional component for users. I realize it has licensing risk, hence why we will make it opt in."
Recorded as D33 in `docs/plan/00-master-implementation-plan.md`. The posture is the one
`01-aggregation-plaid.md` §4.2 chose in September: never a documented default; opt-in, clearly
labelled, best-effort. What changes is that the adapter now gets built.

## 1. What already exists

The repository has carried `yfinance` as a reserved provider since Phase 3, with nothing behind it:
the provider enum (`packages/contexts/integrations/schema/market-data.ts`, migration 0015's CHECKs
on `price_source_priority`, the price-quote source column and the refresh-run provider column), the
host in `PROVIDER_HOSTS` (`query1.finance.yahoo.com`) **deliberately absent from
`MARKET_DATA_ALLOWED_HOSTS`**, a self-imposed `YFINANCE_WINDOWS` budget (60 requests per hour), a
key source of `none`, the Settings → Market data test-fetch option, and the evidence note "not
built; deliberate" (`docs/evidence/phase-3/wp3.4-market-data.md`). The execution log of 2026-10-15
answers Chris's earlier question: it cannot "just work" because nothing reaches the host.

## 2. The risk, stated once

- **The code is fine.** `yfinance` is Apache-2.0, compatible with MIT. Its own dependencies are
  permissive except `frozendict` (LGPL-3.0, the "allowed with review" class of 06 §5.4 — consumed as
  a separate package inside a separate container, never modified or statically linked).
- **The data is the risk.** Yahoo publishes no data licence; its terms prohibit automated collection;
  `yfinance`'s README says the API "is intended for personal use only". Yahoo also changes the
  undocumented endpoints without notice, and self-hosters of projects that default to Yahoo report
  `429 Too Many Requests` and missing history (01 §4.2 cites the Ghostfolio issues).
- **So the posture is:** a single self-hoster, their own machine, their own portfolio, personal use —
  the same shape as the Tiingo personal tier — **opted into by that person, in words, with the
  terms in front of them, after the operator has also enabled the component.** PersonalFi never
  turns it on, never makes it the default price source, never redistributes the data (the export
  excludes Yahoo-sourced quotes' provenance beyond the provider name), and labels every figure that
  came from it.

## 3. Shape: a sidecar, not a library in the api

The api and worker are TypeScript; `yfinance` is Python and does the cookie-and-crumb dance Yahoo
requires, which a hand-rolled client would re-implement badly. So the Python runs in **its own
container**, the way the local model does (WP 5.2's `ollama` service is the precedent for an opt-in
sidecar with its own profile, network, user and limits):

| Piece                          | Design                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image                          | `docker/yahoo.Dockerfile`: `python:3.x-alpine` by digest, `yfinance` and its dependencies installed with `pip --require-hashes` from a checked-in `requirements.txt` (versions and sha256 per wheel), non-root uid 10004, read-only rootfs, no shell needed at runtime. Published as a fourth image, `personalfi-yahoo`, both architectures, signed and attested like the other three. |
| Surface                        | A tiny HTTP service inside the container (the standard library's server is enough; no web framework): `GET /quote?symbol=…&date=…`, `GET /fx?from=…&to=…&date=…`, `GET /search?q=…`, `GET /health`. JSON out, no state, no cache beyond the process. It speaks only to the worker.                                                      |
| Compose                        | Service `yahoo`, `profiles: ['yahoo']`, on a new network `yahoo` that is **not** internal (the sidecar must reach Yahoo) and is joined by the sidecar and the worker only; `x-common` hardening (read_only, cap_drop ALL, no-new-privileges), `pids` and `mem` limits, a healthcheck on `/health`, no secret, no `.env` environment except `YAHOO_FINANCE_USER_AGENT`-free defaults. The hardening check gains `yahoo-*` rules mirroring the `ollama-*` set. |
| Adapter                        | `packages/contexts/integrations/src/adapters/yfinance.ts`: a `PriceSource` over the sidecar's HTTP, with the same outcome vocabulary as Tiingo (`ok`, `skipped_*`, `error`), `last_known` fallback on failure, the `YFINANCE_WINDOWS` budget enforced by the existing rate-limit module, exponential backoff on 429, and **attribution** "Yahoo Finance via yfinance — unofficial, best effort" carried on every quote. |
| Egress                         | The adapter's exact-host allow-list is the sidecar's service name on the `yahoo` network (`http://yahoo:8000`), never Yahoo itself; the sidecar's own outbound is `query1.finance.yahoo.com` and `query2.finance.yahoo.com` on 443 — enforced inside the sidecar by a host check before any request, and documented as the only two hosts the container speaks to. `MARKET_DATA_ALLOWED_HOSTS` stays as it is: the api process still cannot reach Yahoo. |
| Registration (the operator half) | The adapter is registered only when the operator set `YAHOO_FINANCE_ENABLED=true` in `.env` **and** brought the profile up (`docker compose --profile yahoo up -d`). With the variable unset the worker logs one line ("yfinance not enabled; adapter not registered") and the Settings card says so.                                                                       |
| Consent (the holder half)      | Settings → Market data gains a Yahoo card with a consent box in the narrator-consent pattern (versioned text, sha256 recorded with the time): the terms in plain words (unofficial; Yahoo's terms prohibit automated collection; personal use only; best effort, may stop working; the data is not licensed for redistribution), and "Use this provider" is refused until it is ticked. Unticking it withdraws the provider from the priority list at once. Both halves must hold for a single request to leave the machine. |
| Priority                       | Never inserted into `price_source_priority` automatically. The holder places it, and the card shows where it sits. The nightly price refresh uses it only for subjects the higher-priority sources answered `skipped_no_key`/`skipped_unsupported` for, unless the holder ranks it higher on purpose. |
| Labels                         | Every quote, holding valuation and chart point sourced from it carries the provider badge the attribution component already renders for CoinGecko, with the "unofficial, best effort" wording; the export marks the provider.                                                                                                             |
| Failure                        | A 429 or a shape change is a `skipped_provider_unavailable` outcome with the reason, never a crash of the refresh; the soak report's price-refresh table gains the provider's row; the Settings card shows the last outcome and the budget left.                                                                                           |
| Tests                          | The adapter against a fake sidecar (fixtures recorded from `yfinance`'s documented response shapes — no live Yahoo call in any test); the sidecar's own tests in Python against the library's fakeable layer or recorded JSON (no live call); the consent and registration gates sabotaged (a request with either half missing must never leave); the hardening rules red-first; the compose profile asserted by the hardening check; the release invariants test updated for the fourth image. |

## 4. What is not done

- Not the default, not suggested, not pre-ranked. The README mentions it once, under "What is
  supported", as "available opt-in; unofficial".
- No Yahoo data in any fixture, screenshot or test committed to the public repository.
- No fundamentals, no options, no intraday — EOD closes, FX and symbol search only, the three
  calls the `PriceSource` port has.
- No second provider in the same sidecar (Twelve Data stays a separate, keyed adapter if it ever
  comes).

## 5. Package

| #    | Package                                                                                                                                                                                                                                             | Depends on | Size |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- |
| 12.6 | **Yahoo Finance via `yfinance`, opt-in**: the sidecar image and compose service, the adapter, the two-half opt-in (operator variable + profile, holder consent), labels and attribution, hardening rules, the fourth published image, RUNBOOK and release notes | 12.3       | M    |

Decisions for Chris are in D33; the rest follows the precedents above.
