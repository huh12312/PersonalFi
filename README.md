# PersonalFi

A self-hosted, MIT-licensed, single-user personal finance and advisory application: expense tracking, budgeting, subscription intelligence, net worth, portfolio trajectory, and retirement planning across bank, brokerage, and crypto accounts via Plaid and direct exchange APIs.

**Status:** Phase 0 in progress. The monorepo skeleton, kernel types, typed config,
database layer, and boundary enforcement are in place; there is no application
functionality yet.

## Quick start

Requires Node 26, pnpm 12, just, and Docker.

```bash
just install    # install workspace dependencies
just db-up      # start the dev Postgres
just migrate    # apply migrations
just check      # typecheck, lint, test -- exactly what CI runs
```

`just --list` shows everything else.

- Conventions every work package builds on: [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md)
- Start here: [`docs/plan/00-master-implementation-plan.md`](docs/plan/00-master-implementation-plan.md)
- Panel research memos: [`docs/research/`](docs/research/README.md)
- Decisions and disagreements: [`docs/plan/reconciliation-notes.md`](docs/plan/reconciliation-notes.md)
