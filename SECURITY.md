<!-- SPDX-License-Identifier: MIT -->

# Security policy

PersonalFi holds one person's financial data on a machine that person owns. A flaw in it matters
more than in most projects, so reports are welcome and are read.

## Reporting a vulnerability

Report it privately through GitHub. Do not open a public issue, a discussion or a pull request for
a vulnerability.

1. Open the repository: <https://github.com/huh12312/PersonalFi>.
2. Choose the **Security** tab (the row of tabs under the repository name).
3. Under **Advisories**, choose **Report a vulnerability**.
4. Describe what you found, how to reproduce it, and which version or commit you tested.

Only the maintainer can read the report. There is no email address for security reports. If the
button is missing, private vulnerability reporting is not switched on for the repository yet; open
an ordinary issue that says only "I have a security report and cannot find the private channel",
with no details, and the maintainer will respond with another way to send it.

Please include the output of `GET /ready` from the install you tested (see the bug report form for
the command). It carries no secrets. Remove any merchant names, amounts or account details from
logs before you attach them.

## What to expect

PersonalFi has one maintainer. These are commitments that one person can keep:

- **Acknowledgement within 7 days** of the report.
- **A first assessment** (accepted, not reproducible, or out of scope, with the reason) after that.
- **No fixed time to a fix.** A fix is a normal release: it is tested, signed and published like
  any other, and its release note says what changed and whether a manual step is needed. A serious
  flaw is fixed ahead of other work.
- **Credit** in the release note if you want it, and none if you do not.

Please allow a fix to ship before you publish details.

## Supported versions

Only the newest published release is supported, starting from v0.10.0. Earlier versions, and the
tip of `main` between releases, do not receive security fixes. `just upgrade` takes an install from
any earlier release to the current one; the README's
[Upgrade](README.md#upgrade) section and the RUNBOOK's [Upgrade](RUNBOOK.md#upgrade) section say how.

## What is in scope

- The application: the API, the worker, the web client and the migrations.
- The published images: `personalfi-api`, `personalfi-backup` and `personalfi-proxy`.
- The compose stack: `compose.yml`, its hardening, its secrets and its networks.
- The release pipeline: `.github/workflows/release.yml`, the signing and the provenance.

## What is out of scope

- Third-party services a holder chooses to connect: the bank aggregator, price feeds, a hosted
  language-model provider, a notification host. Report those to the vendor.
- The holder's own host: its operating system, its Docker daemon, its disk encryption, its network,
  and anyone with root or `docker` group access to it. The
  [threat model](docs/security/threat-model.md) says what is assumed about the host.
- Findings that need a configuration the documentation tells a holder not to use, such as binding
  the proxy to `0.0.0.0`.
- Denial of service by a user who is already signed in, against their own single-user install.
- Reports from automated scanners with no demonstrated effect on a PersonalFi install.

The threat model also lists what PersonalFi does not defend against. A report that restates one of
those is useful as a data point but is already known.

## Verify a release before you run it

Every published image is signed with cosign using GitHub's OIDC identity (keyless), and the build
records a SLSA provenance attestation. Check both before you run an image. The tag has no leading
`v`; this example uses `0.10.0`.

```bash
cosign verify ghcr.io/huh12312/personalfi-api:0.10.0 \
  --certificate-identity-regexp '^https://github.com/huh12312/PersonalFi/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Repeat it for `personalfi-backup` and `personalfi-proxy`. A copy on Docker Hub is signed separately
with the same identity; replace `ghcr.io/huh12312` with `docker.io/masterhuh`, for example `docker.io/masterhuh/personalfi-api:0.10.0`.

The second check is optional and needs the GitHub CLI, logged in:

```bash
gh attestation verify oci://ghcr.io/huh12312/personalfi-api:0.10.0 --repo huh12312/PersonalFi
```

`scripts/verify-release.sh` runs both checks for all three images, resolves the tag to a digest
once, and pulls by digest only if everything passes. The RUNBOOK's [Upgrade](RUNBOOK.md#upgrade)
section shows how to use it.

**The signing identity.** A valid signature names the workflow
`https://github.com/huh12312/PersonalFi/.github/workflows/release.yml` at a `refs/tags/v<x.y.z>`
tag, issued by `https://token.actions.githubusercontent.com`. There is no long-lived signing key to
steal or rotate; the certificate lives for minutes and the signature is recorded in the Rekor
transparency log. A signature from any other workflow, repository or ref means the image did not
come from this project's release pipeline. Do not run it, and tell the maintainer.

`latest` is published for convenience and is not a release you can verify to one commit. Pin a
version.

## Controls a reporter should know exist

One line each, with where to read more.

- **Secrets are files, never environment variables.** `./secrets/<name>`, mounted at
  `/run/secrets/<name>`: [Create secrets](RUNBOOK.md#2-create-secrets).
- **The kill ladder.** Four independent levels stop an advisor, checked before a run, once a second
  during it and at the write barrier: [Advisor kill switches](RUNBOOK.md#advisor-kill-switches).
- **The egress allow-list.** Each hosted language-model adapter may reach one host, over https on
  port 443, with DNS classified before the connect and redirects refused:
  [Choosing the narrator](RUNBOOK.md#choosing-the-narrator).
- **The numerals check.** The model writes slots and no digits; any number it did not receive is
  refused before the holder sees the text: [Proving the GenAI controls](RUNBOOK.md#proving-the-genai-controls).
- **Encrypted backups, restore drill.** Backups are age-encrypted to a public key and the container
  never holds the private half: [Backup](RUNBOOK.md#backup) and [Restore](RUNBOOK.md#restore).
