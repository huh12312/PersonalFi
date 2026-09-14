# `@connector/manual` — table ownership

`ManualConnector` (the user is the provider) and `SeedConnector` (the demo
dataset, delivered through the same port so the orchestrator path is exercised
end to end).

## Tables

None. An adapter never writes to the database; it returns pages and
`@ctx/connections` persists them.

## Why manual entry is an adapter and not a special case

04 §4.1: "CSV/manual is a first-class adapter with a null cursor and an empty
webhook verifier. Treating manual accounts as 'a provider' avoids a parallel code
path — worth it for the ~5% of accounts that need it." A paid-off car, a savings
bond and cash under the mattress all belong in net worth, and none of them has a
provider; running them through the same orchestrator means they get the same
sync-run history, the same events, and the same UI.
