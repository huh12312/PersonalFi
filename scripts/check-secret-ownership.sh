#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Secret-ownership gate (gate-security-review.md §8.2 N-1, §8.11 D-4).
#
# WHY THIS EXISTS
# ----------------
# `just harden-secrets` chowns/chmods the host files under `${SECRETS_DIR}` to
# the uid of whichever service actually reads them — a **hand-written** list
# of (secret, uid, mode) triples. When C-3 added `plaid_client_id`,
# `plaid_secret` and `plaid_env` as file secrets mounted on `api` and `worker`,
# that list was never updated, so an operator who ran `just harden-secrets`
# per the RUNBOOK got three files owned 0400 by nobody `api`/`worker` could
# read, and both containers crash-looped on `EACCES` the moment Plaid was
# turned on (N-1). That is the same mechanism, a third time, as F-1's image
# prune (a hand-maintained delete set) and F-4's Caddyfile (hand-maintained
# proxy prefixes): a computed set has a hand-maintained twin, and the twin
# rots the next time the computed side grows.
#
# This script is the computed twin's replacement. It does not hand-maintain a
# second list of which uid should own which file — it reads `compose.yml`'s
# own `secrets:` block and each service's own `user:`/`secrets:` declarations
# (via `docker compose config --format json`, the same normalized model
# compose-hardening-check.sh asserts against) and derives, for every secret,
# who is *supposed* to be able to read it. It then stats the real file on disk
# and asserts that derivation holds.
#
#   * One consuming uid  -> file must be owned by that uid, mode 0400.
#   * Two consuming uids  -> file must be owner:group = the two uids (either
#     order), mode 0440 (compose.yml's own comment: pg_password is read by
#     postgres AND backup, so it is the one secret that genuinely needs a
#     group rather than a second owner).
#   * Three or more consuming uids -> FAIL loudly. Unix's owner/group/other
#     triple cannot express "readable by exactly these three uids and no
#     other", so a secret that grows a third distinct consumer needs this
#     script extended (or the secret split), not silently ignored.
#   * A secret's host file does not exist yet -> skipped, not failed. A fresh
#     checkout (including CI, which has no real ./secrets at all) has not run
#     `just gen-*`/`just harden-secrets` yet, and "you have not created this
#     secret yet" is not the same finding as "you created it with the wrong
#     owner."
#
#   bash scripts/check-secret-ownership.sh              # the real compose.yml + ./secrets
#   bash scripts/check-secret-ownership.sh --self-test  # synthetic fixture, needs no root
#
# Needs `docker compose` (v2+, for `config --format json`) and node — same
# requirements as compose-hardening-check.sh, which this is deliberately
# styled after.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "check-secret-ownership: FAIL: \`docker\` is not on PATH." >&2
  echo "  This gate asserts against \`docker compose config --format json\`;" >&2
  echo "  it cannot be evaluated without it, and it will not pass by default." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "check-secret-ownership: FAIL: the Docker Compose v2 plugin is required (\`docker compose version\`)." >&2
  exit 1
fi

EVALUATOR="$(mktemp -t check-secret-ownership-XXXXXX.mjs)"
trap 'rm -f "$EVALUATOR"' EXIT

cat >"$EVALUATOR" <<'NODE'
// Reads one `docker compose config --format json` document on stdin and
// asserts every declared file secret's on-disk owner/mode matches what its
// consuming service(s)' `user:` field(s) require. Prints one line per problem
// on stdout ("SECRET<TAB>detail") for --self-test to grep, and a human
// summary on stderr. Exit 0 = clean, 1 = at least one real violation.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();

function readStdin() {
  return new Promise((res, rej) => {
    let out = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (out += chunk));
    process.stdin.on('end', () => res(out));
    process.stdin.on('error', rej);
  });
}

function consumingUid(user) {
  const id = String(user ?? '').split(':')[0]?.trim();
  if (id === undefined || id === '') return null;
  const n = Number(id);
  return Number.isInteger(n) ? n : null;
}

const doc = JSON.parse(await readStdin());
const services = doc.services ?? {};
const secrets = doc.secrets ?? {};

// secretName -> Set<uid>, built from every service that mounts it.
const consumersByName = new Map();
for (const [serviceName, spec] of Object.entries(services)) {
  const uid = consumingUid(spec.user);
  for (const mount of spec.secrets ?? []) {
    const name = mount.source ?? mount;
    if (typeof name !== 'string') continue;
    if (uid === null) {
      process.stderr.write(
        `  WARN: service "${serviceName}" mounts secret "${name}" but has no numeric uid in ` +
          `its \`user:\` field (${JSON.stringify(spec.user)}) — cannot derive an expected owner from it\n`,
      );
      continue;
    }
    const set = consumersByName.get(name) ?? new Set();
    set.add(uid);
    consumersByName.set(name, set);
  }
}

// RUNBOOK.md documents two legitimate states for a secret file: 0444 owned by
// the operator (`just gen-*`'s own output — "the working default", readable
// by every consuming container because 0444 is world-readable) and 0400 (or
// 0440 with a group) owned by the consuming uid, via `just harden-secrets`
// (needs root once, so it is a deliberate, optional operator action, not
// something this repo requires of every checkout or every CI run — CI has no
// real `./secrets` at all). This script's job is not to force the second
// state on everyone; it is to make sure that *when hardening is attempted*,
// every secret actually gets it — which is exactly the shape of bug that
// shipped (N-1): `just harden-secrets` chowned five files and silently missed
// three, and nothing said so until `docker compose up` crash-looped on EACCES.
//
// So: first look at what actually exists on disk, and ask whether hardening
// has been *started* at all (any existing secret file no longer owned by
// whoever is running this check). If nothing has been hardened yet, there is
// nothing to assert — every file is presumed to still be in the documented
// default state, and that state is not a finding. The moment one file has
// moved, every other declared, present secret is held to the strict bar:
// owned by (only) its consumer(s), at the stricter mode. A secret left behind
// at 0444-owned-by-you while its siblings moved is exactly N-1's shape, and
// now fails loudly instead of crash-looping the next `docker compose up`.
//
// CSO_FORCE_STRICT=1 (set only by this script's own --self-test) skips that
// "has anything moved yet" inference, because the self-test fixture's files
// are unavoidably owned by whichever uid is running the test (chown to any
// *other* real uid needs root, which --self-test deliberately does not
// require) — the inference above would otherwise read "nothing hardened yet"
// for a fixture that is deliberately, entirely already in its hardened state.
const forceStrict = process.env.CSO_FORCE_STRICT === '1';

const entries = [];
for (const [name, def] of Object.entries(secrets)) {
  const file = def?.file;
  if (typeof file !== 'string' || file === '') continue; // not a file secret (e.g. external:) — nothing to stat
  const path = isAbsolute(file) ? file : resolve(REPO_ROOT, file);
  if (!existsSync(path)) {
    process.stderr.write(`  skip ${name}: ${path} does not exist yet (run 'just gen-*' first)\n`);
    continue;
  }
  const uids = [...(consumersByName.get(name) ?? [])].sort((a, b) => a - b);
  if (uids.length === 0) {
    process.stderr.write(`  skip ${name}: declared but not mounted by any service\n`);
    continue;
  }
  entries.push({ name, path, uids, stat: statSync(path) });
}

const myUid = process.getuid?.() ?? null;
const anyHardened = forceStrict || (myUid !== null && entries.some((e) => e.stat.uid !== myUid));

if (!anyHardened) {
  process.stderr.write(
    `  no secret appears to have been hardened yet (every present file is still owned by uid ${myUid}) — ` +
      `nothing to check. Run 'just harden-secrets' to move to the stricter, per-service-uid-owned state; ` +
      `this gate holds you to it once you start.\n`,
  );
  process.exit(0);
}

let violations = 0;
let checked = 0;

for (const { name, path, uids, stat } of entries) {
  const mode = stat.mode & 0o777;
  checked += 1;

  if (uids.length === 1) {
    const [uid] = uids;
    if (stat.uid === uid && mode === 0o400) continue;
    violations += 1;
    const detail =
      `expected owner ${uid}, mode 0400 (one consumer: uid ${uid}); got owner ${stat.uid}, ` +
      `group ${stat.gid}, mode 0${mode.toString(8)}`;
    process.stdout.write(`${name}\t${detail}\n`);
    process.stderr.write(`  FAIL ${name} (${path}): ${detail}\n`);
    continue;
  }

  if (uids.length === 2) {
    const [a, b] = uids;
    const ok = mode === 0o440 && ((stat.uid === a && stat.gid === b) || (stat.uid === b && stat.gid === a));
    if (ok) continue;
    violations += 1;
    const detail =
      `expected owner/group {${a}, ${b}} in either order, mode 0440 (two consumers: uids ${a} and ${b}); ` +
      `got owner ${stat.uid}, group ${stat.gid}, mode 0${mode.toString(8)}`;
    process.stdout.write(`${name}\t${detail}\n`);
    process.stderr.write(`  FAIL ${name} (${path}): ${detail}\n`);
    continue;
  }

  // 3+ distinct consuming uids: unix owner/group/other cannot express this.
  violations += 1;
  const detail =
    `${uids.length} distinct consuming uids (${uids.join(', ')}) — a single owner+group cannot express ` +
    `"readable by exactly these uids"; extend this script (or split the secret) before adding a third consumer`;
  process.stdout.write(`${name}\t${detail}\n`);
  process.stderr.write(`  FAIL ${name} (${path}): ${detail}\n`);
}

process.stderr.write(`  hardening in progress: ${checked} secret(s) held to the strict bar, ${violations} violation(s)\n`);
process.exit(violations > 0 ? 1 : 0);
NODE

export REPO_ROOT

check_real() {
  local json
  json="$(docker compose -f compose.yml --profile '*' config --format json)"
  printf '%s' "$json" | node "$EVALUATOR"
}

self_test() {
  echo "check-secret-ownership: --self-test: synthetic fixture, no root required" >&2
  local scratch
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' RETURN

  local uid gid
  uid="$(id -u)"
  gid="$(id -g)"
  # A second, distinct "uid" for the two-consumer fixture below, picked from
  # this process's own *supplementary* groups rather than its primary one —
  # on a single-user box the primary group id often equals the uid itself
  # (measured: both 1000 here), which would silently collapse the two-
  # consumer case back into the one-consumer case. The check only ever reads
  # the numeric value out of a service's `user:` field, so this does not need
  # to correspond to a real *account* — it only needs a number this process
  # can produce a matching file *group* for without root, which any group it
  # already belongs to satisfies (`chgrp` to a group you're a member of needs
  # no privilege).
  local fake_second_uid
  fake_second_uid="$(id -G | tr ' ' '\n' | grep -vx "$uid" | grep -vx "$gid" | head -n1)"
  if [[ -z "$fake_second_uid" ]]; then
    echo "check-secret-ownership: SELF-TEST SKIPPED: this user belongs to no group other than" >&2
    echo "  its own uid/primary gid ($uid/$gid), so the two-consumer branch cannot be exercised" >&2
    echo "  without root. Add this user to a second group (e.g. its own docker group) to run it." >&2
    return 1
  fi

  mkdir -p "$scratch/secrets"
  local alpine='alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b'
  cat >"$scratch/compose.yml" <<YAML
services:
  solo:
    image: ${alpine}
    user: '${uid}:${gid}'
    command: ['true']
    secrets: [solo_secret]
  shared_a:
    image: ${alpine}
    user: '${uid}:${gid}'
    command: ['true']
    secrets: [shared_secret]
  shared_b:
    image: ${alpine}
    user: '${fake_second_uid}:${gid}'
    command: ['true']
    secrets: [shared_secret]
  orphan:
    image: ${alpine}
    user: '${uid}:${gid}'
    command: ['true']
    secrets: [missing_secret]
secrets:
  solo_secret:
    file: ${scratch}/secrets/solo_secret
  shared_secret:
    file: ${scratch}/secrets/shared_secret
  missing_secret:
    file: ${scratch}/secrets/missing_secret
YAML

  # solo_secret: single consumer (this process's own uid). Correct state:
  # owned by us, mode 0400.
  printf 'solo\n' >"$scratch/secrets/solo_secret"
  chmod 0400 "$scratch/secrets/solo_secret"

  # shared_secret: two declared consumers (uid, fake_second_uid). Correct
  # state: owner = uid (already true — we created it), group =
  # fake_second_uid (a real supplementary group of ours), mode 0440.
  printf 'shared\n' >"$scratch/secrets/shared_secret"
  chgrp "$fake_second_uid" "$scratch/secrets/shared_secret"
  chmod 0440 "$scratch/secrets/shared_secret"

  # missing_secret is deliberately never created, to prove "not present yet"
  # is skipped rather than failed (the state every CI checkout is in).

  local rc=0
  echo "  fixture: expecting PASS on correctly-owned files" >&2
  if ! (cd "$scratch" && docker compose -f compose.yml --profile '*' config --format json | REPO_ROOT="$scratch" CSO_FORCE_STRICT=1 node "$EVALUATOR" >/tmp/check-secret-ownership-selftest-pass.$$ 2>&1); then
    echo "check-secret-ownership: SELF-TEST FAILED: correctly-owned fixture reported a violation:" >&2
    cat /tmp/check-secret-ownership-selftest-pass.$$ >&2
    rc=1
  fi
  rm -f /tmp/check-secret-ownership-selftest-pass.$$

  echo "  fixture: sabotaging solo_secret's mode (0400 -> 0644) — expecting FAIL" >&2
  chmod 0644 "$scratch/secrets/solo_secret"
  local fired
  fired="$(cd "$scratch" && docker compose -f compose.yml --profile '*' config --format json | REPO_ROOT="$scratch" CSO_FORCE_STRICT=1 node "$EVALUATOR" 2>/dev/null | cut -f1 | sort -u || true)"
  if ! grep -qx 'solo_secret' <<<"$fired"; then
    echo "check-secret-ownership: SELF-TEST FAILED: a 0644 secret file did not fire a violation" >&2
    rc=1
  else
    echo "    caught: solo_secret mode sabotage fired" >&2
  fi
  chmod 0400 "$scratch/secrets/solo_secret" # restore before the shared-secret sabotage below

  echo "  fixture: sabotaging shared_secret's mode (0440 -> 0444) — expecting FAIL" >&2
  chmod 0444 "$scratch/secrets/shared_secret"
  fired="$(cd "$scratch" && docker compose -f compose.yml --profile '*' config --format json | REPO_ROOT="$scratch" CSO_FORCE_STRICT=1 node "$EVALUATOR" 2>/dev/null | cut -f1 | sort -u || true)"
  if ! grep -qx 'shared_secret' <<<"$fired"; then
    echo "check-secret-ownership: SELF-TEST FAILED: a 0444 shared secret file did not fire a violation" >&2
    rc=1
  else
    echo "    caught: shared_secret mode sabotage fired" >&2
  fi

  if [ "$rc" -eq 0 ]; then
    echo "check-secret-ownership: SELF-TEST PASS (correct state clean; both sabotages caught; missing file skipped not failed)" >&2
  fi
  return "$rc"
}

MODE="check"
case "${1:-}" in
  --self-test) MODE="self-test" ;;
  "") ;;
  *) echo "check-secret-ownership: unknown argument $1" >&2; exit 2 ;;
esac

if [ "$MODE" = "self-test" ]; then
  self_test
  exit $?
fi

if check_real; then
  echo "check-secret-ownership: PASS"
else
  echo "check-secret-ownership: FAIL — one or more secret files are not owned/moded for their consuming service (see above)" >&2
  exit 1
fi
