# PersonalFi

A self-hosted, MIT-licensed, single-user personal finance and advisory application. It tracks
spending, budgets, recurring charges and subscriptions, net worth, an investment portfolio and a
retirement plan, across bank, brokerage and crypto accounts. Everything runs in Docker on a machine
you own.

## Images

Three images make up the application, and a fourth, the Yahoo Finance sidecar, is an opt-in
extra (compose profile `yahoo`; never started by default). Each is published for `linux/amd64` and `linux/arm64`
(arm64 is built, not yet exercised).

| Image                                      | GitHub Container Registry (canonical) | Docker Hub (mirror)           |
| ------------------------------------------ | ------------------------------------- | ----------------------------- |
| API and worker                             | `ghcr.io/huh12312/personalfi-api`     | `masterhuh/personalfi-api`    |
| Backup                                     | `ghcr.io/huh12312/personalfi-backup`  | `masterhuh/personalfi-backup` |
| Proxy (Caddy, TLS)                         | `ghcr.io/huh12312/personalfi-proxy`   | `masterhuh/personalfi-proxy`  |
| Yahoo Finance sidecar (opt-in, unofficial) | `ghcr.io/huh12312/personalfi-yahoo`   | `masterhuh/personalfi-yahoo`  |

Docker Hub limits anonymous pulls per IP address. If you
see `429 Too Many Requests`, run `docker login` or pull from GitHub Container Registry.

## Verify before you run

Every image is signed with cosign using GitHub's OIDC identity. Check the signature:

```bash
cosign verify ghcr.io/huh12312/personalfi-api:0.10.0 --certificate-identity-regexp '^https://github.com/huh12312/PersonalFi/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

For a copy from this page, replace `ghcr.io/huh12312` with `docker.io/masterhuh`.
The identity is the same. The release workflow also records SLSA provenance, checked with
`gh attestation verify`. See [SECURITY.md](https://github.com/huh12312/PersonalFi/blob/main/SECURITY.md).

## Pin a version

Use a version tag such as `0.10.0`. `latest` is published for convenience and is not for upgrades:
the upgrade path refuses it because it does not name one commit. Only the newest published release
is supported.

## Install

The install guide is in the repository README:
<https://github.com/huh12312/PersonalFi#install>. It runs these images under the names above:
`just install-release 0.10.0` verifies every signature, pulls by digest and starts the stack, with
nothing built. Set `REGISTRY=masterhuh` in `.env` to install from this page's copies. The
operating guide, covering upgrade, backup and restore, is the
[RUNBOOK](https://github.com/huh12312/PersonalFi/blob/main/RUNBOOK.md).

## Licence

MIT. See <https://github.com/huh12312/PersonalFi/blob/main/LICENSE>.
