#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Compose-hardening gate (master plan P0-6, 03 §5.2). Run by CI's
# `compose-hardening` job, by `just hardening-check`, by `just verify`, and by
# the lefthook pre-commit hook.
#
# WHY THIS IS NOT A GREP ANY MORE
# ------------------------------
# It used to be four regexes over the raw YAML, and the Phase 0 security gate
# (H-1) demonstrated end to end that a service declaring `network_mode: host`,
# `pid: host`, `ipc: host`, `privileged: "true"`, `seccomp:unconfined`,
# `cap_add: [SYS_ADMIN]`, a mounted `/run/docker.sock`, `/:/host:rw` and
# `ports: ['0.0.0.0:443:8443']` — all of it at once — passed with EXIT=0. The
# regexes matched only *some spellings* of some of the prohibitions
# (`.host.` required a quote character on each side; `privileged` anchored on
# bare `true`; the socket pattern hardcoded `/var/run/docker.sock`), and they
# could not express the positive half of P0-7 at all ("every service *must*
# have read_only / cap_drop ALL / no-new-privileges / a non-root user").
#
# So the gate now asserts against `docker compose config --format json`: the
# fully-interpolated, alias-expanded, schema-normalised model compose itself
# will run. `privileged: "true"`, `privileged: true` and a YAML anchor that
# injects it three services away are all the same value by the time we see it,
# which is the only representation worth writing assertions against.
#
# The one thing a parser loses versus a grep is a *commented-out* hazard. That
# is a deliberate trade: a commented-out `privileged: true` cannot start a
# container, and pretending otherwise is what made the old gate feel thorough
# while passing the fixture in scripts/fixtures/compose-hostile.yml.
#
# `--self-test` runs that hostile fixture through the same evaluator and
# asserts every rule fires. A check that has never been observed failing is
# not a check; `just hardening-check` runs both halves.
#
#   bash scripts/compose-hardening-check.sh              # real compose files
#   bash scripts/compose-hardening-check.sh --self-test  # the gate checks itself
#   bash scripts/compose-hardening-check.sh --json path/to/compose.yml
#
# Needs `docker compose` (v2+, for `config --format json`) and node. No jq: the
# repo already requires node and does not require jq.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="scripts/fixtures/compose-hostile.yml"

# Fail closed, with a sentence that says what to install. This runs in the
# lefthook pre-commit hook too, so "docker is not on this machine" has to be a
# clear error rather than a confusing one — and never a silent skip, which is
# how a gate quietly stops being a gate.
if ! command -v docker >/dev/null 2>&1; then
  echo "compose-hardening-check: FAIL: \`docker\` is not on PATH." >&2
  echo "  This gate asserts against \`docker compose config --format json\` (P0-6/P0-7);" >&2
  echo "  it cannot be evaluated without it, and it will not pass by default." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "compose-hardening-check: FAIL: the Docker Compose v2 plugin is required (\`docker compose version\`)." >&2
  exit 1
fi

# Every rule id the hostile fixture must trigger. If a rule is deleted,
# renamed, or weakened, --self-test fails here rather than silently passing a
# hostile file in production.
EXPECTED_RULES=(
  privileged
  host-network
  host-pid
  host-ipc
  host-cgroup
  host-userns
  cap-add
  security-opt-unconfined
  devices
  container-runtime-socket
  sensitive-host-path-bind-mount
  writable-bind-mount
  writable-named-volume
  writable-volume-wrong-service
  port-bind-address
  missing-read-only
  missing-cap-drop-all
  missing-no-new-privileges
  root-user
)

EVALUATOR="$(mktemp -t compose-hardening-XXXXXX.mjs)"
trap 'rm -f "$EVALUATOR"' EXIT

cat >"$EVALUATOR" <<'NODE'
// Evaluates one `docker compose config --format json` document against the
// P0-6/P0-7 rule set. Reads the JSON on stdin; argv[2] is the file label.
// Prints one line per violation ("RULE_ID<TAB>service<TAB>detail") on stdout
// and a human summary on stderr. Exit 0 = clean, 1 = violations.

const label = process.argv[2] ?? '(stdin)';

// Documented, auditable exceptions. Anything not listed here is enforced on
// every service in every compose file. Keyed "<basename>:<service>:<rule>".
const EXCEPTIONS = new Map([
  [
    'compose.yml:db:missing-read-only',
    'postgres writes its own data directory; the write surface is scoped to the ' +
      'pgdata named volume plus two tmpfs mounts, and the service still runs as ' +
      'uid 70 with cap_drop ALL and no-new-privileges (03 §5.2).',
  ],
  [
    'compose.dev.yml:db:missing-read-only',
    'same reason as the production db: postgres cannot run on a read-only rootfs. ' +
      'The dev database is loopback-only, holds synthetic data, and carries the ' +
      'other three controls.',
  ],
]);

// Named volumes that are allowed to be writable, keyed "<volume>:<service>" so
// only the documented *owning* service may mount one writable (gate-
// remediation-2.md finding 6) — a second service mounting `pgdata` writable
// is a finding even though `pgdata` itself is a legitimate writable volume,
// because nothing about "this name is on the allow-list" implies "and any
// service may write it."
const WRITABLE_NAMED_VOLUMES = new Map([
  ['pgdata:db', 'postgres data directory'],
  ['backups:backup', 'encrypted nightly dumps'],
  ['caddy_data:proxy', "Caddy's internal-CA key material and issued certificates"],
  ['caddy_config:proxy', "Caddy's autosaved config snapshot"],
]);

function writableVolumeOwners(volumeName) {
  return [...WRITABLE_NAMED_VOLUMES.keys()]
    .filter((key) => key.split(':')[0] === volumeName)
    .map((key) => key.split(':')[1]);
}

const WRITABLE_VOLUME_NAMES = [
  ...new Set([...WRITABLE_NAMED_VOLUMES.keys()].map((key) => key.split(':')[0])),
];

const SOCKET_RE = /(docker\.sock|podman\.sock|containerd\.sock|crio\.sock)$/;

// gate-remediation-2.md finding 6: a *read-only* bind of a socket, device
// node, or procfs/sysfs entry under one of these host paths still lets the
// container connect to it, open the device, or read host process/kernel
// state through it — `:ro` only blocks writes through the filesystem
// interface, not what the file itself lets you do once opened. So these are
// flagged regardless of the mount's read_only flag, unlike ordinary bind
// mounts (`writable-bind-mount`, below).
const SENSITIVE_BIND_PREFIXES = ['/run', '/var/run', '/proc', '/sys', '/dev'];

function isSensitiveHostPath(source) {
  return SENSITIVE_BIND_PREFIXES.some((prefix) => source === prefix || source.startsWith(`${prefix}/`));
}
const HOST_NAMESPACE_KEYS = [
  ['network_mode', 'host-network'],
  ['pid', 'host-pid'],
  ['ipc', 'host-ipc'],
  ['cgroup', 'host-cgroup'],
  ['userns_mode', 'host-userns'],
];

function truthy(value) {
  if (value === true) return true;
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  if (typeof value === 'number') return value !== 0;
  return false;
}

function isHost(value) {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('host');
}

function isRootUser(user) {
  const id = String(user).split(':')[0].trim();
  return id === '' || id === '0' || id === 'root';
}

async function readStdin() {
  let out = '';
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

const doc = JSON.parse(await readStdin());
const services = doc.services ?? {};
const basename = label.split('/').pop();
const violations = [];
const waived = [];

function report(service, rule, detail) {
  const waiver = EXCEPTIONS.get(`${basename}:${service}:${rule}`);
  if (waiver !== undefined) {
    waived.push(`${service}: ${rule}: ${waiver}`);
    return;
  }
  violations.push({ service, rule, detail });
}

for (const [service, spec] of Object.entries(services)) {
  // ---------- prohibitions ----------
  if (truthy(spec.privileged)) {
    report(service, 'privileged', `privileged: ${JSON.stringify(spec.privileged)}`);
  }

  for (const [key, rule] of HOST_NAMESPACE_KEYS) {
    if (isHost(spec[key])) report(service, rule, `${key}: ${spec[key]}`);
  }

  for (const cap of spec.cap_add ?? []) {
    report(service, 'cap-add', `cap_add: ${cap}`);
  }

  for (const opt of spec.security_opt ?? []) {
    if (String(opt).toLowerCase().includes('unconfined')) {
      report(service, 'security-opt-unconfined', `security_opt: ${opt}`);
    }
  }

  for (const device of spec.devices ?? []) {
    const shown = typeof device === 'string' ? device : `${device.source}:${device.target}`;
    report(service, 'devices', `devices: ${shown}`);
  }

  for (const mount of spec.volumes ?? []) {
    // `docker compose config` normalises every short-form string into an
    // object, so there is exactly one shape to reason about here.
    const source = mount.source ?? '';
    const readOnly = mount.read_only === true;

    if (mount.type === 'bind') {
      if (SOCKET_RE.test(source)) {
        report(
          service,
          'container-runtime-socket',
          `bind-mounts a container-runtime socket: ${source} -> ${mount.target}`,
        );
        continue; // a socket mount is never "fixed" by adding :ro
      }
      if (isSensitiveHostPath(source)) {
        report(
          service,
          'sensitive-host-path-bind-mount',
          `bind mount source is under a sensitive host path: ${source} -> ${mount.target} ` +
            `(read_only=${String(readOnly)}; a read-only bind under /run, /var/run, /proc, /sys or ` +
            `/dev still allows connecting to a socket or operating on a device/procfs entry through it)`,
        );
        continue; // :ro does not fix this class either — same reasoning as the socket check above
      }
      if (!readOnly) {
        report(
          service,
          'writable-bind-mount',
          `bind mount is writable: ${source} -> ${mount.target} (add :ro)`,
        );
      }
    } else if (mount.type === 'volume') {
      if (!readOnly) {
        const owners = writableVolumeOwners(source);
        if (owners.length === 0) {
          report(
            service,
            'writable-named-volume',
            `writable named volume "${source}" -> ${mount.target} is not in the documented set ` +
              `(${WRITABLE_VOLUME_NAMES.join(', ')})`,
          );
        } else if (!owners.includes(service)) {
          report(
            service,
            'writable-volume-wrong-service',
            `writable named volume "${source}" -> ${mount.target} is documented as owned by ` +
              `${owners.join(', ')}, not "${service}" — a second writer defeats the point of scoping ` +
              `the write surface to one service`,
          );
        }
      }
    }
  }

  for (const port of spec.ports ?? []) {
    const hostIp = (port.host_ip ?? '').trim();
    const published = port.published ?? '';
    if (hostIp === '' || hostIp === '0.0.0.0' || hostIp === '::' || hostIp === '*') {
      report(
        service,
        'port-bind-address',
        `published port ${published || port.target} has no explicit bind address ` +
          `(host_ip=${hostIp === '' ? '<unset>' : hostIp}); use "\${BIND_ADDRESS}:HOST:CONTAINER"`,
      );
    }
  }

  // ---------- required controls (P0-7) ----------
  if (spec.read_only !== true) {
    report(service, 'missing-read-only', 'read_only is not true');
  }

  const capDrop = (spec.cap_drop ?? []).map((c) => String(c).toUpperCase());
  if (!capDrop.includes('ALL')) {
    report(service, 'missing-cap-drop-all', `cap_drop does not include ALL (${JSON.stringify(spec.cap_drop ?? [])})`);
  }

  const securityOpt = (spec.security_opt ?? []).map((o) => String(o).toLowerCase());
  if (!securityOpt.some((o) => o.replace(/\s/g, '') === 'no-new-privileges:true')) {
    report(
      service,
      'missing-no-new-privileges',
      "security_opt does not include 'no-new-privileges:true'",
    );
  }

  if (spec.user === undefined || spec.user === null || isRootUser(spec.user)) {
    report(service, 'root-user', `user is ${spec.user === undefined ? 'unset (root)' : JSON.stringify(spec.user)}`);
  }
}

for (const v of violations) {
  process.stdout.write(`${v.rule}\t${v.service}\t${v.detail}\n`);
  process.stderr.write(`    FAIL ${label}: ${v.service}: ${v.rule}: ${v.detail}\n`);
}
for (const w of waived) {
  process.stderr.write(`    waived ${label}: ${w}\n`);
}
process.stderr.write(
  `  ${label}: ${Object.keys(services).length} service(s), ${violations.length} violation(s), ${waived.length} documented exception(s)\n`,
);
process.exit(violations.length > 0 ? 1 : 0);
NODE

# Renders one compose file's fully-resolved model. `--profile '*'` enables
# every profile so the sidecar/local-llm/webhooks placeholders are held to the
# same bar as the default services — the old grep saw them because it read raw
# text, and a profile-gated hazard is still a hazard.
compose_config() {
  local file="$1"
  docker compose -f "$file" --profile '*' config --format json
}

# Files with nothing but comments under `services:` (compose.override.example.yml
# is the only one today) cannot be parsed by compose at all — it rejects a null
# `services` mapping. Treat that single, verifiable shape as "template with no
# active services" and anything else as a hard failure: the moment such a file
# gains one real service it parses, and every rule above applies to it.
is_empty_template() {
  local file="$1"
  local content
  content="$(sed 's/#.*//' "$file" | sed 's/[[:space:]]*$//' | grep -v '^$' || true)"
  [ "$content" = "services:" ]
}

check_file() {
  local file="$1"
  local json rc=0
  if ! json="$(compose_config "$file" 2>/tmp/compose-hardening-config-err.$$)"; then
    if is_empty_template "$file"; then
      echo "  $file: template with no active services (nothing to check)" >&2
      rm -f "/tmp/compose-hardening-config-err.$$"
      return 0
    fi
    echo "compose-hardening-check: FAIL: $file: 'docker compose config' rejected this file:" >&2
    sed 's/^/    /' "/tmp/compose-hardening-config-err.$$" >&2
    rm -f "/tmp/compose-hardening-config-err.$$"
    return 1
  fi
  rm -f "/tmp/compose-hardening-config-err.$$"
  # stdout is the machine-readable "RULE<TAB>service<TAB>detail" stream that
  # --self-test parses; the human-readable form already went to stderr.
  printf '%s' "$json" | node "$EVALUATOR" "$file" >/dev/null || rc=$?
  return "$rc"
}

self_test() {
  echo "compose-hardening-check: --self-test: running $FIXTURE through the gate" >&2
  local json fired rc=0 missing=()
  json="$(compose_config "$FIXTURE")"
  fired="$(printf '%s' "$json" | node "$EVALUATOR" "$FIXTURE" 2>/dev/null | cut -f1 | sort -u || true)"
  if [ -z "$fired" ]; then
    echo "compose-hardening-check: SELF-TEST FAILED: the hostile fixture produced no violations" >&2
    return 1
  fi
  for rule in "${EXPECTED_RULES[@]}"; do
    grep -qx "$rule" <<<"$fired" || missing+=("$rule")
  done
  if [ "${#missing[@]}" -ne 0 ]; then
    echo "compose-hardening-check: SELF-TEST FAILED: the hostile fixture did not trigger: ${missing[*]}" >&2
    rc=1
  fi
  echo "  fixture triggered $(wc -l <<<"$fired") distinct rule(s): $(tr '\n' ' ' <<<"$fired")" >&2
  if [ "$rc" -eq 0 ]; then
    echo "compose-hardening-check: SELF-TEST PASS (all ${#EXPECTED_RULES[@]} rules fire on a hostile file)" >&2
  fi
  return "$rc"
}

MODE="check"
FILES=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --self-test) MODE="self-test" ;;
    --json) MODE="check" ;;
    -*) echo "compose-hardening-check: unknown flag $1" >&2; exit 2 ;;
    *) FILES+=("$1") ;;
  esac
  shift
done

if [ "$MODE" = "self-test" ]; then
  self_test
  exit $?
fi

if [ "${#FILES[@]}" -eq 0 ]; then
  # Every compose file in the repo, not just compose.yml — compose.dev.yml and
  # compose.override.example.yml are held to the same bar. A plain `find`
  # rather than `git ls-files`: this must also catch a compose file that has
  # not been `git add`ed yet. scripts/fixtures is pruned because the hostile
  # fixture is *supposed* to fail (see --self-test).
  #
  # The `(docker-)?` prefix is load-bearing: `docker-compose.yml` and
  # `docker-compose.yaml` are still in Compose v2's default filename search
  # order, so a file by that name is one `docker compose up` away from running.
  # Without the prefix the sweep never visited it and the gate reported PASS
  # over a repo containing a hostile, deployable compose file.
  mapfile -t FILES < <(
    find . -regextype posix-extended \
      \( -path './node_modules' -o -path './.git' -o -path './.claude' \
         -o -path './scripts/fixtures' -o -name 'dist' -o -name 'coverage' \) -prune -o \
      \( -iregex '.*/(docker-)?compose[.-][^/]*\.ya?ml' \
         -o -iregex '.*/(docker-)?compose\.ya?ml' \) -print \
      | sed 's#^\./##' | sort -u
  )
fi

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "compose-hardening-check: no compose files found — nothing to check" >&2
  exit 1
fi

FAIL=0
for file in "${FILES[@]}"; do
  check_file "$file" || FAIL=1
done

if [ "$FAIL" -ne 0 ]; then
  echo "compose-hardening-check: FAIL — one or more compose files violate the P0-6/P0-7 baseline" >&2
  exit 1
fi

echo "compose-hardening-check: PASS (${#FILES[@]} file(s) checked: ${FILES[*]})"
