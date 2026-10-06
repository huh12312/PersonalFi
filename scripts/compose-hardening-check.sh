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
# Exported so the node evaluator below can tell "resolved from a relative
# bind mount inside this repo" apart from "an absolute host path outside it"
# — see the R-7 note on isSensitiveHostPath.
export REPO_ROOT

FIXTURE="scripts/fixtures/compose-hostile.yml"
# D-7: a minimal, otherwise-clean base and an override fragment that adds
# `privileged: true` to the one service the base defines — proves overrides
# are rendered *layered on their base*, not standalone (see check_layered).
OVERRIDE_BASE_FIXTURE="scripts/fixtures/compose-hostile-override-base.yml"
OVERRIDE_FIXTURE="scripts/fixtures/compose-hostile-override.yml"

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
  # WP 5.2: the local-model sandbox (`ollama`, `ollama-pull`, the `llm` network).
  ollama-network
  ollama-published-port
  ollama-secret
  ollama-image-unpinned
  ollama-debug-logging
  ollama-missing-limits
  ollama-missing-healthcheck
  ollama-missing-profile
  llm-network-not-internal
  llm-network-member
  ollama-pull-network-shared
  # WP 9.4 (CF-3): the pre-migration backup gate.
  migrator-missing-pre-migrate-backup
)

# WP 5.2: rule ids alone could all fire on one service and still leave a
# hazard unproved *where it matters*. These "service<TAB>rule" pairs must each
# fire on the named hostile service — in particular the brief's four: an
# `ollama` on `backend`, publishing a port, running as root, mounting a secret.
EXPECTED_SERVICE_RULES=(
  $'ollama\tollama-network'
  $'ollama\tollama-published-port'
  $'ollama\troot-user'
  $'ollama\tollama-secret'
  $'ollama\tollama-image-unpinned'
  $'ollama\tollama-debug-logging'
  $'ollama\tollama-missing-limits'
  $'ollama\tollama-missing-healthcheck'
  $'ollama\tollama-missing-profile'
  $'ollama\twritable-volume-wrong-service'
  $'hostile-api-on-llm\tllm-network-member'
  $'ollama-pull\tollama-pull-network-shared'
  $'ollama-pull\tollama-missing-profile'
  $'hostile-pull-peer\tollama-pull-network-shared'
  # WP 9.4 (CF-3): a `pre-migrate-backup` running as root, writable, or with
  # capabilities is refused; a migrator that merely waits for it to *start*
  # is refused.
  $'pre-migrate-backup\troot-user'
  $'pre-migrate-backup\tmissing-read-only'
  $'pre-migrate-backup\tcap-add'
  $'pre-migrate-backup\tmissing-cap-drop-all'
  $'pre-migrate-backup\tmissing-no-new-privileges'
  $'pre-migrate-backup\twritable-volume-wrong-service'
  $'migrator\tmigrator-missing-pre-migrate-backup'
)

EVALUATOR="$(mktemp -t compose-hardening-XXXXXX.mjs)"
trap 'rm -f "$EVALUATOR"' EXIT

cat >"$EVALUATOR" <<'NODE'
// Evaluates one `docker compose config --format json` document against the
// P0-6/P0-7 rule set. Reads the JSON on stdin; argv[2] is the display label
// (what gets printed); argv[3], if given, is the file whose EXCEPTIONS entries
// apply — see the D-7 note below. Prints one line per violation
// ("RULE_ID<TAB>service<TAB>detail") on stdout and a human summary on stderr.
// Exit 0 = clean, 1 = violations.

const label = process.argv[2] ?? '(stdin)';
// D-7 (gate-security-review.md §8.2 N-2): a layered render's label is
// "compose.yml+compose.override.yml" (see check_layered below) so the human
// output says what was actually evaluated — but `db`'s documented
// missing-read-only exception is a property of compose.yml, not of whatever
// happens to be layered on top of it, and must still apply. argv[3] lets the
// caller say "look up exceptions as if this were compose.yml" without
// changing what gets printed.
const exceptionLabel = process.argv[3] ?? label;

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
  [
    'backups:pre-migrate-backup',
    'WP 9.4 (CF-3): the one-shot pre-migration backup writes the same age-encrypted ' +
      'artifact into the same volume, before `migrator` may start; same image, same uid ' +
      '10002, and it holds the age recipient only, so it cannot read what it wrote.',
  ],
  ['caddy_data:proxy', "Caddy's internal-CA key material and issued certificates"],
  ['caddy_config:proxy', "Caddy's autosaved config snapshot"],
  [
    'returns_cache:worker',
    "WP 4.5's fetched-once, checksum-pinned return series (WP 4.12b, the Wave C " +
      'wiring handover §4.4); the api serves the interactive projection route from ' +
      'the same series and mounts this volume read-only (Phase 4 gate C-1) — a ' +
      'writable mount on any service but the worker is still a finding.',
  ],
  [
    'ollama_models:ollama-pull',
    "WP 5.2: the one-shot model pull writes the store; the `ollama` runtime mounts it " +
      'read-only, so a compromised runtime cannot alter the weights it serves next.',
  ],
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
// gate-security-review-3.md R-7: /run, /var/run, /proc, /sys and /dev cover
// sockets/procfs/devices, but a read-only bind of /etc, /root, /home, /boot
// or /var/lib/docker is just as much a host-escape primitive — /etc leaks
// every credential-bearing config and (on most distros) /etc/shadow's hash
// file, /root and /home leak SSH private keys and shell history, /boot
// exposes the kernel/initramfs an attacker would want to trojan, and
// /var/lib/docker is the daemon's own image/container/volume storage (a
// read-only view of it still discloses every layer of every image on the
// host, including secrets baked into other images' layers).
const SENSITIVE_BIND_PREFIXES = [
  '/run',
  '/var/run',
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/root',
  '/home',
  '/boot',
  '/var/lib/docker',
];

// `/home` (and, in principle, `/etc`) is also where this repo's own checkout
// lives on a real machine — a dev box has it at /home/<user>/..., and
// GitHub Actions runners check out under /home/runner/work/... — so a
// relative bind mount this repo declares on purpose, like compose.yml's
// `./docker/Caddyfile:/etc/caddy/Caddyfile:ro`, resolves (via `docker
// compose config`) to an absolute path *under* one of the new prefixes even
// though it is a reviewed, repo-owned file, not a host escape. Excluding
// anything `docker compose config` resolved to somewhere inside this
// checkout keeps that distinction: the fixture's sensitive-path violations
// below are all *literal* absolute paths (`/etc:/host-etc:ro` etc.), never
// resolved from something relative under REPO_ROOT, so they are unaffected.
const REPO_ROOT = process.env.REPO_ROOT ?? '';

function isSensitiveHostPath(source) {
  if (REPO_ROOT !== '' && (source === REPO_ROOT || source.startsWith(`${REPO_ROOT}/`))) {
    return false;
  }
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
const basename = exceptionLabel.split('/').pop();
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
            `(read_only=${String(readOnly)}; a read-only bind under ${SENSITIVE_BIND_PREFIXES.join(', ')} ` +
            `still allows connecting to a socket, operating on a device/procfs entry, or reading ` +
            `host credentials/keys/images through it)`,
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

// ---------- WP 9.4 (CF-3): no migration without the pre-migration backup ----------
//
// "Migrations never run without a backup taken first" (09 §5 item 4) is a
// property of the dependency graph, so it is asserted on the graph: any file
// that defines a `migrator` must also define `pre-migrate-backup`, and the
// migrator must wait for it to COMPLETE SUCCESSFULLY — `service_started` or
// `service_healthy` would let a failed or still-running backup be raced. The
// service's own hardening (non-root, read-only, cap_drop ALL,
// no-new-privileges) is held by the general rules above like every other
// service; the hostile fixture breaks each of them on a `pre-migrate-backup`.
if (services.migrator !== undefined) {
  const dep = (services.migrator.depends_on ?? {})['pre-migrate-backup'];
  if (services['pre-migrate-backup'] === undefined) {
    report('migrator', 'migrator-missing-pre-migrate-backup', 'no `pre-migrate-backup` service is defined');
  } else if (dep === undefined || dep.condition !== 'service_completed_successfully') {
    report(
      'migrator',
      'migrator-missing-pre-migrate-backup',
      `depends_on pre-migrate-backup is ${dep === undefined ? 'absent' : JSON.stringify(dep.condition)}; ` +
        'it must be service_completed_successfully so a failed backup blocks every migration',
    );
  }
}

// ---------- WP 5.2: the local-model sandbox ----------
//
// Identified by image *or* name, so renaming the service does not escape the
// rules and neither does swapping the image under the old name. A "pull"
// service is the one-shot `ollama-pull` (or anything in the `local-llm-pull`
// profile); every other ollama service is a runtime.
const OLLAMA_IMAGE_RE = /^(?:docker\.io\/)?ollama\/ollama(?:[:@]|$)/;
const LLM_NETWORK = 'llm';
const LLM_MEMBERS = new Set(['ollama', 'worker']);
const declaredNetworks = doc.networks ?? {};

function isOllama(name, spec) {
  return OLLAMA_IMAGE_RE.test(String(spec.image ?? '')) || /^ollama(?:-|$)/.test(name);
}
function isPull(name, spec) {
  return name === 'ollama-pull' || (spec.profiles ?? []).includes('local-llm-pull');
}
function networksOf(spec) {
  const nets = spec.networks ?? {};
  return Array.isArray(nets) ? nets : Object.keys(nets);
}
const membersOf = new Map();
for (const [service, spec] of Object.entries(services)) {
  for (const net of networksOf(spec)) {
    if (!membersOf.has(net)) membersOf.set(net, []);
    membersOf.get(net).push(service);
  }
}

// Any service on `llm` other than the runtime and the worker: `api` (runs no
// local model), `db`, a sidecar. `db` on `llm` would undo P0-8 for Ollama.
for (const service of membersOf.get(LLM_NETWORK) ?? []) {
  if (!LLM_MEMBERS.has(service)) {
    report(service, 'llm-network-member', `joins "${LLM_NETWORK}", whose only members may be ollama and worker`);
  }
}
if (declaredNetworks[LLM_NETWORK] !== undefined && declaredNetworks[LLM_NETWORK].internal !== true) {
  report('(networks)', 'llm-network-not-internal', `network "${LLM_NETWORK}" is not internal: true — it would route off the host`);
}

for (const [service, spec] of Object.entries(services)) {
  if (!isOllama(service, spec)) continue;
  const pull = isPull(service, spec);
  const nets = networksOf(spec);

  if (!/@sha256:[0-9a-f]{64}$/.test(String(spec.image ?? ''))) {
    report(service, 'ollama-image-unpinned', `image ${JSON.stringify(spec.image ?? null)} is not pinned by digest`);
  }
  if ((spec.ports ?? []).length > 0) {
    report(service, 'ollama-published-port', `publishes ${(spec.ports ?? []).length} port(s); the model is reached over "${LLM_NETWORK}" only`);
  }
  if ((spec.secrets ?? []).length > 0) {
    report(service, 'ollama-secret', `mounts ${(spec.secrets ?? []).length} secret(s); a local model needs no credential`);
  }
  const debug = (spec.environment ?? {}).OLLAMA_DEBUG;
  if (debug !== undefined && debug !== null && !['', '0', 'false'].includes(String(debug).trim().toLowerCase())) {
    report(service, 'ollama-debug-logging', `OLLAMA_DEBUG=${JSON.stringify(debug)} logs prompt content to the host disk`);
  }
  const limits = spec.deploy?.resources?.limits ?? {};
  const missing = [];
  if (limits.memory === undefined && spec.mem_limit === undefined) missing.push('memory');
  if (limits.cpus === undefined && spec.cpus === undefined) missing.push('cpus');
  if (limits.pids === undefined && spec.pids_limit === undefined) missing.push('pids');
  if (missing.length > 0) {
    report(service, 'ollama-missing-limits', `no ${missing.join(', ')} limit`);
  }

  const profiles = spec.profiles ?? [];
  if (pull) {
    if (!profiles.includes('local-llm-pull') || profiles.includes('local-llm') || profiles.length !== 1) {
      report(service, 'ollama-missing-profile', `profiles ${JSON.stringify(profiles)}: the pull must be only in "local-llm-pull"`);
    }
    // The one container with internet access shares a network with nothing.
    for (const net of nets) {
      const others = (membersOf.get(net) ?? []).filter((other) => other !== service);
      if (others.length > 0 || net === 'backend' || net === LLM_NETWORK || declaredNetworks[net]?.internal === true) {
        report(service, 'ollama-pull-network-shared', `network "${net}" is shared with ${JSON.stringify(others)} or is backend/${LLM_NETWORK}/internal`);
        for (const other of others) {
          report(other, 'ollama-pull-network-shared', `shares network "${net}" with the model pull, which reaches the internet`);
        }
      }
    }
    if (spec.network_mode !== undefined) {
      report(service, 'ollama-pull-network-shared', `network_mode ${JSON.stringify(spec.network_mode)}`);
    }
  } else {
    if (!profiles.includes('local-llm')) {
      report(service, 'ollama-missing-profile', `profiles ${JSON.stringify(profiles)}: the runtime must be profile-gated under "local-llm"`);
    }
    if (spec.network_mode !== undefined || nets.length !== 1 || nets[0] !== LLM_NETWORK) {
      report(service, 'ollama-network', `networks ${JSON.stringify(nets)}${spec.network_mode ? ` network_mode ${spec.network_mode}` : ''}: the runtime joins "${LLM_NETWORK}" and nothing else`);
    }
    const healthcheck = spec.healthcheck;
    if (healthcheck === undefined || healthcheck.disable === true || (healthcheck.test ?? []).length === 0) {
      report(service, 'ollama-missing-healthcheck', 'no healthcheck');
    }
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

# Renders one or more compose files' fully-resolved model, layered in the
# order given (`-f a -f b` == compose's own override semantics: `b` merges
# onto `a`). `--profile '*'` enables every profile so the sidecar/local-llm/
# webhooks placeholders are held to the same bar as the default services — the
# old grep saw them because it read raw text, and a profile-gated hazard is
# still a hazard.
compose_config() {
  local args=()
  for file in "$@"; do args+=(-f "$file"); done
  docker compose "${args[@]}" --profile '*' config --format json
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

# D-7 (gate-security-review.md §8.2 N-2): an override fragment has no image or
# build context of its own — `docker compose -f override config` alone is
# rejected by Compose, correctly, the same way any incomplete service
# definition is. The old gate read that rejection as "nothing to check" for
# every override, including `compose.override.yml`, the one Compose itself
# auto-loads on top of `compose.yml` with no `-f` flag at all — so the
# documented Plaid-enabling override in compose.override.example.yml broke
# `just verify` the moment anyone actually used it (a real, non-hostile,
# documented workflow going red is worse than a hostile one: it teaches
# operators to stop running the gate). This renders `base` and `override`
# layered, exactly as `docker compose up` would, and evaluates the merged
# result — so a hostile trait added only in the override (a `privileged: true`
# nobody would put in compose.yml itself) is still caught.
check_layered() {
  local base="$1" override="$2"
  local label="${base}+${override}"
  local json rc=0
  if ! json="$(compose_config "$base" "$override" 2>/tmp/compose-hardening-config-err.$$)"; then
    echo "compose-hardening-check: FAIL: $label: 'docker compose config' rejected the layered pair:" >&2
    sed 's/^/    /' "/tmp/compose-hardening-config-err.$$" >&2
    rm -f "/tmp/compose-hardening-config-err.$$"
    return 1
  fi
  rm -f "/tmp/compose-hardening-config-err.$$"
  # exceptionLabel = $base: db's documented missing-read-only exception is a
  # property of compose.yml and must still apply when something is layered on
  # top of it that has nothing to do with db.
  printf '%s' "$json" | node "$EVALUATOR" "$label" "$base" >/dev/null || rc=$?
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
  # WP 5.2: each named hostile service must trip each named rule.
  local pairs missing_pairs=()
  pairs="$(printf '%s' "$json" | node "$EVALUATOR" "$FIXTURE" 2>/dev/null | awk -F '\t' '{ print $2 "\t" $1 }' | sort -u || true)"
  for pair in "${EXPECTED_SERVICE_RULES[@]}"; do
    grep -qxF "$pair" <<<"$pairs" || missing_pairs+=("${pair//$'\t'/:}")
  done
  if [ "${#missing_pairs[@]}" -ne 0 ]; then
    echo "compose-hardening-check: SELF-TEST FAILED: these service:rule pairs did not fire: ${missing_pairs[*]}" >&2
    rc=1
  else
    echo "  per-service cases (ollama sandbox, pre-migrate-backup, migrator): all ${#EXPECTED_SERVICE_RULES[@]} service:rule pairs fired" >&2
  fi
  if [ "$rc" -eq 0 ]; then
    echo "compose-hardening-check: SELF-TEST PASS (all ${#EXPECTED_RULES[@]} rules fire on a hostile file)" >&2
  fi

  # D-7: prove the override fragment is rejected standalone (the shape that
  # used to be silently read as "nothing to check") and that layering it on
  # its base catches the hostile trait it adds.
  echo "compose-hardening-check: --self-test: layered override rendering ($OVERRIDE_FIXTURE on $OVERRIDE_BASE_FIXTURE)" >&2
  if compose_config "$OVERRIDE_FIXTURE" >/dev/null 2>&1; then
    echo "compose-hardening-check: SELF-TEST FAILED: $OVERRIDE_FIXTURE unexpectedly parses standalone" \
      "— it no longer exercises the 'fragment with no image/build context' shape check_layered exists for" >&2
    rc=1
  fi
  local layered_json layered_fired
  layered_json="$(compose_config "$OVERRIDE_BASE_FIXTURE" "$OVERRIDE_FIXTURE")"
  layered_fired="$(printf '%s' "$layered_json" | node "$EVALUATOR" "${OVERRIDE_BASE_FIXTURE}+${OVERRIDE_FIXTURE}" "$OVERRIDE_BASE_FIXTURE" 2>/dev/null | cut -f1 | sort -u || true)"
  if ! grep -qx 'privileged' <<<"$layered_fired"; then
    echo "compose-hardening-check: SELF-TEST FAILED: layering $OVERRIDE_FIXTURE onto $OVERRIDE_BASE_FIXTURE" \
      "did not report 'privileged' — overrides are not actually being evaluated" >&2
    rc=1
  else
    echo "  layered override fixture triggered: privileged" >&2
  fi
  # And the base alone, un-layered, must stay clean — otherwise this fixture
  # pair would not isolate "the override introduced the hazard" from "the
  # base was already hostile", and the self-test above would prove nothing.
  local base_fired
  base_fired="$(compose_config "$OVERRIDE_BASE_FIXTURE" | node "$EVALUATOR" "$OVERRIDE_BASE_FIXTURE" 2>/dev/null | cut -f1 | sort -u || true)"
  if [ -n "$base_fired" ]; then
    echo "compose-hardening-check: SELF-TEST FAILED: $OVERRIDE_BASE_FIXTURE alone already fires ($base_fired)" \
      "— it must be clean so the layered fixture proves the override is what's caught" >&2
    rc=1
  fi
  if [ "$rc" -eq 0 ]; then
    echo "compose-hardening-check: SELF-TEST PASS (layered override rendering catches a hostile trait the base does not have)" >&2
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
  if [ "$file" = "compose.override.yml" ]; then
    # D-7: not checked standalone — an override fragment legitimately has no
    # image/build context of its own, and `compose.yml` is always the file it
    # layers onto in practice (this is the one filename Compose itself
    # auto-loads with no `-f` flag). Checked layered, below, instead.
    continue
  fi
  check_file "$file" || FAIL=1
done

if [ -e "compose.override.yml" ]; then
  if [ -e "compose.yml" ]; then
    check_layered "compose.yml" "compose.override.yml" || FAIL=1
  else
    echo "compose-hardening-check: FAIL: compose.override.yml exists but compose.yml does not" \
      "— nothing for it to layer onto" >&2
    FAIL=1
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  echo "compose-hardening-check: FAIL — one or more compose files violate the P0-6/P0-7 baseline" >&2
  exit 1
fi

echo "compose-hardening-check: PASS (${#FILES[@]} file(s) checked: ${FILES[*]})"
