# `@connector/csv` — table ownership

`CsvImportConnector`: CSV with a user-supplied column mapping, OFX 1.x (SGML)
and 2.x (XML) including `.qfx`, and QIF.

## Tables

None. An adapter never writes to the database.

One claim that deliberately is **not** made here: the CSV mapping profiles. 08
§2.6 calls them user data, stored per institution, which means they belong in a
table — but the table belongs to `@ctx/connections` (which persists connection
configuration in `connections.config`, JSONB, migration 0005) and not to a
package that owns no database handle. `CSV_PRESETS` in `src/presets.ts` is a set
of starting points, not storage.

What this package ships instead is the **schema that row is checked against**,
in `src/config.ts`, because JSONB comes back as `unknown` and the owner of the
format is the only package that can say what a valid profile is:

- `csvProfileSchema` / `csvColumnMappingSchema` — a `CsvProfile`, exactly, with
  no defaults. `parseCsvProfile(raw)` raises the same `CONFIG_ERROR` the rest of
  this package raises for a file the user got wrong.
- `csvConnectionConfigSchema` — the per-connection payload,
  `{ profiles: Record<id, CsvProfile> }`, keyed by each profile's own id.
  `parseCsvConnectionConfig(raw)` is the edge.
- `resolveCsvProfile(config, id)` — the user's stored profile first, then the
  shipped presets, then `CONFIG_ERROR`.

`CsvImportConnector` runs a profile object through `parseCsvProfile` before it
imports with it (`src/connector.ts`, `resolveProfile`), so an `unknown` that was
asserted to `CsvProfile` somewhere upstream is still checked here. Ownership of
the _table_ is unchanged: the schema travels to `@ctx/connections`, not the row
to this package.

## Third party

See `NOTICE`. Nothing is vendored; the parsers are original; `ofxtools`
(GPL-3.0) and Firefly III's import configurations (CC-BY-SA-4.0) were not used.
