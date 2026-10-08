#!/usr/bin/env bash
# Phases of the stranger install. Sourced by run.sh (needs lib.sh).
PREV_TAR=${PREV_TAR:-/tmp/wp913/personalfi-src-previous-wave.tar}
CAND_TAR=${CAND_TAR:-/tmp/wp913/personalfi-src.tar}

phase_start_dind() {
  note "### Run $RUN: dind setup ($(ts))"
  docker rm -fv "$C" >/dev/null 2>&1 || true
  local t0; t0=$(date +%s)
  # Only this named container is created on the host daemon. --memory 6g --cpus 4: sizing for image builds.
  # -v /var/lib/docker: anonymous volume (overlay2 cannot nest on overlay); removed by rm -fv.
  docker run -d --name "$C" --privileged --memory 6g --memory-swap 6g --cpus 4 \
    -e DOCKER_TLS_CERTDIR= -v /var/lib/docker docker:29-dind > "$RUNDIR/dind-run.out" 2>&1
  echo "dind start rc=$?"; cat "$RUNDIR/dind-run.out" | tail -3
  for i in $(seq 1 60); do docker exec "$C" docker info >/dev/null 2>&1 && break; sleep 2; done
  {
    printf '\n#### %s dind started\n\n```console\n$ docker run -d --name pf-stranger-dind --privileged --memory 6g --memory-swap 6g --cpus 4 -e DOCKER_TLS_CERTDIR= -v /var/lib/docker docker:29-dind\n' "$(ts)"
    docker exec "$C" sh -c 'docker version --format "inner engine {{.Server.Version}}"; docker compose version; cat /etc/alpine-release; nproc; head -1 /proc/meminfo; cat /sys/fs/cgroup/memory.max; id'
    printf '```\nready after %ss\n' $(( $(date +%s) - t0 ))
  } >> "$EVID" 2>&1
  docker exec "$C" sh -c 'docker version --format "{{.Server.Version}}"; docker compose version; for t in git just node openssl bash curl sudo age chromium; do printf "%s: " $t; command -v $t || echo MISSING; done' | tee "$RUNDIR/dind-initial.out"
}

phase_prereqs() {
  note "### Run $RUN: host prerequisites (README 'What you need on the host')"
  # README: "on Alpine, apk add git just nodejs openssl bash coreutils (Docker and its Compose plugin come from Docker's own packages)"
  # PREREQ_APK: copy the package list from the README being tested (run 2: the fixed README's Alpine line).
  step prereq-apk root "README's Alpine package line" "apk add ${PREREQ_APK:-git just nodejs openssl bash coreutils}"
  # README: "Run docker, just and node as the user who will own the checkout ... add that user to the docker group."
  step prereq-user root "create the owning user and add to docker group (README: 'add that user to the docker group')" \
    "getent group docker || addgroup -S docker; adduser -D -s /bin/bash pf; addgroup pf docker; ls -l /var/run/docker.sock; id pf"
  step prereq-versions pfhome "versions vs README minimums (Docker 29+, just 1.21+, Node 18+)" \
    "docker version --format 'engine {{.Server.Version}}'; docker compose version; just --version; node --version; git --version; openssl version; bash --version | head -1"
}

# sudo is named by the README as optional (/etc/hosts line, trust store, harden-secrets). Installed on demand.
phase_sudo() {
  step prereq-sudo root "README lists sudo (optional) for the /etc/hosts line and trust-store import" \
    "apk add sudo && echo 'pf ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/pf && chmod 440 /etc/sudoers.d/pf"
}

# Stand-in for 'git clone https://github.com/huh12312/PersonalFi.git' (private repo): a local bare origin whose
# main holds the previous-wave tree. The candidate is pushed to it only at upgrade time (a release being published).
phase_origin() {
  docker exec "$C" mkdir -p /opt
  docker cp "$PREV_TAR" "$C:/opt/prev.tar"
  docker cp "$CAND_TAR" "$C:/opt/cand.tar"
  step origin-prev pfhome "build the stand-in origin (previous-wave commit)" \
    "mkdir -p origin-work srv && cd origin-work && git init -q -b main && git config user.name stranger && git config user.email s@x && tar -xf /opt/prev.tar && git add -A && git commit -q -m previous-wave && git clone -q --bare . ../srv/origin.git && cd .. && git -C srv/origin.git log --oneline | head -3"
}

phase_versions() {
  step prereq-versions pfhome "versions vs README minimums (Docker 29+, just 1.21+, Node 18+)" \
    "docker version --format 'engine {{.Server.Version}}'; docker compose version; just --version; node --version; git --version; openssl version; bash --version | head -1"
}

# README Install steps 1-3
phase_install1() {
  note "### Run $RUN: README Install steps 1-3 (clone is a stand-in: the repo is private, origin = local bare repo holding the previous-wave commit)"
  step s1-clone pfhome "README Install 1: git clone (URL substituted by the local origin)" "git clone /home/pf/srv/origin.git personalfi && cd personalfi && git log --oneline | head -2 && ls"
  step s2-env pf "README Install 2: cp .env.example .env" "cp .env.example .env && grep -v '^#' .env | grep -v '^$'"
  step s3-pg pf "README Install 3: just gen-pg-secrets" "just gen-pg-secrets"
  step s3-mk pf "README Install 3: just gen-master-key" "just gen-master-key; ls -la secrets"
}

phase_build() {
  note "### Run $RUN: README Install step 4 (just build) - started $(ts)"
  step s4-build pf "README Install 4: just build (first build; README: several minutes)" "just build 2>&1 | tail -n 400"
  echo "BUILD_DONE rc=$?" 
}

# README Install steps 5-6
phase_install5() {
  step s5-age pf "README Install 5: backup keypair (verbatim)" \
    "(umask 077; docker run --rm --entrypoint age-keygen personalfi/backup:dev > \"\$HOME/personalfi-age-identity.txt\")
grep '^# public key:' \"\$HOME/personalfi-age-identity.txt\" | cut -d' ' -f4 > secrets/age_recipient
chmod 444 secrets/age_recipient
cat secrets/age_recipient; ls -la secrets \$HOME/personalfi-age-identity.txt"
  step s6-placeholders pf "README Install 6: just secrets-placeholders" "just secrets-placeholders; ls -la secrets"
}

phase_up() {
  note "### Run $RUN: README Install step 7 (up --wait) started $(ts)"
  step s7-up pf "README Install 7: docker compose up -d --wait --wait-timeout 900" "docker compose up -d --wait --wait-timeout 900 2>&1 | tail -n 60"
  step s7-ps pf "README Install 7: docker compose ps" "docker compose ps"
  step s7-ready pf "README Install 7: readiness from inside the api container" \
    "docker compose exec -T api node -e \"fetch('http://127.0.0.1:8080/ready').then(async r => console.log(r.status, await r.text()))\""
}

# README Install step 8
phase_trust() {
  note "### Run $RUN: README Install step 8 (trust the TLS certificate)"
  step s8-trustca pf "README Install 8: just trust-ca" "just trust-ca; ls -la personalfi-ca.crt"
  step s8-hosts pf "README Install 8: /etc/hosts line (verbatim)" "echo \"127.0.0.1 personalfi.lan\" | sudo tee -a /etc/hosts"
  step s8-sys-trust pf "README Install 8: Debian, Ubuntu or Alpine system store line (verbatim)" "sudo cp personalfi-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates"
  step s8-curl pf "README Install 8: curl chain check (verbatim)" "curl --cacert personalfi-ca.crt --resolve personalfi.lan:443:127.0.0.1 https://personalfi.lan/api/ready"
}

phase_curlfix() {
  note "FINDING F-13-1 hit: curl is not on the README's package list; installing it to continue."
  step s8-apk-curl root "apk add curl (NOT named by README)" "apk add curl"
  step s8-curl2 pf "README Install 8: curl chain check (verbatim), retried" "curl --cacert personalfi-ca.crt --resolve personalfi.lan:443:127.0.0.1 https://personalfi.lan/api/ready"
}

phase_bootstrap() {
  note "### Run $RUN: README Install step 9 (create account)"
  step s9-bootstrap pf "README Install 9: just bootstrap-user (verbatim)" 'just bootstrap-user name="Your Name" timezone="America/New_York"' || return 1
  grep -o 'https://personalfi.lan/register#token=[A-Za-z0-9_-]*' "$RUNDIR/s9-bootstrap.out" | head -1 > "$RUNDIR/register-link.txt"
  [ -s "$RUNDIR/register-link.txt" ]
}

# HARNESS-ONLY tooling (not README prerequisites): a headless browser + CDP client, used in place of a person with a laptop.
phase_browser_tools() {
  note "Harness-only tooling (not a README prerequisite): chromium, nss-tools (certutil), npm + puppeteer-core in /home/pf/harness"
  step h-apk root "harness: headless browser" "apk add chromium nss-tools npm font-noto 2>&1 | tail -3; chromium --version"
  step h-npm pfhome "harness: puppeteer-core (CDP client)" "mkdir -p harness && cd harness && npm init -y >/dev/null && npm install puppeteer-core 2>&1 | tail -3"
  docker cp "$(dirname "${BASH_SOURCE[0]}")/browser" "$C:/home/pf/harness/browser"
  docker exec "$C" chown -R pf:pf /home/pf/harness
}

phase_bcopy() { docker exec "$C" rm -rf /home/pf/harness/browser; docker cp "$(dirname "${BASH_SOURCE[0]}")/browser" "$C:/home/pf/harness/browser"; docker exec "$C" chown -R pf:pf /home/pf/harness; }
# harness: run a browser script as pf (NSS trust db is $HOME/.pki/nssdb)
bjs() { local n=$1; shift; docker exec -u pf -w /home/pf/harness/browser -e HOME=$PFHOME "$C" node "$n" "$@"; }

phase_nss() {
  note "README Install 8: Chrome/Chromium on Linux lines, verbatim (certutil from nss-tools, installed with the harness browser): create the NSS db because ~/.pki/nssdb does not exist yet, then import"
  step h-nss-init pf "README step 8: create ~/.pki/nssdb first (it does not exist: the browser has never run)" \
    "test -d \$HOME/.pki/nssdb && echo 'nssdb exists' || echo 'nssdb missing'; mkdir -p \$HOME/.pki/nssdb && certutil -d sql:\$HOME/.pki/nssdb -N --empty-password"
  step h-nss pf "README step 8: certutil import line, verbatim" \
    "certutil -d sql:\$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt && certutil -d sql:\$HOME/.pki/nssdb -L"
}

# Harness-only: wipe THIS test machine's stack data (inside dind) to retry the enrolment wizard after a harness mistake.
phase_resetdata() {
  note "Harness-only (not README): docker compose down -v inside dind to retry the enrolment wizard (my harness had closed the browser mid-wizard). Not part of the README path."
  step h-reset pf "harness: compose down -v, up --wait" "docker compose down -v 2>&1 | tail -5; docker compose up -d --wait --wait-timeout 900 2>&1 | tail -4"
  step h-bootstrap pf "harness: bootstrap-user again on the clean volume" 'just bootstrap-user name="Your Name" timezone="America/New_York"'
  grep -o 'https://personalfi.lan/register#token=[A-Za-z0-9_-]*' "$RUNDIR/h-bootstrap.out" | head -1 > "$RUNDIR/register-link.txt"
}

phase_bootstrap_retry() {
  step h-bootstrap2 pf "harness: bootstrap-user retried (see finding F-13-4)" 'just bootstrap-user name="Your Name" timezone="America/New_York"'
  grep -o 'https://personalfi.lan/register#token=[A-Za-z0-9_-]*' "$RUNDIR/h-bootstrap2.out" | head -1 > "$RUNDIR/register-link.txt"
}

phase_reissue() {
  step h-reissue pf "bootstrap-user reissue=true (the tool's own message, not the README)" 'just bootstrap-user name="Your Name" timezone="America/New_York" reissue=true'
  grep -o 'https://personalfi.lan/register#token=[A-Za-z0-9_-]*' "$RUNDIR/h-reissue.out" | head -1 > "$RUNDIR/register-link.txt"
}

phase_nss_refresh() {
  step h-trustca2 pf "harness: just trust-ca again (the CA was regenerated by compose down -v)" "just trust-ca"
  step h-nss2 pf "harness: replace the NSS trust entry" "certutil -d sql:\$HOME/.pki/nssdb -D -n personalfi; certutil -d sql:\$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt && certutil -d sql:\$HOME/.pki/nssdb -L | tail -2; curl -sS --cacert personalfi-ca.crt https://personalfi.lan/api/ready | head -c 60"
}

# harness: bounce the stack data and re-enrol (wizard development, harness-only)

phase_restart_api() {
  step h-restart-api pf "harness workaround (NOT README): restart the api so its memory returns to baseline" "docker compose restart api 2>&1 | tail -3; docker compose up -d --wait --wait-timeout 300 2>&1 | tail -2; docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'"
}
phase_stats() { step h-stats pf "container memory" "docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'"; }

phase_justlist() { step h-justlist pf "README says 'just --list shows them all'" "just --list"; }

phase_sample() {
  note "### Run $RUN: README 'Your first data' step 1 (sample CSV; browser part is browser/import.mjs)"
  step d1-sample pf "README Your first data 1: sample.csv (verbatim)" "printf 'Date,Description,Amount\n2026-09-01,Coffee shop,-4.50\n2026-09-02,Payroll,2500.00\n2026-09-03,Grocery store,-62.18\n' > sample.csv; cat sample.csv"
}

phase_backup() {
  note "### Run $RUN: README 'Your first data' step 2 (backup)"
  step d2-backup pf "README Your first data 2: just backup" "just backup"
}
phase_drill() {
  note "### Run $RUN: README 'Your first data' step 3 (restore drill) started $(ts)"
  step d3-drill pf "README Your first data 3: restore drill (verbatim)" 'export AGE_IDENTITY_FILE="$HOME/personalfi-age-identity.txt"
export DRILL_EVIDENCE_DIR="$HOME/personalfi-drills"
just restore-drill'
}

# Stand-in for "the maintainers publish the candidate to the origin" (not a README step): a child commit of main.
phase_publish() {
  note "### Run $RUN: publish the candidate to the stand-in origin (harness; the README's upgrade starts at 'git pull')"
  step u0-publish pfhome "push the candidate tree as a child commit of main on the stand-in origin" \
    "cd origin-work && git rm -r -q --cached . >/dev/null && find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + && tar -xf /opt/cand.tar && git add -A && git commit -q -m candidate && git push -q ../srv/origin.git main && git -C ../srv/origin.git log --oneline | head -3"
}

phase_upgrade() {
  note "### Run $RUN: README Upgrade started $(ts)"
  step u1-pull pf "README Upgrade: git pull (verbatim)" "git pull; git status --short | head; git log --oneline | head -3"
  step u2-upgrade pf "README Upgrade: just upgrade (verbatim)" "just upgrade 2>&1 | tail -n 400"
  step u3-ps pf "state after upgrade" "docker compose ps; docker compose exec -T api node -e \"fetch('http://127.0.0.1:8080/ready').then(async r => console.log(r.status, await r.text()))\""
}

phase_teardown() { docker rm -fv "$C" 2>&1 | tail -1; note "dind torn down ($(ts))"; }

# Browser phases (full pipeline). The registration link is read from the run directory, never stored in the repo.
phase_enrol() {
  note "### Run $RUN: README Install step 9-10 (browser: enrol, then sign in)"
  phase_bcopy
  bjs register.mjs "$(cat "$RUNDIR/register-link.txt")" > "$RUNDIR/register-wizard.out" 2>&1
  grep -v -E '^(a|button|input) ' "$RUNDIR/register-wizard.out" | head -60 | redact >> "$EVID"
  bjs login.mjs > "$RUNDIR/login.out" 2>&1; grep -q 'login/verify' "$RUNDIR/login.out" && grep -q '200 POST .*login/verify' "$RUNDIR/login.out"
}
phase_firstdata() {
  phase_sample
  bjs import.mjs "Checking" > "$RUNDIR/import.out" 2>&1; grep -q '200 POST .*imports/csv' "$RUNDIR/import.out" || return 1
  bjs manual.mjs "Cash wallet" > "$RUNDIR/manual.out" 2>&1
  bjs nav.mjs /transactions > "$RUNDIR/transactions-before.out" 2>&1
  grep -c -E 'Grocery store|Payroll|Coffee shop' "$RUNDIR/transactions-before.out" | tee "$RUNDIR/rows-before.txt"
}
phase_verify_after_upgrade() {
  bjs nav.mjs /transactions > "$RUNDIR/transactions-after.out" 2>&1
  grep -c -E 'Grocery store|Payroll|Coffee shop' "$RUNDIR/transactions-after.out" | tee "$RUNDIR/rows-after.txt"
  note "After upgrade: same passkey signed in; transaction rows seen before/after: $(cat "$RUNDIR/rows-before.txt") / $(cat "$RUNDIR/rows-after.txt")"
  [ "$(cat "$RUNDIR/rows-before.txt")" = "$(cat "$RUNDIR/rows-after.txt")" ]
}
