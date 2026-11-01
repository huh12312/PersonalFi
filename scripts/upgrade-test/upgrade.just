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
# WP 9.11 (G-21 / CF-19) adds two things, neither of which changes a dev,
# gate or scratch upgrade:
#   * the production project (`personalfi-prod`, as compose resolves it —
#     `.env` included) runs scripts/soak/check-isolation.sh first and refuses
#     on any violation (the floating `dev` tag, this agent checkout, ...).
#     Every other project is left alone: that guard refuses every project but
#     production by design, so calling it unconditionally would break the
#     upgrade test and every scratch install;
#   * `PERSONALFI_PULL=1 PERSONALFI_RELEASE=x.y.z just upgrade` (what `just
#     install-release x.y.z` runs) pulls the published images instead of
#     building: scripts/verify-release.sh checks each digest's cosign
#     signature (this repository's release.yml at `v<release>`, at the
#     checked-out commit when this is a git checkout) and its provenance
#     attestation, then pulls by digest. WP 12.3: compose's image names ARE
#     the published names (`<REGISTRY>/personalfi-<image>:<version>`), so the
#     recipe first requires that compose resolves exactly
#     `<REGISTRY>/personalfi-<image>:<release>` for every PersonalFi service
#     (PERSONALFI_VERSION=<release> in .env), passes REGISTRY to the verifier
#     as `--source`, and starts with `up --no-build --pull never`: nothing is
#     re-tagged, nothing is built, and nothing unverified is fetched under a
#     PersonalFi name.
#   * the build path refuses to build a published release's name
#     (scripts/build-name-guard.sh): with PERSONALFI_VERSION=x.y.z under the
#     publishing registries, the only way in is the verified pull.
#
# Upgrade this install in place, after `git pull` (automatic backup, migrations, checks)
upgrade:
    #!/usr/bin/env bash
    set -euo pipefail
    # This recipe lives in an imported file. just < 1.3x runs an imported recipe
    # from the IMPORTED file's directory (1.21, Ubuntu 24.04's package: the
    # first runner run failed `bash: scripts/secrets-placeholders.sh: No such
    # file`), newer versions from the root's. justfile_directory() is the root
    # justfile's directory in both, so this line makes the two agree.
    cd "{{justfile_directory()}}"
    # The project, the api image and every service's image exactly as compose
    # resolves them (.env included): the shell may not carry REGISTRY or
    # PERSONALFI_VERSION when .env does. Line 1: project TAB api image; then
    # one `service TAB image` line per service.
    resolved="$(docker compose config --format json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{try{const d=JSON.parse(s);const sv=d.services??{};let o=String(d.name??"")+"\t"+String(sv.api?.image??"")+"\n";for(const [n,v] of Object.entries(sv))o+=n+"\t"+String(v?.image??"")+"\n";process.stdout.write(o)}catch{process.exit(1)}})')" ||
      { echo "upgrade: FAILED: \`docker compose config\` rejected this project" >&2; exit 1; }
    head_line="${resolved%%$'\n'*}"
    project="${head_line%%$'\t'*}"
    api_image="${head_line#*$'\t'}"
    services="$(printf '%s\n' "$resolved" | tail -n +2)"
    version=""
    [[ "$api_image" != *:* ]] || version="${api_image##*:}"
    version="${version:-${PERSONALFI_VERSION:-}}"
    echo "upgrade: $(git rev-parse --short HEAD 2>/dev/null || echo 'this checkout') as ${project:-${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}}, api image ${api_image:-${REGISTRY:-ghcr.io/huh12312}/personalfi-api:${PERSONALFI_VERSION:-dev}}"
    if [ "$project" = "personalfi-prod" ]; then
      # G-21 (d): production refuses to upgrade from the wrong directory, the
      # wrong project or a floating tag, before anything is pulled or built.
      bash scripts/soak/check-isolation.sh "$project" "$version" "$PWD"
    fi
    bash scripts/secrets-placeholders.sh
    up_flags=()
    if [ "${PERSONALFI_PULL:-0}" = "1" ]; then
      release="${PERSONALFI_RELEASE:-}"
      [ -n "$release" ] || { echo "upgrade: FAILED: PERSONALFI_PULL=1 needs PERSONALFI_RELEASE=x.y.z (the release tag without its v)" >&2; exit 1; }
      [[ "$release" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
        { echo "upgrade: REFUSED: PERSONALFI_RELEASE='${release}' is not x.y.z ('latest' and 'x.y' name no single commit: pin a version)" >&2; exit 1; }
      # One name per image: compose must run exactly the published names for
      # this release, or the verified pull and what `up` starts would differ.
      if [[ "$api_image" != */personalfi-api:"$release" ]]; then
        echo "upgrade: REFUSED: compose runs '${api_image}', not <REGISTRY>/personalfi-api:${release}. Set PERSONALFI_VERSION=${release} in .env (and REGISTRY to the registry you pull from), then run this again." >&2
        exit 1
      fi
      source_ns="${api_image%/personalfi-api:"$release"}"
      others=() bad=0
      while IFS=$'\t' read -r svc img; do
        [ -n "$svc" ] || continue
        case "$svc" in
          api | worker | migrator) want="${source_ns}/personalfi-api:${release}" ;;
          backup | pre-migrate-backup) want="${source_ns}/personalfi-backup:${release}" ;;
          proxy) want="${source_ns}/personalfi-proxy:${release}" ;;
          *) want="" ;;
        esac
        if [ -n "$want" ]; then
          if [ "$img" != "$want" ]; then
            echo "upgrade: REFUSED: compose names '${img}' for ${svc}; release ${release} publishes '${want}' (compose.yml and the release disagree: is this checkout at v${release}?)" >&2
            bad=1
          fi
        else
          others+=("$svc")
        fi
      done <<<"$services"
      [ "$bad" -eq 0 ] || exit 1
      commit_args=()
      if commit="$(git rev-parse --verify --quiet HEAD 2>/dev/null)" && [ -n "$commit" ]; then
        commit_args=(--commit "$commit")
        echo "upgrade: pull-and-verify v${release} from ${source_ns}, tied to this checkout at ${commit}"
      else
        echo "upgrade: pull-and-verify v${release} from ${source_ns} (not a git checkout: the images are tied to the v${release} tag by their signature, not to a commit here)"
      fi
      bash scripts/verify-release.sh --release "$release" --source "$source_ns" --pull ${commit_args[@]+"${commit_args[@]}"}
      # The images that are not PersonalFi's (Postgres, and any profile's) by
      # compose's own pins; never ours, which arrived verified above.
      if [ "${#others[@]}" -gt 0 ]; then
        docker compose pull --quiet "${others[@]}"
      fi
      up_flags+=(--no-build --pull never)
    else
      # shellcheck disable=SC2046 # one image reference per line
      bash scripts/build-name-guard.sh $(printf '%s\n' "$services" | cut -f2 | sort -u)
      docker compose build
    fi
    started="$(date +%s)"
    echo "upgrade: up -d --wait (load $(cut -d' ' -f1-3 /proc/loadavg))"
    if ! docker compose up -d --wait --wait-timeout 900 ${up_flags[@]+"${up_flags[@]}"}; then
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
