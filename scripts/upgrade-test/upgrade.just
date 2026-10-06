# Upgrade this install in place: `git pull && just upgrade` (RUNBOOK.md
# "Upgrade"; WP 9.4). Everything that used to be a hand step is in here or is
# automatic:
#   1. every optional secret declared since the install was made gets an empty
#      placeholder (scripts/secrets-placeholders.sh; never overwrites, refuses
#      to invent a required one) — CF-4;
#   2. the images are rebuilt from this checkout;
#   3. `up -d --wait`: `pre-migrate-backup` takes a verified, encrypted backup
#      when migrations are pending against a non-empty schema (CF-3), then
#      `migrator` applies them, refusing a database newer than this checkout
#      (CF-2), then api/worker start;
#   4. `/ready` must answer 200 and api/worker must not have restarted.
# Rollback is "restore the pre-migration backup", never "pin the prior image".
#
# Upgrade this install in place, after `git pull` (automatic backup, migrations, checks)
upgrade:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "upgrade: $(git rev-parse --short HEAD 2>/dev/null || echo 'this checkout') as ${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}, images ${REGISTRY:-personalfi}/*:${PERSONALFI_VERSION:-dev}"
    bash scripts/secrets-placeholders.sh
    docker compose build
    started="$(date +%s)"
    echo "upgrade: up -d --wait (load $(cut -d' ' -f1-3 /proc/loadavg))"
    if ! docker compose up -d --wait --wait-timeout 900; then
      echo "upgrade: FAILED to come up. The migrator and the pre-migration backup say why:" >&2
      docker compose logs --no-log-prefix --tail 20 pre-migrate-backup migrator >&2 || true
      exit 1
    fi
    # 200 is ready to serve. A 200 whose status is not "ready" (a consumer
    # dead-lettered, an outbox lagging) does not fail the upgrade, because it
    # may predate it, but it is printed as a WARNING, never passed silently.
    if ! docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(async (r) => { const t = await r.text(); console.log('upgrade: /ready ' + r.status + ' ' + t.slice(0, 160)); let j = {}; try { j = JSON.parse(t); } catch {} if (r.ok && j.status !== 'ready') console.error('upgrade: WARNING: /ready reports ' + j.status + (j.outbox && j.outbox.failedConsumers && j.outbox.failedConsumers.length ? '; consumer(s) stopped at an event they cannot handle: ' + j.outbox.failedConsumers.join(', ') : '') + ' — the upgrade completed, but read why before relying on it'); process.exit(r.ok ? 0 : 1); }).catch((e) => { console.error('upgrade: /ready unreachable: ' + e.message); process.exit(1); })"; then
      echo "upgrade: FAILED: /ready is not 200" >&2
      exit 1
    fi
    ready="$(date +%s)"
    echo "upgrade: up-to-ready $((ready - started)) s (load $(cut -d' ' -f1-3 /proc/loadavg))"
    docker compose logs --no-log-prefix pre-migrate-backup | tail -1 | sed 's/^/upgrade: /'
    # The worker derives the KEK at boot (Argon2id, ~7 s here); a crash loop
    # shows as a restart count inside this window, not at `--wait` time.
    sleep "${UPGRADE_SETTLE_SECONDS:-30}"
    bad=0
    for svc in api worker; do
      id="$(docker compose ps -q "$svc")"
      if [ -z "$id" ]; then echo "upgrade: FAILED: $svc is not running" >&2; bad=1; continue; fi
      restarts="$(docker inspect -f '{{{{.RestartCount}}' "$id")"
      state="$(docker inspect -f '{{{{.State.Status}}' "$id")"
      echo "upgrade: $svc $state, restarts $restarts"
      if [ "$restarts" != "0" ] || [ "$state" != "running" ]; then bad=1; fi
    done
    [ "$bad" -eq 0 ] || { echo "upgrade: FAILED: api/worker restarted or stopped after coming up" >&2; exit 1; }
    docker compose ps
    echo "upgrade: complete"
