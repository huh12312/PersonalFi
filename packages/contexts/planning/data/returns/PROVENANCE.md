# Historical return series — provenance, terms, checksum

The bootstrap engine (WP 4.5, `src/engine/bootstrap.ts`) resamples **real monthly returns of US
equities, 10-year Treasuries and CPI-U**, derived from Robert J. Shiller's `ie_data.xls`. This file
records where those numbers come from, what the publishers' terms say, and why the derived CSV is
**fetched on first run and checksum-pinned rather than vendored** in the repository.

## What is committed, and what is not

| Committed                                                            | Not committed (git-ignored, `cache/`)            |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| `derive.ts` — the derivation, bytes in → canonical CSV out           | `cache/shiller-monthly.csv` — the derived series |
| `xls.ts` — a minimal BIFF8 reader (no spreadsheet dependency)        | the upstream `ie_data.xls` itself (never stored) |
| `fetch.ts` — the operator's command                                  |                                                  |
| `series.ts` — loader: refuses any cache whose SHA-256 is not the pin |                                                  |
| `SHA256SUMS` — the pin                                               |                                                  |
| this note                                                            |                                                  |

## Sources

### Shiller, `ie_data.xls` — the series the engine uses

- **Publisher:** Robert J. Shiller (Yale), "U.S. Stock Markets 1871–Present and CAPE Ratio",
  <https://shillerdata.com/> (the Yale page `econ.yale.edu/~shiller/data.htm` now links there).
- **Fetched:** 2026-09-26 (by WP 4.5). Blob URL discovered from the landing page;
  `Last-Modified: Wed, 02 Sep 2026 17:51:53 GMT`; 1,674,752 bytes;
  raw SHA-256 `044196dafe44c3030b2facbdea023975b3f6aa68b4e52f8f9bafc403e19589c1`
  (printed, **not** pinned — Shiller re-uploads monthly). Upstream's last row: 2026.09.
- **Upstream components** (per the page): S&P Composite prices (monthly average of daily closes) and
  S&P four-quarter dividend totals since 1926; Cowles Commission indexes before 1926; CPI-U from the
  US Bureau of Labor Statistics from 1913, spliced to Warren & Pearson before; GS10 and Shiller's own
  monthly bond total-return construction.
- **Columns read, by header (never by position):** Date, P, D, CPI, Real Total Return Price, Monthly
  Total Bond Returns, Real Total Bond Returns.

### Damodaran, `histretSP.xls` — a cross-check only, never used by the engine

- **Publisher:** Aswath Damodaran (NYU Stern), "Historical Returns on Stocks, Bonds and Bills",
  <https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histret.html>, data file
  `…/pc/datasets/histretSP.xls`. Fetched 2026-09-26; 527,872 bytes; SHA-256
  `28b8110916a15a4dcc11c87c6422510704608ddedcdfa67a1298abdc22e49c69`. Page dated January 2026.
- Used by `fetch.ts --damodaran` to compare calendar-year compounding of the derived monthly real
  S&P return against Damodaran's "Annual Real Returns — S&P 500 (includes dividends)". Not read at
  runtime, not cached, not shipped.

## The derivation (`derive.ts`)

Per month _t_ (the row labelled _t_ covers *t*−1 → _t_):

```
equity_real_t = (P_t + D_t / 12) / P_{t−1} × CPI_{t−1} / CPI_t − 1
bond_real_t   = G_{t−1}                  × CPI_{t−1} / CPI_t − 1
inflation_t   = CPI_t / CPI_{t−1} − 1
```

Window pinned to **1871-02 .. 2024-12 (1,847 months)** so Shiller's monthly revisions of recent
dividends and CPI do not move the bytes. Twelve decimal places, fixed-point text.

**Cross-checks, as run on 2026-09-26:**

- Against Shiller's own index columns (Real Total Return Price, Real Total Bond Returns): maximum
  |derived − index ratio| = **4.4 × 10⁻¹⁶** for equity and for bonds (refusal threshold 10⁻⁹).
- Against Damodaran: 97 calendar years 1928–2024, mean |Shiller − Damodaran| real S&P return
  = 2.11 points, correlation **0.9897**, means 8.64 % vs 8.55 %. (Shiller's P is a monthly average of
  daily closes and Damodaran's is year-end to year-end, so individual years differ; the means agree.)

## The pin

```
cbdefda1752eac2bd393efbae29a8dfb8d0af2b79a9d7cf2baa5f0e292851e80  shiller-monthly.csv
```

`loadReturnSeries` refuses a cache whose bytes do not hash to this (`planning.returns_series_checksum_mismatch`);
`ensureReturnSeries` downloads, derives, and writes the cache **only** if the derivation hashes to it.
Moving the window or accepting an upstream revision is `fetch.ts --pin` — a reviewed data change.

## Licence terms, as found (2026-09-26)

**Shiller.** Neither shillerdata.com nor the workbook states a licence or grants redistribution. The
page offers the data "for download"; its only terms are a disclaimer: _"No representation is made as
to the accuracy … The user of this information assumes the entire risk of any use made of the
information provided herein … None of Professor Shiller, Yale University or any other party involved
in making or compiling any of the information … makes any express or implied warranty …"_ The
workbook's own `Disclaimer` sheet: _"The data and CAPE Ratio on this spreadsheet were developed by
Robert J. Shiller using various public sources … do not guarantee the accuracy or completeness …"_
Construction is attributed to "Robert J. Shiller, RSBB-I, LLC, and consultants". The S&P-derived
columns are compiled from S&P Dow Jones Indices data, whose own terms are proprietary.

**Damodaran.** The "Usage rules" on his data-history page: _"I am not good at making rules and thus
have very few related to the use of my data. I want the data to be widely used … Acknowledgements:
If you do use my data and wish to acknowledge that you did get the data off my site, I thank you. If
not, I will not lose any sleep … this data is here for you to use."_ Permissive in spirit, but not a
licence, and he notes his inputs come from commercial services (Bloomberg, Morningstar, Capital IQ,
Compustat) whose interests he must respect.

## Verdict (dispatch §6 Q3)

Research use is plainly intended; **redistribution is not granted** by either publisher, and for
Shiller the underlying index data is a third party's. D15's licence gate runs over the runtime tree,
and "everyone does it" is not a licence. So, per §6 Q3's stated fallback:

- **The derived series is not vendored.** It is fetched on first run (`fetch.ts`, or
  `ensureReturnSeries` with a downloader the composition root supplies) and verified against the
  committed pin before use.
- **The offline guarantee is lost for the bootstrap engine.** A fresh install with no network and no
  cache cannot run the default engine; `loadReturnSeries` refuses with
  `planning.returns_series_unavailable`, naming `node packages/contexts/planning/data/returns/fetch.ts`,
  and the lognormal engine (which needs no history) still runs. Whether to accept that trade, seek
  permission, or vendor anyway is Chris's decision, not an agent's.
- **The cache must not ride into an image or a commit.** `cache/` is git-ignored here, but the repo's
  `.dockerignore` does not exclude it, so an image built on a machine with a filled cache would ship
  the derived data — see the WP 4.5 evidence, "For the orchestrator".
- The engine's tests use a **synthetic** series (`test/engine/fixtures/synthetic-series.ts`) of the
  same shape, so CI needs neither the network nor the data.
