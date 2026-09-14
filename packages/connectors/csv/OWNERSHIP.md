# `@connector/csv` — table ownership

`CsvImportConnector`: CSV with a user-supplied column mapping, OFX 1.x (SGML)
and 2.x (XML) including `.qfx`, and QIF.

## Tables

None. An adapter never writes to the database.

One claim that deliberately is **not** made here: the CSV mapping profiles. 08
§2.6 calls them user data, stored per institution, which means they belong in a
table — but the table belongs to `@ctx/connections` (which persists connection
configuration) and not to a package that owns no database handle.
`CSV_PRESETS` in `src/presets.ts` is a set of starting points, not storage.

## Third party

See `NOTICE`. Nothing is vendored; the parsers are original; `ofxtools`
(GPL-3.0) and Firefly III's import configurations (CC-BY-SA-4.0) were not used.
