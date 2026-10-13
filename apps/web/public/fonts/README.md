# Vendored fonts

The application's only typefaces, served from this origin (`font-src 'self'`; D20: no CDN, nothing
is fetched from Google at runtime). Both are licensed under the SIL Open Font License 1.1
(`OFL-Geist.txt`; "Copyright 2024 The Geist Project Authors", https://github.com/vercel/geist-font).

| File                              | Family (CSS name)                    | Use                                                     |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| `geist-variable-latin.woff2`      | Geist (`'Geist Variable'`)           | UI text, money, dates, counts (tabular, lining figures) |
| `geist-mono-variable-latin.woff2` | Geist Mono (`'Geist Mono Variable'`) | Code, identifiers, scopes, recovery codes (`font-mono`) |

Both are variable fonts (weight axis 100-900), the Google Fonts `latin` subset (Basic Latin, Latin-1,
the euro sign, U+2212 minus sign, general punctuation). Other subsets (latin-ext, cyrillic, vietnamese)
are not vendored: Inter was also vendored as latin only, and a glyph outside the subset falls back to
the system fonts in `--font-sans` / `--font-mono`.

## Provenance

Fetched 2026-10-12 from the Google Fonts CSS API with a Chrome 130 user agent (so it returns woff2
variable files):

    https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap

| File                              | URL (the `/* latin */` block of that CSS)                                 | Google Fonts version | sha256                                                             |
| --------------------------------- | ------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| `geist-variable-latin.woff2`      | https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwcGFU.woff2            | Geist v5             | `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1` |
| `geist-mono-variable-latin.woff2` | https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrcdmg.woff2 | Geist Mono v6        | `684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc` |

`OFL-Geist.txt` is the upstream `OFL.txt` from https://github.com/google/fonts/tree/main/ofl/geist
(byte-identical to `ofl/geistmono/OFL.txt`), sha256 `1781d2806a07d91c4edf4740b88449fab7d0eadad53f7c351b94cd4d4eb8c00f`.

The files are unmodified downloads. To verify: `sha256sum *.woff2` and compare with the table.
To update, re-fetch the CSS above, take the `latin` URLs, replace the files and this table, and
re-run `pnpm --filter @app/web build` (the service-worker precache list is generated from the build).
