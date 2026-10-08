# WP 9.13 - The stranger install (Phase 9, Wave E)

Status: RUN 2 COMPLETE, 3 NEW FINDINGS (F-13-9..F-13-11; F-13-1..8 of run 1 are fixed); waiting for the orchestrator's README fix for run 3. A finisher resumes from this file; raw per-step logs are under `/tmp/wp913/runs/<n>/`.

Harness: `scripts/stranger/{run.sh,lib.sh,phases.sh}`. Candidate commit: see `/tmp/wp913/HEAD_SHA`; previous wave: `/tmp/wp913/PREVIOUS_WAVE_SHA`.
Rules honoured: the only file I opened in the archives is `README.md` (extracted with `tar -xOf`, never unpacked on the host); the developers' checkout was not read, only `scripts/stranger/**` and this file written.

### Run 1: dind setup (2026-10-07T22:05:09Z)

#### 2026-10-07T22:05:09Z dind-run (start the disposable host)

````console
$ true

### Run 1: dind setup (2026-10-07T22:05:13Z)

#### 2026-10-07T22:05:56Z dind started

```console
$ docker run -d --name pf-stranger-dind --privileged --memory 6g --memory-swap 6g --cpus 4 -e DOCKER_TLS_CERTDIR= -v /var/lib/docker docker:29-dind
inner engine 29.8.2
Docker Compose version v5.5.1
3.24.2
8
MemTotal:       24021296 kB
6442450944
uid=0(root) gid=0(root) groups=0(root),0(root),1(bin),2(daemon),3(sys),4(adm),6(disk),10(wheel),11(floppy),20(dialout),26(tape),27(video)
````

ready after 43s

### Run 1: host prerequisites (README 'What you need on the host')

#### 2026-10-07T22:06:57Z prereq-apk (README's Alpine package line)

```console
$ apk add git just nodejs openssl bash coreutils
( 1/18) Installing readline (8.3.3-r1)
( 2/18) Installing bash (5.3.9-r1)
  Executing bash-5.3.9-r1.post-install
( 3/18) Installing coreutils-env (9.11-r0)
( 4/18) Installing coreutils-fmt (9.11-r0)
( 5/18) Installing coreutils-sha512sum (9.11-r0)
( 6/18) Installing acl-libs (2.3.2-r1)
( 7/18) Installing libattr (2.5.2-r2)
( 8/18) Installing coreutils (9.11-r0)
( 9/18) Installing libgcc (15.2.0-r5)
(10/18) Installing just (1.48.1-r0)
(11/18) Installing libstdc++ (15.2.0-r5)
(12/18) Installing ada-libs (3.3.0-r0)
(13/18) Installing icu-data-en (78.1-r0)
  Executing icu-data-en-78.1-r0.post-install
  * If you need ICU with non-English locales and legacy charset support, install
  * package icu-data-full.
(14/18) Installing icu-libs (78.1-r0)
(15/18) Installing simdjson (4.2.4-r0)
(16/18) Installing simdutf (9.0.0-r0)
(17/18) Installing sqlite-libs (3.53.4-r0)
(18/18) Installing nodejs (24.18.1-r0)
Executing busybox-1.37.0-r31.trigger
OK: 101.0 MiB in 71 packages
```

exit=0, duration=8s

#### 2026-10-07T22:07:05Z prereq-user (create the owning user and add to docker group (README: 'add that user to the docker group'))

```console
$ getent group docker || addgroup -S docker; adduser -D -s /bin/bash pf; addgroup pf docker; ls -l /var/run/docker.sock; id pf
docker:x:2375:
srw-rw---- 1 root docker 0 Oct  7 22:05 /var/run/docker.sock
uid=1000(pf) gid=1000(pf) groups=1000(pf),2375(docker)
```

exit=0, duration=0s

#### 2026-10-07T22:07:05Z prereq-versions (versions vs README minimums (Docker 29+, just 1.21+, Node 18+))

```console
$ docker version --format 'engine {{.Server.Version}}'; docker compose version; just --version; node --version; git --version; openssl version; bash --version | head -1
OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd ("/home/pf/personalfi") set in config.json failed: no such file or directory
```

exit=127, duration=0s

#### 2026-10-07T22:07:05Z prereq-sudo (README lists sudo (optional) for the /etc/hosts line and trust-store import)

```console
$ apk add sudo && echo 'pf ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/pf && chmod 440 /etc/sudoers.d/pf
(1/1) Installing sudo (1.9.17_p2-r1)
Executing busybox-1.37.0-r31.trigger
OK: 102.7 MiB in 72 packages
```

exit=0, duration=2s

#### 2026-10-07T22:07:07Z origin-prev (build the stand-in origin (previous-wave commit))

```console
$ mkdir -p origin-work srv && cd origin-work && git init -q -b main && git config user.name stranger && git config user.email s@x && tar -xf /tmp/prev.tar && git add -A && git commit -q -m previous-wave && git clone -q --bare . ../srv/origin.git && cd .. && git -C srv/origin.git log --oneline | head -3
tar: can't open '/tmp/prev.tar': No such file or directory
```

exit=1, duration=0s

#### 2026-10-07T22:07:28Z origin-prev (build the stand-in origin (previous-wave commit))

```console
$ mkdir -p origin-work srv && cd origin-work && git init -q -b main && git config user.name stranger && git config user.email s@x && tar -xf /opt/prev.tar && git add -A && git commit -q -m previous-wave && git clone -q --bare . ../srv/origin.git && cd .. && git -C srv/origin.git log --oneline | head -3
warning: re-init: ignored --initial-branch=main
83379d2 previous-wave
```

exit=0, duration=3s

#### 2026-10-07T22:07:31Z prereq-versions (versions vs README minimums (Docker 29+, just 1.21+, Node 18+))

```console
$ docker version --format 'engine {{.Server.Version}}'; docker compose version; just --version; node --version; git --version; openssl version; bash --version | head -1
engine 29.8.2
Docker Compose version v5.5.1
just 1.48.1
v24.18.1
git version 2.54.0
OpenSSL 3.5.9 29 Sep 2026 (Library: OpenSSL 3.5.9 29 Sep 2026)
GNU bash, version 5.3.9(1)-release (x86_64-alpine-linux-musl)
```

exit=0, duration=1s

### Run 1: README Install steps 1-3 (clone is a stand-in: the repo is private, origin = local bare repo holding the previous-wave commit)

#### 2026-10-07T22:07:37Z s1-clone (README Install 1: git clone (URL substituted by the local origin))

```console
$ git clone /home/pf/srv/origin.git personalfi && cd personalfi && git log --oneline | head -2 && ls
Cloning into 'personalfi'...
done.
83379d2 previous-wave
LICENSE
README.md
RUNBOOK.md
THIRD_PARTY.md
apps
compose.dev.yml
compose.override.example.yml
compose.yml
docker
docs
eslint.config.js
justfile
lefthook.yml
licenses.policy.yaml
package.json
packages
pnpm-lock.yaml
pnpm-workspace.yaml
renovate.json
scripts
tsconfig.base.json
tsconfig.json
vitest.config.ts
```

exit=0, duration=1s

#### 2026-10-07T22:07:38Z s2-env (README Install 2: cp .env.example .env)

```console
$ cp .env.example .env && grep -v '^#' .env | grep -v '^$'
NODE_ENV=development
LOG_LEVEL=info
LOG_PRETTY=true
HTTP_HOST=127.0.0.1
HTTP_PORT=8080
BASE_URL=http://127.0.0.1:8080
TRUST_PROXY=1
PUBLIC_HOST=personalfi.lan
BIND_ADDRESS=127.0.0.1
DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev
DATABASE_POOL_MAX=10
DATABASE_STATEMENT_TIMEOUT_MS=30000
SECRETS_DIR=./secrets
DEMO_MODE=false
```

exit=0, duration=0s

#### 2026-10-07T22:07:38Z s3-pg (README Install 3: just gen-pg-secrets)

```console
$ just gen-pg-secrets
wrote /home/pf/personalfi/secrets/pg_password and /home/pf/personalfi/secrets/database_url
run 'just harden-secrets' (needs sudo) to take them to 0400 owned by the consuming uid
```

exit=0, duration=0s

#### 2026-10-07T22:07:38Z s3-mk (README Install 3: just gen-master-key)

```console
$ just gen-master-key; ls -la secrets
wrote /home/pf/personalfi/secrets/master_key — back it up somewhere that is not this host
run 'just harden-secrets' (needs sudo) to take it to 0400 owned by uid 10001
total 20
drwx--S---  2 pf pf 4096 Oct  7 22:07 .
drwxr-sr-x 10 pf pf 4096 Oct  7 22:07 ..
-r--r--r--  1 pf pf  106 Oct  7 22:07 database_url
-r--r--r--  1 pf pf   64 Oct  7 22:07 master_key
-r--r--r--  1 pf pf   65 Oct  7 22:07 pg_password
```

exit=0, duration=0s

### Run 1: README Install step 4 (just build) - started 2026-10-07T22:07:42Z

#### 2026-10-07T22:07:42Z s4-build (README Install 4: just build (first build; README: several minutes))

```console
$ just build 2>&1 | tail -n 400

#30 [backup] exporting to image
#30 exporting layers 17.2s done
#30 exporting manifest sha256:17070843aa53ab107418d6c593c1d9edf4f20e85cf4c2e1d66d1cdec07024552
#30 exporting manifest sha256:17070843aa53ab107418d6c593c1d9edf4f20e85cf4c2e1d66d1cdec07024552 1.1s done
#30 exporting config sha256:62c9f6cc5f0adbc843a12ac0045fc106d0f36aa36ef02199361cb9ce49c6301e
#30 exporting config sha256:62c9f6cc5f0adbc843a12ac0045fc106d0f36aa36ef02199361cb9ce49c6301e 2.4s done
#30 exporting attestation manifest sha256:33ac6fc4c1ed38ead3cf2c111cce935db6849af52f3504cb98770274118dc15a
#30 exporting attestation manifest sha256:33ac6fc4c1ed38ead3cf2c111cce935db6849af52f3504cb98770274118dc15a 2.2s done
#30 exporting manifest list sha256:8308ceea30efa5b94839808b0d318b97cc336a4e9dd8737a3a616003f523f98a
#30 exporting manifest list sha256:8308ceea30efa5b94839808b0d318b97cc336a4e9dd8737a3a616003f523f98a 0.7s done
#30 naming to docker.io/personalfi/backup:dev
#30 naming to docker.io/personalfi/backup:dev 0.0s done
#30 unpacking to docker.io/personalfi/backup:dev
#30 ...

#29 [proxy web-build 5/6] RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked     pnpm install --frozen-lockfile --filter '@app/web...'
#29 16.15 Downloading @swc/core-linux-x64-musl@1.16.2: 6.61 MB/14.35 MB
#29 16.56 [WARN] Tarball download average speed 30 KiB/s (size 130 KiB) is below 50 KiB/s: https://registry.npmjs.org/acorn/-/acorn-8.18.0.tgz (GET)
#29 17.74 Progress: resolved 719, reused 0, downloaded 414, added 412
#29 17.94 [WARN] Tarball download average speed 38 KiB/s (size 162 KiB) is below 50 KiB/s: https://registry.npmjs.org/esquery/-/esquery-1.7.0.tgz (GET)
#29 19.14 Progress: resolved 719, reused 0, downloaded 473, added 448
#29 20.15 Progress: resolved 719, reused 0, downloaded 542, added 513
#29 21.28 Progress: resolved 719, reused 0, downloaded 632, added 608
#29 22.31 Progress: resolved 719, reused 0, downloaded 692, added 672
#29 23.39 Progress: resolved 719, reused 0, downloaded 693, added 672
#29 24.77 Progress: resolved 719, reused 0, downloaded 715, added 704
#29 25.39 Packages: +719
#29 25.39 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
#29 25.76 Progress: resolved 719, reused 0, downloaded 717, added 719, done
... [340 lines omitted; full log /tmp/wp913/runs/1/s4-build.out]
#47 exporting attestation manifest sha256:9ba1bbd2a08d6e653e8c6cdc1f4cba4c0220f0de7dfc3b8558aec0bc3f5d8e51 0.0s done
#47 exporting manifest list sha256:5af19f4a225a336e7fb3aad6e0e009a0e34d4fc52564ac89ad04da3a11c2e5fa done
#47 naming to docker.io/personalfi/api:dev done
#47 ...

#44 [worker] exporting to image
#44 unpacking to docker.io/personalfi/api:dev 12.7s done
#44 DONE 17.0s

#47 [api] exporting to image
#47 unpacking to docker.io/personalfi/api:dev 12.7s done
#47 DONE 17.0s

#46 [migrator] exporting to image
#46 unpacking to docker.io/personalfi/api:dev 12.7s done
#46 DONE 17.1s

#48 [worker] resolving provenance for metadata file
#48 DONE 0.1s

#49 [api] resolving provenance for metadata file
#49 DONE 0.1s

#50 [migrator] resolving provenance for metadata file
#50 DONE 0.0s
 Image personalfi/backup:dev Built
 Image personalfi/api:dev Built
 Image personalfi/proxy:dev Built
 Image personalfi/api:dev Built
 Image personalfi/api:dev Built
```

exit=0, duration=183s

#### 2026-10-07T22:10:56Z s5-age (README Install 5: backup keypair (verbatim))

```console
$ (umask 077; docker run --rm --entrypoint age-keygen personalfi/backup:dev > "$HOME/personalfi-age-identity.txt")
grep '^# public key:' "$HOME/personalfi-age-identity.txt" | cut -d' ' -f4 > secrets/age_recipient
chmod 444 secrets/age_recipient
cat secrets/age_recipient; ls -la secrets $HOME/personalfi-age-identity.txt
Public key: age1<redacted>
age1<redacted>
-rw------- 1 pf pf  184 Oct  7 22:10 /home/pf/personalfi-age-identity.txt

secrets:
total 24
drwx--S---  2 pf pf 4096 Oct  7 22:10 .
drwxr-sr-x 10 pf pf 4096 Oct  7 22:07 ..
-r--r--r--  1 pf pf   63 Oct  7 22:10 age_recipient
-r--r--r--  1 pf pf  106 Oct  7 22:07 database_url
-r--r--r--  1 pf pf   64 Oct  7 22:07 master_key
-r--r--r--  1 pf pf   65 Oct  7 22:07 pg_password
```

exit=0, duration=3s

#### 2026-10-07T22:10:59Z s6-placeholders (README Install 6: just secrets-placeholders)

```console
$ just secrets-placeholders; ls -la secrets
bash scripts/secrets-placeholders.sh
secrets-placeholders: set /home/pf/personalfi/secrets to 0700
secrets-placeholders: created 13 empty optional placeholder(s): advisor_token_secret b2_application_key b2_key_id coinbase_key_name coinbase_private_key coingecko_api_key etherscan_api_key fred_api_key openfigi_api_key plaid_client_id plaid_env plaid_secret tiingo_api_key (0 already present, left untouched)
total 24
drwx--S---  2 pf pf 4096 Oct  7 22:11 .
drwxr-sr-x 10 pf pf 4096 Oct  7 22:07 ..
-r--r--r--  1 pf pf    0 Oct  7 22:11 advisor_token_secret
-r--r--r--  1 pf pf   63 Oct  7 22:10 age_recipient
-r--r--r--  1 pf pf    0 Oct  7 22:11 b2_application_key
-r--r--r--  1 pf pf    0 Oct  7 22:11 b2_key_id
-r--r--r--  1 pf pf    0 Oct  7 22:11 coinbase_key_name
-r--r--r--  1 pf pf    0 Oct  7 22:11 coinbase_private_key
-r--r--r--  1 pf pf    0 Oct  7 22:11 coingecko_api_key
-r--r--r--  1 pf pf  106 Oct  7 22:07 database_url
-r--r--r--  1 pf pf    0 Oct  7 22:11 etherscan_api_key
-r--r--r--  1 pf pf    0 Oct  7 22:11 fred_api_key
-r--r--r--  1 pf pf   64 Oct  7 22:07 master_key
-r--r--r--  1 pf pf    0 Oct  7 22:11 openfigi_api_key
-r--r--r--  1 pf pf   65 Oct  7 22:07 pg_password
-r--r--r--  1 pf pf    0 Oct  7 22:11 plaid_client_id
-r--r--r--  1 pf pf    0 Oct  7 22:11 plaid_env
-r--r--r--  1 pf pf    0 Oct  7 22:11 plaid_secret
-r--r--r--  1 pf pf    0 Oct  7 22:11 tiingo_api_key
```

exit=0, duration=1s

### Run 1: README Install step 7 (up --wait) started 2026-10-07T22:11:03Z

#### 2026-10-07T22:11:03Z s7-up (README Install 7: docker compose up -d --wait --wait-timeout 900)

```console
$ docker compose up -d --wait --wait-timeout 900 2>&1 | tail -n 60
 Container personalfi-pre-migrate-backup-1 Creating
 Container personalfi-pre-migrate-backup-1 Created
 Container personalfi-migrator-1 Creating
 Container personalfi-migrator-1 Created
 Container personalfi-worker-1 Creating
 Container personalfi-backup-1 Creating
 Container personalfi-api-1 Creating
 Container personalfi-backup-1 Created
 Container personalfi-worker-1 Created
 Container personalfi-api-1 Created
 Container personalfi-proxy-1 Creating
 Container personalfi-proxy-1 Created
 Container personalfi-db-1 Starting
 Container personalfi-db-1 Started
 Container personalfi-db-1 Waiting
 Container personalfi-db-1 Healthy
 Container personalfi-pre-migrate-backup-1 Starting
 Container personalfi-pre-migrate-backup-1 Started
 Container personalfi-pre-migrate-backup-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-pre-migrate-backup-1 Exited
 Container personalfi-db-1 Healthy
 Container personalfi-migrator-1 Starting
 Container personalfi-migrator-1 Started
 Container personalfi-migrator-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-db-1 Healthy
 Container personalfi-db-1 Healthy
 Container personalfi-db-1 Healthy
 Container personalfi-migrator-1 Exited
 Container personalfi-api-1 Starting
 Container personalfi-migrator-1 Exited
 Container personalfi-migrator-1 Exited
 Container personalfi-worker-1 Starting
 Container personalfi-backup-1 Starting
 Container personalfi-api-1 Started
 Container personalfi-api-1 Waiting
 Container personalfi-worker-1 Started
 Container personalfi-backup-1 Started
 Container personalfi-api-1 Healthy
 Container personalfi-proxy-1 Starting
 Container personalfi-proxy-1 Started
 Container personalfi-worker-1 Waiting
 Container personalfi-backup-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-api-1 Waiting
 Container personalfi-pre-migrate-backup-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-proxy-1 Waiting
 Container personalfi-db-1 Healthy
 Container personalfi-pre-migrate-backup-1 Exited
 Container personalfi-migrator-1 Exited
 Container personalfi-backup-1 Healthy
 Container personalfi-api-1 Healthy
 Container personalfi-worker-1 Healthy
 Container personalfi-proxy-1 Healthy
```

exit=0, duration=41s

#### 2026-10-07T22:11:44Z s7-ps (README Install 7: docker compose ps)

```console
$ docker compose ps
NAME                  IMAGE                                                                                              COMMAND                  SERVICE   CREATED          STATUS                    PORTS
personalfi-api-1      personalfi/api:dev                                                                                 "/sbin/tini -- node …"   api       20 seconds ago   Up 11 seconds (healthy)   8080/tcp
personalfi-backup-1   personalfi/backup:dev                                                                              "/sbin/tini -- /usr/…"   backup    20 seconds ago   Up 10 seconds (healthy)
personalfi-db-1       postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2   "docker-entrypoint.s…"   db        29 seconds ago   Up 20 seconds (healthy)   5432/tcp
personalfi-proxy-1    personalfi/proxy:dev                                                                               "caddy run --config …"   proxy     20 seconds ago   Up 5 seconds (healthy)    80/tcp, 443/tcp, 2019/tcp, 443/udp, 127.0.0.1:80->8080/tcp, 127.0.0.1:443->8443/tcp
personalfi-worker-1   personalfi/api:dev                                                                                 "/sbin/tini -- node …"   worker    20 seconds ago   Up 10 seconds (healthy)   8080/tcp
```

exit=0, duration=0s

#### 2026-10-07T22:11:44Z s7-ready (README Install 7: readiness from inside the api container)

```console
$ docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(async r => console.log(r.status, await r.text()))"
200 {"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"0","maxLagEvents":0,"oldestUnprocessedAgeSeconds":null,"failedConsumers":[]},"queue":{"pending":0,"running":0,"dead":0,"stalled":0,"oldestPendingAgeSeconds":null}}
```

exit=0, duration=1s

### Run 1: README Install step 8 (trust the TLS certificate)

#### 2026-10-07T22:11:49Z s8-trustca (README Install 8: just trust-ca)

```console
$ just trust-ca; ls -la personalfi-ca.crt
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./personalfi-ca.crt
 personalfi-proxy-1 Copying personalfi-proxy-1:/data/caddy/pki/authorities/local/root.crt to ./personalfi-ca.crt
 personalfi-proxy-1 Copied personalfi-proxy-1:/data/caddy/pki/authorities/local/root.crt to ./personalfi-ca.crt
wrote ./personalfi-ca.crt — import it into your OS/browser trust store (see RUNBOOK.md)
-rw------- 1 pf pf 627 Oct  7 22:11 personalfi-ca.crt
```

exit=0, duration=0s

#### 2026-10-07T22:11:49Z s8-hosts (README Install 8: /etc/hosts line (verbatim))

```console
$ echo "127.0.0.1 personalfi.lan" | sudo tee -a /etc/hosts
127.0.0.1 personalfi.lan
```

exit=0, duration=1s

#### 2026-10-07T22:11:50Z s8-curl (README Install 8: curl chain check (verbatim))

```console
$ curl --cacert personalfi-ca.crt --resolve personalfi.lan:443:127.0.0.1 https://personalfi.lan/api/ready
bash: line 1: curl: command not found
```

exit=127, duration=0s

FINDING F-13-1 hit: curl is not on the README's package list; installing it to continue.

#### 2026-10-07T22:11:55Z s8-apk-curl (apk add curl (NOT named by README))

```console
$ apk add curl
(1/1) Installing curl (8.22.0-r0)
Executing busybox-1.37.0-r31.trigger
OK: 103.0 MiB in 73 packages
```

exit=0, duration=1s

#### 2026-10-07T22:11:56Z s8-curl2 (README Install 8: curl chain check (verbatim), retried)

````console
$ curl --cacert personalfi-ca.crt --resolve personalfi.lan:443:127.0.0.1 https://personalfi.lan/api/ready
  % Total    % Received % Xferd  Average Speed  Time    Time    Time   Current
                                 Dload  Upload  Total   Spent   Left   Speed

  0      0   0      0   0      0      0      0                              0
100    247 100    247   0      0  15261      0                              0
100    247 100    247   0      0  15186      0                              0
100    247 100    247   0      0  15107      0                              0
{"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"0","maxLagEvents":0,"oldestUnprocessedAgeSeconds":null,"failedConsumers":[]},"queue":{"pending":0,"running":0,"dead":0,"stalled":0,"oldestPendingAgeSeconds":null}}```

exit=0, duration=1s

### Run 1: README Install step 9 (create account)

#### 2026-10-07T22:12:00Z  s9-bootstrap  (README Install 9: just bootstrap-user (verbatim))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York"
bootstrap-user: running inside the api container (the stack is up)
(node:84) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:84) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user created      Your Name (01a1186c-7717-7415-b10d-bf4ff442f4b0)
time zone         America/New_York
taxonomy          153 categories seeded
advisors          40 manifests registered
schedules         categorization.retrain_weekly, notifications.deliver, notifications.digest, integrations.price_refresh, planning.net_worth_snapshot
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5589 ms · KEK generation 1

Enrol your first passkey within 60 minutes:

  https://personalfi.lan/register#token=<redacted>

  token only: <redacted>
  expires:    2026-10-07T23:12:10.819Z

Single-use. It is stored only as a SHA-256 digest, so this is the one and only
time it is readable — and it is not in any log. Enrol a second authenticator
and print your ten recovery codes straight after: one passkey on one device is
a self-inflicted denial of service.
````

exit=0, duration=10s

Harness-only tooling (not a README prerequisite): chromium, nss-tools (certutil), npm + puppeteer-core in /home/pf/harness

#### 2026-10-07T22:12:16Z h-apk (harness: headless browser)

```console
$ apk add chromium nss-tools npm font-noto 2>&1 | tail -3; chromium --version
Executing gdk-pixbuf-2.44.7-r1.trigger
Executing gtk+3.0-3.24.52-r0.trigger
OK: 865.6 MiB in 245 packages
Chromium 152.0.7977.82 Alpine Linux
```

exit=0, duration=45s

#### 2026-10-07T22:13:01Z h-npm (harness: puppeteer-core (CDP client))

```console
$ mkdir -p harness && cd harness && npm init -y >/dev/null && npm install puppeteer-core 2>&1 | tail -3
  run `npm fund` for details

found 0 vulnerabilities
```

exit=0, duration=10s

Harness: import personalfi-ca.crt into Chromium's NSS trust store (README names only Arch 'trust anchor' and Firefox; see finding F-13-3)

#### 2026-10-07T22:13:32Z h-nss (import the CA into ~/.pki/nssdb for Chromium)

```console
$ mkdir -p $HOME/.pki/nssdb && certutil -d sql:$HOME/.pki/nssdb -N --empty-password && certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt && certutil -d sql:$HOME/.pki/nssdb -L

Certificate Nickname                                         Trust Attributes
                                                             SSL,S/MIME,JAR/XPI

personalfi                                                   C,,
```

exit=0, duration=0s

Harness-only (not README): docker compose down -v inside dind to retry the enrolment wizard (my harness had closed the browser mid-wizard). Not part of the README path.

#### 2026-10-07T22:16:52Z h-reset (harness: compose down -v, up --wait)

```console
$ docker compose down -v 2>&1 | tail -5; docker compose up -d --wait --wait-timeout 900 2>&1 | tail -4
 Volume personalfi_pgdata Removed
 Volume personalfi_caddy_data Removed
 Volume personalfi_caddy_config Removed
 Network personalfi_backend Removed
 Network personalfi_frontend Removed
 Container personalfi-backup-1 Healthy
 Container personalfi-api-1 Healthy
 Container personalfi-worker-1 Healthy
 Container personalfi-proxy-1 Healthy
```

exit=0, duration=27s

#### 2026-10-07T22:17:19Z h-bootstrap (harness: bootstrap-user again on the clean volume)

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York"
bootstrap-user: running inside the api container (the stack is up)
(node:71) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:71) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user created      Your Name (01a11871-551c-76c8-9290-fe5b171b6da5)
time zone         America/New_York
taxonomy          153 categories seeded
advisors          40 manifests registered
schedules         categorization.retrain_weekly, notifications.deliver, notifications.digest, integrations.price_refresh, planning.net_worth_snapshot
deriving the key-encryption key (argon2id); this takes a few seconds…
error: Recipe `bootstrap-user` failed with exit code 137
```

exit=137, duration=11s

#### 2026-10-07T22:17:54Z h-bootstrap2 (harness: bootstrap-user retried (see finding F-13-4))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York"
bootstrap-user: running inside the api container (the stack is up)
(node:101) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:101) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
A user already exists: Your Name (01a11871-551c-76c8-9290-fe5b171b6da5).
Pass reissue=true to mint a fresh passkey-enrolment link for it — that is the recovery path for losing every passkey and every recovery code.
error: Recipe `bootstrap-user` failed with exit code 1
```

exit=1, duration=3s

#### 2026-10-07T22:18:06Z h-reissue (bootstrap-user reissue=true (the tool's own message, not the README))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York" reissue=true
bootstrap-user: running inside the api container (the stack is up)
(node:118) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:118) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user              Your Name (01a11871-551c-76c8-9290-fe5b171b6da5)
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5652 ms · KEK generation 1

Enrol your first passkey within 60 minutes:

  https://personalfi.lan/register#token=<redacted>

  token only: <redacted>
  expires:    2026-10-07T23:18:15.556Z

Single-use. It is stored only as a SHA-256 digest, so this is the one and only
time it is readable — and it is not in any log. Enrol a second authenticator
and print your ten recovery codes straight after: one passkey on one device is
a self-inflicted denial of service.
```

exit=0, duration=9s

#### 2026-10-07T22:18:31Z h-trustca2 (harness: just trust-ca again (the CA was regenerated by compose down -v))

```console
$ just trust-ca
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./personalfi-ca.crt
 personalfi-proxy-1 Copying personalfi-proxy-1:/data/caddy/pki/authorities/local/root.crt to ./personalfi-ca.crt
 personalfi-proxy-1 Copied personalfi-proxy-1:/data/caddy/pki/authorities/local/root.crt to ./personalfi-ca.crt
wrote ./personalfi-ca.crt — import it into your OS/browser trust store (see RUNBOOK.md)
```

exit=0, duration=0s

#### 2026-10-07T22:18:31Z h-nss2 (harness: replace the NSS trust entry)

````console
$ certutil -d sql:$HOME/.pki/nssdb -D -n personalfi; certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt && certutil -d sql:$HOME/.pki/nssdb -L | tail -2; curl -sS --cacert personalfi-ca.crt https://personalfi.lan/api/ready | head -c 60

personalfi                                                   C,,
{"status":"ready","database":"reachable","migrations":"curre```

exit=0, duration=0s

#### 2026-10-07T22:18:54Z  h-reissue  (bootstrap-user reissue=true (the tool's own message, not the README))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York" reissue=true
bootstrap-user: running inside the api container (the stack is up)
(node:161) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:161) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user              Your Name (01a11871-551c-76c8-9290-fe5b171b6da5)
deriving the key-encryption key (argon2id); this takes a few seconds…
error: Recipe `bootstrap-user` failed with exit code 137
````

exit=137, duration=4s

#### 2026-10-07T22:19:05Z h-reissue (bootstrap-user reissue=true (the tool's own message, not the README))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York" reissue=true
bootstrap-user: running inside the api container (the stack is up)
(node:84) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:84) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user              Your Name (01a11871-551c-76c8-9290-fe5b171b6da5)
deriving the key-encryption key (argon2id); this takes a few seconds…
error: Recipe `bootstrap-user` failed with exit code 137
```

exit=137, duration=6s

#### 2026-10-07T22:19:23Z h-restart-api (harness workaround (NOT README): restart the api so its memory returns to baseline)

```console
$ docker compose restart api 2>&1 | tail -3; docker compose up -d --wait --wait-timeout 300 2>&1 | tail -2; docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
 Container personalfi-api-1 Restarting
 Container personalfi-api-1 Started
 Container personalfi-migrator-1 Exited
 Container personalfi-api-1 Healthy
personalfi-proxy-1 26.5MiB / 128MiB
personalfi-worker-1 125.7MiB / 1.5GiB
personalfi-api-1 169.6MiB / 1.5GiB
personalfi-backup-1 748KiB / 256MiB
personalfi-db-1 82.5MiB / 1GiB
```

exit=0, duration=15s

#### 2026-10-07T22:19:42Z h-reissue (bootstrap-user reissue=true (the tool's own message, not the README))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York" reissue=true
bootstrap-user: running inside the api container (the stack is up)
(node:136) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:136) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user              Your Name (01a11871-551c-76c8-9290-fe5b171b6da5)
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5174 ms · KEK generation 1

Enrol your first passkey within 60 minutes:

  https://personalfi.lan/register#token=<redacted>

  token only: <redacted>
  expires:    2026-10-07T23:19:50.274Z

Single-use. It is stored only as a SHA-256 digest, so this is the one and only
time it is readable — and it is not in any log. Enrol a second authenticator
and print your ten recovery codes straight after: one passkey on one device is
a self-inflicted denial of service.
```

exit=0, duration=8s

#### 2026-10-07T22:19:50Z h-stats (container memory)

```console
$ docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
personalfi-proxy-1 26.83MiB / 128MiB
personalfi-worker-1 125.6MiB / 1.5GiB
personalfi-api-1 169.5MiB / 1.5GiB
personalfi-backup-1 748KiB / 256MiB
personalfi-db-1 82.47MiB / 1GiB
```

exit=0, duration=2s

#### 2026-10-07T22:20:55Z h-stats (container memory)

```console
$ docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
personalfi-proxy-1 28.66MiB / 128MiB
personalfi-worker-1 125.4MiB / 1.5GiB
personalfi-api-1 170.1MiB / 1.5GiB
personalfi-backup-1 748KiB / 256MiB
personalfi-db-1 83.65MiB / 1GiB
```

exit=0, duration=2s

#### 2026-10-07T22:21:00Z h-reissue (bootstrap-user reissue=true (the tool's own message, not the README))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York" reissue=true
bootstrap-user: running inside the api container (the stack is up)
(node:179) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:179) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user              Your Name (01a11871-551c-76c8-9290-fe5b171b6da5)
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5163 ms · KEK generation 1

Enrol your first passkey within 60 minutes:

  https://personalfi.lan/register#token=<redacted>

  token only: <redacted>
  expires:    2026-10-07T23:21:08.482Z

Single-use. It is stored only as a SHA-256 digest, so this is the one and only
time it is readable — and it is not in any log. Enrol a second authenticator
and print your ten recovery codes straight after: one passkey on one device is
a self-inflicted denial of service.
```

exit=0, duration=8s

#### 2026-10-07T22:21:20Z h-stats (container memory)

```console
$ docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
personalfi-proxy-1 32.17MiB / 128MiB
personalfi-worker-1 125.2MiB / 1.5GiB
personalfi-api-1 140.7MiB / 1.5GiB
personalfi-backup-1 748KiB / 256MiB
personalfi-db-1 94.3MiB / 1GiB
```

exit=0, duration=3s

#### 2026-10-07T22:21:28Z h-reissue (bootstrap-user reissue=true (the tool's own message, not the README))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York" reissue=true
bootstrap-user: running inside the api container (the stack is up)
(node:209) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:209) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user              Your Name (01a11871-551c-76c8-9290-fe5b171b6da5)
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 6458 ms · KEK generation 1

Enrol your first passkey within 60 minutes:

  https://personalfi.lan/register#token=<redacted>

  token only: <redacted>
  expires:    2026-10-07T23:21:38.392Z

Single-use. It is stored only as a SHA-256 digest, so this is the one and only
time it is readable — and it is not in any log. Enrol a second authenticator
and print your ten recovery codes straight after: one passkey on one device is
a self-inflicted denial of service.
```

exit=0, duration=10s

#### 2026-10-07T22:21:56Z h-justlist (README says 'just --list shows them all')

```console
$ just --list
Available recipes:
    backup                              # backup-loop.sh already runs inside the `backup` service.
    bootstrap-user name="" timezone="UTC" reissue="false" # just bootstrap-user "Chris" "America/Los_Angeles"
    build                               # Build the api/worker/migrator, backup, and proxy images.
    check                               # so the two names now mean different things on purpose.
    check-perf-skips                    # Every skipIf in a perf test must name its reason (WP 9.9; CI prints the list)
    check-proxy-routes                  # needs no package.json edit to wire up; `check` above runs it directly.
    check-secret-ownership              # declarations rather than a second hand-written list.
    compose-lint                        # Old name, kept so existing hooks/docs/muscle memory keep working.
    db-down                             # Stop the dev database. The volume survives.
    db-logs
    db-reset                            # Stop the dev database and destroy its data.
    db-up                               # Start the dev database and wait for it to accept connections.
    dev                                 # Run the API against the dev database.
    down
    drill-worker-restart                # docs/evidence/phase-0/wp0.3-worker-restart-drill.md records.
    format
    gen-master-key                      # Never an env var: env leaks into `docker inspect` and /proc/<pid>/environ (P0-2).
    gen-pg-secrets                      # `pg_password`, same as `gen-master-key`.
    harden-secrets                      # uid map (must match compose.yml): db 70, api/worker/migrator 10001, backup 10002.
    hardening-check
    hooks                               # Install git hooks (lefthook). Not run at install time: install scripts are off.
    install                             # Install workspace dependencies exactly as the lockfile says.
    licenses                            # or UNKNOWN in the runtime tree).
    lint                                # boundary; self-tests against scripts/fixtures/numeric-*.ts before it reads the tree).
    logs
    migrate                             # Apply every pending migration under an advisory lock.
    migrate-new name                    # Scaffold the next migration with the right name and header.
    migrate-status                      # Show what `just migrate` would apply, changing nothing.
    openapi                             # Regenerate the checked-in OpenAPI document from the live route schemas.
    playwright-check                    # fail with an explicit next step instead of either skipping or auto-fixing.
    psql
    restore-drill                       # itself — see docker/backup/backup.sh's header).
    sbom
    scan
    secrets-placeholders *args          # Create every optional secret compose.yml declares, empty, if it is missing
    seed-stats seed="1"                 # to disk by this recipe — pass `--out=DIR` yourself via the CLI for that.
    soak-report *args                   # Weekly soak report from the production clone (WP 9.1; orchestrator only)
    test
    test-unit                           # the `*-db`/`db` ones — see the project -> job map in .github/workflows/ci.yml.
    trivyignore-check                   # is a snooze, and a snooze that never rings is a decision nobody made.
    trust-ca                            # `proxy` service to have started at least once (that's when Caddy generates it).
    typecheck
    up                                  # target that writes real secrets for you to run unattended).
    upgrade                             # Upgrade this install in place, after `git pull` (automatic backup, migrations, checks)
    upgrade-test path="direct" *args="" # The unattended-upgrade test: v0.1 installed cold, then this checkout by `just upgrade` alone
    verify                              # is not repeated here; the build and Playwright projects were the actual gap.
    verify-images                       # those; see RUNBOOK.md's pre-push list.
    worker                              # Same image and same code as the API in production; only ROLE differs (WP 0.4).
```

exit=0, duration=0s

### Run 1: README 'Your first data' step 1 (sample CSV; browser part is browser/import.mjs)

#### 2026-10-07T22:22:53Z d1-sample (README Your first data 1: sample.csv (verbatim))

```console
$ printf 'Date,Description,Amount\n2026-09-01,Coffee shop,-4.50\n2026-09-02,Payroll,2500.00\n2026-09-03,Grocery store,-62.18\n' > sample.csv; cat sample.csv
Date,Description,Amount
2026-09-01,Coffee shop,-4.50
2026-09-02,Payroll,2500.00
2026-09-03,Grocery store,-62.18
```

exit=0, duration=0s

### Run 1: README 'Your first data' step 2 (backup)

#### 2026-10-07T22:25:06Z d2-backup (README Your first data 2: just backup)

```console
$ just backup
docker compose exec backup /usr/local/bin/backup.sh
backup: dumping personalfi@db ...
backup: verified 564383 bytes, 1008 restorable object(s), schema_migrations present
backup: wrote /backups/personalfi-20261007T222506Z.dump.age (564711 bytes)
backup: pruning entries older than 30 day(s) locally
backup: RCLONE_REMOTE not set; local-only backup (see RUNBOOK.md to enable B2)
backup: complete
```

exit=0, duration=0s

### Run 1: README 'Your first data' step 3 (restore drill) started 2026-10-07T22:25:09Z

#### 2026-10-07T22:25:09Z d3-drill (README Your first data 3: restore drill (verbatim))

```console
$ export AGE_IDENTITY_FILE="$HOME/personalfi-age-identity.txt"
export DRILL_EVIDENCE_DIR="$HOME/personalfi-drills"
just restore-drill
Unable to find image 'alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b' locally
docker.io/library/alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b: Pulling from library/alpine
f5124fb579e2: Download complete
56dceff11b33: Download complete
Digest: sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
Status: Downloaded newer image for alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
restore-drill: starting scratch db (restore-drill-db-15925 on personalfi_backend) ...
restore-drill: waiting for scratch db to accept connections ....ok
restore-drill: restoring /backups/personalfi-20261007T222506Z.dump.age (564711 bytes)
restore: decrypting /backups/personalfi-20261007T222506Z.dump.age
restore: target personalfi_restore_drill@restore-drill-db; --clean --if-exists will DROP and recreate these:
restore: archive contains 1008 restorable object(s)
restore: restoring into personalfi_restore_drill@restore-drill-db (--clean --if-exists --no-owner)
restore: complete
restore-drill: booting a throwaway api container against the restored db ...
# Restore drill — 20261007T222509Z

**Verdict: PASS**

- Backup restored: `/backups/personalfi-20261007T222506Z.dump.age` (564711 encrypted bytes)
- Restored db table count: 101
- Restored db schema_migrations max id: 0040
- Live db table count: 101
- Live db schema_migrations max id: 0040
- API /ready against restored db: pass (200 from /ready)

All assertions held: restored tables > 0, restored == live, schema_migrations agree,
and the API served /ready from the restored database. `just restore-drill` exited 0.
restore-drill: wrote /home/pf/personalfi-drills/restore-drill-20261007.md
```

exit=0, duration=38s

### Run 1: publish the candidate to the stand-in origin (harness; the README's upgrade starts at 'git pull')

#### 2026-10-07T22:25:57Z u0-publish (push the candidate tree as a child commit of main on the stand-in origin)

```console
$ cd origin-work && git rm -r -q --cached . >/dev/null && find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + && tar -xf /opt/cand.tar && git add -A && git commit -q -m candidate && git push -q ../srv/origin.git main && git -C ../srv/origin.git log --oneline | head -3
6657557 candidate
83379d2 previous-wave
```

exit=0, duration=3s

### Run 1: README Upgrade started 2026-10-07T22:26:05Z

#### 2026-10-07T22:26:05Z u1-pull (README Upgrade: git pull (verbatim))

```console
$ git pull; git status --short | head; git log --oneline | head -3
From /home/pf/srv/origin
   83379d2..6657557  main       -> origin/main
Updating 83379d2..6657557
Fast-forward
 .env.example                                       |   49 +-
 .github/workflows/ci.yml                           |    8 +-
 .github/workflows/upgrade-test.yml                 |   29 +
 .trivyignore                                       |   11 +-
 README.md                                          |  287 +++++-
 RUNBOOK.md                                         | 1041 +++++++++++++-------
 THIRD_PARTY.md                                     |    2 +-
 apps/api/src/app.ts                                |    5 +
 apps/api/src/auth/guards.ts                        |   46 +-
 apps/api/src/auth/runtime.ts                       |   23 +-
 apps/api/src/bin/bootstrap-user.ts                 |   18 +-
 apps/api/src/bin/consumer-resume.ts                |   74 ++
 apps/api/src/db-role.ts                            |   79 ++
 apps/api/src/main.ts                               |   15 +-
 apps/api/src/reports/export/import.ts              |  144 +++
 apps/api/src/routes/auth.ts                        |  182 +++-
 apps/api/src/routes/budgets.ts                     |   27 +-
 apps/api/src/routes/domain-errors.ts               |    5 +
 apps/api/src/routes/export.ts                      |   14 +-
 apps/api/src/worker.ts                             |   24 +-
 apps/api/test/db/app-role.test.ts                  |  198 ++++
 apps/api/test/db/auth-security-routes.test.ts      |  334 +++++++
 apps/api/test/db/budgets-unreported.test.ts        |  236 +++++
 .../test/db/export-import-phase3-phase4.test.ts    |   53 +-
 .../api/test/db/export-import-revalidation.test.ts |  187 ++++
 apps/api/test/kek-derivation-wiring.test.ts        |   60 ++
... [258 lines omitted; full log /tmp/wp913/runs/1/u1-pull.out]
 create mode 100644 docs/evidence/phase-9/wp9.8-reports-dark.png
 create mode 100644 docs/evidence/phase-9/wp9.8-reports-light.png
 create mode 100644 docs/evidence/phase-9/wp9.8-settings-advisors-dark.png
 create mode 100644 docs/evidence/phase-9/wp9.8-settings-advisors-light.png
 create mode 100644 docs/evidence/phase-9/wp9.8-settings-dark.png
 create mode 100644 docs/evidence/phase-9/wp9.8-settings-light.png
 create mode 100644 docs/evidence/phase-9/wp9.8-transactions-dark.png
 create mode 100644 docs/evidence/phase-9/wp9.8-transactions-light.png
 create mode 100644 docs/evidence/phase-9/wp9.8-unlock-dark.png
 create mode 100644 docs/evidence/phase-9/wp9.8-unlock-light.png
 create mode 100644 docs/evidence/phase-9/wp9.8-wcag.md
 create mode 100644 packages/contexts/identity/src/kek-derivation-lock.ts
 create mode 100644 packages/contexts/identity/test/kek-derivation-lock.test.ts
 create mode 100644 packages/contexts/identity/test/totp-reenrol.test.ts
 create mode 100644 packages/contexts/identity/test/user-verification.test.ts
 create mode 100644 packages/db/migrations/0039_app_role.sql
 create mode 100644 packages/platform/src/egress/dial.test.ts
 create mode 100644 packages/platform/src/egress/dial.ts
 create mode 100644 packages/platform/src/events/resume.ts
 create mode 100644 scripts/caddy-error-headers.test.ts
 create mode 100644 scripts/check-docs.test.ts
 create mode 100644 scripts/check-docs.ts
 create mode 100755 scripts/sabotage/c5-net-worth.sh
 create mode 100644 scripts/sabotage/c5-net-worth.test.ts
 create mode 100644 scripts/upgrade-test/dockerfile-pin-policy.test.ts
 create mode 100644 scripts/upgrade-test/upgrade-recipe.test.ts
 create mode 100755 scripts/verify-release.sh
?? sample.csv
6657557 candidate
83379d2 previous-wave
```

exit=0, duration=2s

#### 2026-10-07T22:26:07Z u2-upgrade (README Upgrade: just upgrade (verbatim))

```console
$ just upgrade 2>&1 | tail -n 400
#32 3.485 [90m[Job 1] [39m[90m~[39m [36mGenerating...[39m
#32 3.485 [90m[Job 1] [39m[36m  [1] [39m../../packages/contracts/openapi/openapi.json
#32 5.446 [90m[Job 1] [39m[32m✓[39m [96m./apps/web/src/api/generated[39m [90m· 5 files · 2s[39m
#32 7.775 vite v7.3.6 building client environment for production...
#32 9.331 transforming...
#32 11.05 ../../node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/regexes.js (70:0): A comment
#32 11.05
#32 11.05 "/** Anchors a pattern source. The interpolation lives here rather than at the call site because
#32 11.05  * esbuild will not drop a `@__PURE__` call whose own argument interpolates a variable, but it
#32 11.05  * will drop `anchor(dateSource)`. Keeping it inline pinned `date` into every bundle. */"
#32 11.05
#32 11.05 in "../../node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/regexes.js" contains an annotation that Rollup cannot interpret due to the position of the comment. The comment will be removed to avoid issues.
#32 11.07 ../../node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/util.js (330:0): A comment
#32 11.07
#32 11.07 "// Wrapped in a `@__PURE__` IIFE: esbuild never tree-shakes a top-level initializer that contains a member access on `Number`, so the bare object literal survived into every bundle."
#32 11.07
#32 11.07 in "../../node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/util.js" contains an annotation that Rollup cannot interpret due to the position of the comment. The comment will be removed to avoid issues.
#32 ...

#24 [api deploy 6/9] RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked     pnpm install --frozen-lockfile --prod --filter-prod=@app/api...
#24 67.71 ✓ Lockfile passes supply-chain policies (1011 entries in 11.2s)
#24 67.71 Lockfile is up to date, resolution step is skipped
#24 ...

#33 [backup] exporting to image
#33 exporting layers
#33 ...

#24 [api deploy 6/9] RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked     pnpm install --frozen-lockfile --prod --filter-prod=@app/api...
#24 68.89 Progress: resolved 1, reused 0, downloaded 0, added 0
... [340 lines omitted; full log /tmp/wp913/runs/1/u2-upgrade.out]
 Container personalfi-api-1 Waiting
 Container personalfi-api-1 Healthy
 Container personalfi-proxy-1 Starting
 Container personalfi-proxy-1 Started
 Container personalfi-db-1 Waiting
 Container personalfi-worker-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-backup-1 Waiting
 Container personalfi-pre-migrate-backup-1 Waiting
 Container personalfi-proxy-1 Waiting
 Container personalfi-api-1 Waiting
 Container personalfi-db-1 Healthy
 Container personalfi-pre-migrate-backup-1 Exited
 Container personalfi-migrator-1 Exited
 Container personalfi-backup-1 Healthy
 Container personalfi-api-1 Healthy
 Container personalfi-proxy-1 Healthy
 Container personalfi-worker-1 Healthy
upgrade: /ready 200 {"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"7","maxLagEvents":7,"oldestUnprocessedAgeSeconds":301.33404,"failedConsumers
upgrade: up-to-ready 45 s (load 5.56 4.84 3.63)
upgrade: pre-migrate: complete: /backups/personalfi-20261007T222833Z.dump.age (marker personalfi-20261007T222833Z.pre-migrate); the migrator may start
upgrade: api running, restarts 0
upgrade: worker running, restarts 0
NAME                  IMAGE                                                                                              COMMAND                  SERVICE   CREATED              STATUS                    PORTS
personalfi-api-1      personalfi/api:dev                                                                                 "/sbin/tini -- node …"   api       About a minute ago   Up 51 seconds (healthy)   8080/tcp
personalfi-backup-1   personalfi/backup:dev                                                                              "/sbin/tini -- /usr/…"   backup    About a minute ago   Up 52 seconds (healthy)
personalfi-db-1       postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2   "docker-entrypoint.s…"   db        About a minute ago   Up 59 seconds (healthy)   5432/tcp
personalfi-proxy-1    personalfi/proxy:dev                                                                               "caddy run --config …"   proxy     About a minute ago   Up 38 seconds (healthy)   80/tcp, 443/tcp, 2019/tcp, 443/udp, 127.0.0.1:80->8080/tcp, 127.0.0.1:443->8443/tcp
personalfi-worker-1   personalfi/api:dev                                                                                 "/sbin/tini -- node …"   worker    About a minute ago   Up 51 seconds (healthy)   8080/tcp
upgrade: complete
```

exit=0, duration=199s

#### 2026-10-07T22:29:26Z u3-ps (state after upgrade)

```console
$ docker compose ps; docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(async r => console.log(r.status, await r.text()))"
NAME                  IMAGE                                                                                              COMMAND                  SERVICE   CREATED              STATUS                    PORTS
personalfi-api-1      personalfi/api:dev                                                                                 "/sbin/tini -- node …"   api       About a minute ago   Up 52 seconds (healthy)   8080/tcp
personalfi-backup-1   personalfi/backup:dev                                                                              "/sbin/tini -- /usr/…"   backup    About a minute ago   Up 52 seconds (healthy)
personalfi-db-1       postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2   "docker-entrypoint.s…"   db        About a minute ago   Up 59 seconds (healthy)   5432/tcp
personalfi-proxy-1    personalfi/proxy:dev                                                                               "caddy run --config …"   proxy     About a minute ago   Up 38 seconds (healthy)   80/tcp, 443/tcp, 2019/tcp, 443/udp, 127.0.0.1:80->8080/tcp, 127.0.0.1:443->8443/tcp
personalfi-worker-1   personalfi/api:dev                                                                                 "/sbin/tini -- node …"   worker    About a minute ago   Up 52 seconds (healthy)   8080/tcp
200 {"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"7","maxLagEvents":7,"oldestUnprocessedAgeSeconds":332.486036,"failedConsumers":[]},"queue":{"pending":0,"running":0,"dead":0,"stalled":0,"oldestPendingAgeSeconds":null}}
```

exit=0, duration=1s

#### 2026-10-07T22:30:56Z h-stats (container memory)

```console
$ docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
personalfi-proxy-1 32.46MiB / 128MiB
personalfi-api-1 145.2MiB / 1.5GiB
personalfi-worker-1 129.7MiB / 1.5GiB
personalfi-backup-1 756KiB / 256MiB
personalfi-db-1 83.48MiB / 1GiB
```

exit=0, duration=2s

#### 2026-10-07T22:31:20Z h-reissue (bootstrap-user reissue=true (the tool's own message, not the README))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York" reissue=true
bootstrap-user: running inside the api container (the stack is up)
(node:240) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:240) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user              Your Name (01a11871-551c-76c8-9290-fe5b171b6da5)
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5404 ms · KEK generation 1

Enrol your first passkey within 60 minutes:

  https://personalfi.lan/register#token=<redacted>

  token only: <redacted>
  expires:    2026-10-07T23:31:28.642Z

Single-use. It is stored only as a SHA-256 digest, so this is the one and only
time it is readable — and it is not in any log. Enrol a second authenticator
and print your ten recovery codes straight after: one passkey on one device is
a self-inflicted denial of service.
```

exit=0, duration=8s

---

## Run 1 - browser steps (driven by `scripts/stranger/browser/*.mjs`, not through the `step` wrapper)

These are the README's "open the link in a browser", "Sign in", "Add account / File import" actions. Logs: `/tmp/wp913/runs/1/register-wizard*.out`, `post-upgrade-transactions.out`.

- 22:17-22:21 Enrolment wizard (`register.mjs`): `Set up a passkey` (name field `Name this passkey`, button `Create passkey`) -> `Add a backup passkey` (button `Add passkey`, `Skip for now`) -> `You're all set / Your passkeys are ready / Continue to PersonalFi` -> dashboard. **No recovery codes were shown at any point** (first-time enrolment on the previous-wave build; and the `reissue=true` path on both builds). See F-13-5.
- Console warning from Chromium during registration: `publicKey.pubKeyCredParams is missing at least one of the default algorithm identifiers: ES256 and RS256` (informational; registration succeeded).
- Sign-in (`login.mjs`, repeated ~15 times): `/login` shows `Account` (text field, left empty), `Sign in with a passkey`, `Use an authenticator code instead`, `Use a recovery code instead`; POST `/api/auth/login/options` 200, `/login/verify` 200, dashboard. Passkey login over TLS: reached.
- First data (`import.mjs`, 22:22:57): Accounts -> `Connect your first account` -> `Add account` -> `/accounts/connections` -> `Add connection` -> tab `File import` -> preset `ISO date, one signed amount column`, `Account name` = `Checking`, file `sample.csv`, `Import` -> POST `/api/imports/csv` 200; connection card `sample.csv  Connected  1 account`; `/transactions` lists Sep 3 `Grocery store` -$62.18, Sep 2 `Payroll` +$2,500.00, Sep 1 `Coffee shop` -$4.50, all in `Checking`.
- Manual account (`manual.mjs`): `Manual account` tab -> `Account name` = `Cash wallet` -> `Add account`; `/accounts` lists `Cash wallet` and `Checking`, both `No balance yet`.
- 22:30 after `just upgrade`: new browser, same virtual-authenticator credential (exported with `WebAuthn.getCredentials`, re-imported with `WebAuthn.addCredential`): sign-in 200, `/transactions` still lists the three imported rows; `/accounts` still lists both accounts.

## Run 1 - what I reached, with timings

| #   | Goal                                                   | Result                                                                                                                   | Timing                                                                                                                                                                                                            |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Prerequisites + dind                                   | ok (curl missing, F-13-1)                                                                                                | apk line 8 s                                                                                                                                                                                                      |
| 1   | Stack up, passkey login over TLS                       | REACHED                                                                                                                  | first `just build` 183 s (22:07:42-22:10:45); `docker compose up -d --wait` 41 s; `/ready` 200; TLS curl ok after installing curl; account link `just bootstrap-user` 10 s (one OOM exit 137 on a re-try, F-13-4) |
| 2   | Manual account + CSV import                            | REACHED                                                                                                                  | seconds                                                                                                                                                                                                           |
| 3   | `just backup`                                          | REACHED: `backup: complete`, 564,711-byte `.dump.age`, 1008 restorable objects                                           | <1 s                                                                                                                                                                                                              |
| 4   | `just restore-drill`                                   | REACHED: `Verdict: PASS` (101 tables restored == live, schema_migrations max 0040, API /ready 200 from the restored db)  | 38 s (includes pulling the two pinned images)                                                                                                                                                                     |
| 5   | `git pull` + `just upgrade` previous-wave -> candidate | REACHED: `upgrade: complete`; pre-migrate backup taken; up-to-ready 45 s; api/worker restarts 0; data and passkey intact | `just upgrade` 199 s (22:26:07-22:29:26)                                                                                                                                                                          |

Previous wave = `b9fa4d2`, candidate = `db6c654efb6d47b53426146caaa345a1cd385bdb`.

## Disposable host (dind) setup

`docker run -d --name pf-stranger-dind --privileged --memory 6g --memory-swap 6g --cpus 4 -e DOCKER_TLS_CERTDIR= -v /var/lib/docker docker:29-dind` (inner engine 29.8.2, Compose v5.5.1, Alpine). `--memory 6g` as instructed; `-v /var/lib/docker` is an anonymous volume (overlay2 does not nest on the container's overlay root) and is removed by `docker rm -fv`. Archives were copied in to `/opt` (`/tmp` in dind is a tmpfs: `docker cp` into it silently lands nowhere). A non-root user `pf` (uid 1000) owns the checkout, is in the `docker` group, and has passwordless sudo (README: "Run `docker`, `just` and `node` as the user who will own the checkout, and add that user to the `docker` group"; `sudo` named optional for the `/etc/hosts` line and trust store).

Stand-in for `git clone https://github.com/huh12312/PersonalFi.git` (private repo, no URL available): a local bare repo `/home/pf/srv/origin.git` whose `main` holds the previous-wave tree; the candidate tree was pushed to it as a child commit just before the upgrade, so the README's literal `git pull` fast-forwards. This substitution is a harness fact, not a finding.

## Prerequisites installed, with the README sentence that named each

| Package                                        | README sentence                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git just nodejs openssl bash coreutils` (apk) | "on Alpine, `apk add git just nodejs openssl bash coreutils` (Docker and its Compose plugin come from Docker's own packages)". Docker + Compose came with the `docker:29-dind` image; versions found: just 1.48.1 (>= 1.21), Node 24.18.1 (>= 18), Docker 29.8.2 (>= 29), git 2.54.0. |
| `sudo` (apk)                                   | table row "`sudo` (optional) ... `just harden-secrets`, the `/etc/hosts` line and importing the TLS certificate".                                                                                                                                                                     |
| `curl` (apk)                                   | NOT named by the README. Installed when step 8's `curl --cacert ...` failed with `curl: command not found` (F-13-1).                                                                                                                                                                  |

Harness-only tooling, NOT README prerequisites (it stands in for a person with a laptop and a passkey): `chromium` 152 (Alpine), `nss-tools` (certutil, for Chromium's trust store), `npm` + `puppeteer-core` (CDP client) under `/home/pf/harness` (outside the checkout), `font-noto`.

## How the passkey was done

The README's step 9/10 assume a person with a browser and an authenticator ("a passkey on this device and a second one: a phone or a security key"). Inside dind: headless Chromium driven by puppeteer-core; `WebAuthn.enable` + `WebAuthn.addVirtualAuthenticator` (ctap2, resident keys, user verification auto-approved); a second virtual authenticator (`usb` transport) stands for the security key. The CA was trusted by importing `personalfi-ca.crt` into the NSS store (`certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,'`), `personalfi.lan` was mapped to 127.0.0.1 with the README's `/etc/hosts` line. The credential (including its private key and signature counter) is exported with `WebAuthn.getCredentials` after every login and re-imported into a fresh browser, so the same passkey signs in again after the upgrade. The README gives no route to a passkey for a headless test host (F-13-7).

## Files opened (rule: archives)

- `README.md` of the candidate archive, extracted with `tar -xOf` (never unpacked on the host). Nothing else was read from either archive on the host. (The archives were unpacked only inside dind, by `tar -xf`, and run; no file in them was opened by me.)
- `RUNBOOK.md`, ONLY the `## Troubleshooting` section (extracted with `awk` from the candidate archive, 118 lines): the README sent me there ("If a step fails, the RUNBOOK's Troubleshooting section lists the failures people actually hit, with the exact error text") after `just bootstrap-user` failed with `exit code 137`. I grepped it for `137|oom|bootstrap|reissue|recovery|killed|memory` and read lines 45-60. It covers `api`/`worker` exiting 137 at boot, not `bootstrap-user` exiting 137, and has no `reissue` or recovery-code entry (F-13-4, F-13-5).
- `just --list` output (the README says "`just --list` shows them all") to look for a recovery-code recipe (none).
- The developers' checkout: not read. Written: `scripts/stranger/**` and this file only.

## Findings, run 1

Severity: H = blocks or misleads a stranger, M = surprise needing a guess, L = wording.

| #      | Sev | README line                                             | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | What I did instead                                                                                          | Fix text wanted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-13-1 | M   | 172 (step 8 check), 42-47 (package line), 38-39 (table) | `curl --cacert personalfi-ca.crt --resolve ...` -> `bash: curl: command not found`. curl is not in the table, not in any package line, and is not `coreutils`. Fresh Alpine and many minimal Debian images have no curl.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `apk add curl`                                                                                              | Add a table row: "`curl` - the TLS check in step 8 (`curl --cacert ...`) and the readiness probes" and add `curl` to each package line: `apk add git just nodejs openssl bash coreutils curl`; `pacman -S git just nodejs openssl docker docker-compose curl`; `apt install git nodejs openssl curl`.                                                                                                                                                                                                                                                                                                                                         |
| F-13-2 | L   | 159                                                     | "This writes `personalfi-ca.crt` next to the checkout." The file is written inside the checkout root (`./personalfi-ca.crt`, `wrote ./personalfi-ca.crt`), which is also where the step 8 `curl` reads it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | used `./personalfi-ca.crt`                                                                                  | "This writes `personalfi-ca.crt` in the repository root (the current directory)."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| F-13-3 | M   | 159-161                                                 | Trust-store instructions exist only for Arch (`sudo trust anchor`) and Firefox (GUI). The package list names Alpine and Debian/Ubuntu and a headless/Chromium user gets nothing: Chromium on Linux ignores the OS store and uses `~/.pki/nssdb`. I guessed `certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt` (needs `nss-tools` / `libnss3-tools`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | the NSS import                                                                                              | Add: "Debian/Ubuntu: `sudo cp personalfi-ca.crt /usr/local/share/ca-certificates/personalfi-ca.crt && sudo update-ca-certificates`; Alpine: same copy then `update-ca-certificates`. Chrome, Chromium and Edge on Linux read their own store: `certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt` (package `nss-tools` or `libnss3-tools`). macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain personalfi-ca.crt`."                                                                                                                                                   |
| F-13-4 | H   | 178-190 (step 9), 195-196 (Troubleshooting pointer)     | `just bootstrap-user` ended `error: Recipe 'bootstrap-user' failed with exit code 137` right after `deriving the key-encryption key (argon2id); this takes a few seconds...` The user row had already been created (`user created Your Name (...)` printed before), so the next run says `A user already exists: ... Pass reissue=true to mint a fresh passkey-enrolment link`. The kernel log shows the OOM kill hit the exec'd node process inside the **api container's own 1.5 GiB limit** (`memory: usage 1572864kB, limit 1572864kB ... anon-rss 1395360kB`), not host memory: the 6 GiB host was fine. Seen on 3 of 5 attempts: it passes when the api has been idle for a minute or two and fails when run immediately after `up --wait` (the api's own boot-time derivation, 1 GiB Argon2id) or right after another failed/finished run. The README never says step 9 itself derives a key in the api container; RUNBOOK Troubleshooting "api or worker exits 137 at boot" does not match (this is the recipe, not api/worker) and has no `reissue=true` entry. | waited, then `reissue=true` as the tool's own message said; once restarted the api to reset it (not README) | Under step 9: "`just bootstrap-user` derives an encryption key inside the running `api` container (about 1 GiB for a few seconds). Run it at least a minute after `up --wait`, and not while another derivation is running. If it ends with `exit code 137` the kernel OOM-killed it: the user was already created, so wait a minute and run `just bootstrap-user name=\"Your Name\" timezone=\"America/New_York\" reissue=true` to get a new link." And a RUNBOOK Troubleshooting entry with the exact error text. (The orchestrator may prefer to fix the product: run the derivation with a lock, or give the exec its own memory budget.) |
| F-13-5 | H   | 187-190                                                 | README: "Enrol at least two authenticators ... and save the ten recovery codes somewhere that is not this machine." The wizard never shows recovery codes: `Set up a passkey` -> `Add a backup passkey` (with `Skip for now`) -> `You're all set / Your passkeys are ready` -> dashboard. Settings says "Profile, security & passkeys, connections, and appearance settings land in a later work package." (also after the upgrade to the candidate). `just --list` has no recovery-code recipe. The sign-in page offers `Use a recovery code instead`, so the codes exist but there is no way to see them. Observed on the previous-wave build for a first enrolment, and on both builds for the `reissue=true` path (which also skips the backup-passkey step).                                                                                                                                                                                                                                                                                                        | nothing; no codes were obtainable                                                                           | Either the product shows the ten codes at the end of the wizard, or the README stops promising them: "Enrol a second authenticator (the wizard offers it as `Add a backup passkey`). Recovery codes are not shown in this release; ..." - orchestrator's call.                                                                                                                                                                                                                                                                                                                                                                                |
| F-13-6 | L   | 192-193 and 200-205                                     | Two UI fields the README never mentions: the sign-in page has an `Account` text input (I left it empty and the passkey signed in; a stranger cannot know it is optional). The `Add a connection` > `File import` dialog also has `Connection name` (left empty; the connection became `sample.csv`), `Type` (default depository) and `Currency` (default USD).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | left them at defaults                                                                                       | Step 10: "Leave the `Account` box empty; the passkey identifies you." Import: "Leave `Connection name`, `Type` (depository) and `Currency` (USD) at their defaults."                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F-13-7 | L   | 186-193                                                 | The README assumes a person with a browser and a passkey authenticator. A throwaway test host has neither, and the README offers no way to produce a passkey there (the LUKS sentence says a throwaway host can skip encryption but nothing says how to test the passkey). I used Chromium's CDP virtual authenticator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | virtual authenticator (see above)                                                                           | One sentence under step 9: "On a headless test host, use Chromium with a virtual authenticator (DevTools > More tools > WebAuthn > Enable virtual authenticator environment, or CDP `WebAuthn.addVirtualAuthenticator`)." Orchestrator's call whether this belongs in the README or only in the RUNBOOK/test docs.                                                                                                                                                                                                                                                                                                                            |
| F-13-8 | L   | 241-254                                                 | `git pull; just upgrade` is silent about duration and downtime: it took 199 s (image rebuild ~2.5 min, then migrate and up-to-ready 45 s) and the app is unavailable while the new containers come up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | waited                                                                                                      | "Expect three to five minutes (the images are rebuilt); the site is unavailable while the new containers start."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Observations that are not findings: the README's sizing figures held (steady state api 145 MiB + worker 130 MiB + db 83 MiB + proxy 32 MiB = about 0.4 GiB; up-to-ready 41-45 s vs "a minute or two"); the "Your first data" UI path matches the README word for word; the drill output matches ("two small pinned images", `Verdict: PASS`, report in `$DRILL_EVIDENCE_DIR`); the repository being private means a real stranger cannot run step 1's `git clone` URL without credentials (moot once public). Chromium reported 429 on a few resource requests during rapid repeated sign-ins from the harness (rate limiting, not a README matter).

## Run 1 verdict

NOT zero findings: 8 findings (F-13-1 to F-13-8; 2 High, 2 Medium, 4 Low per the table, F-13-1 and F-13-3 Medium). Requirements 1-5 were all reached despite them. Stopping per the brief; run 2 follows the fixed README archive from a fresh dind.

Dind torn down at the end of run 1 (`docker rm -fv pf-stranger-dind`).

## How to re-run (for a finisher)

Run 2 (and later runs) is one entry point that takes the archive paths and SHAs; it starts a fresh dind, follows the same phases and stops at the first failing phase (a failure is a finding):

```bash
# 1. read the FIXED README first; copy its Alpine package line into --apk (run 1 line + whatever it now adds, e.g. curl)
mkdir -p /tmp/wp913/runs/2
setsid nohup scripts/stranger/run2.sh --run 2 \
  --cand-tar /tmp/wp913/<new-candidate>.tar --cand-sha <new-candidate-sha> \
  --prev-tar /tmp/wp913/personalfi-src-previous-wave.tar --prev-sha b9fa4d2 \
  --apk "git just nodejs openssl bash coreutils curl" --teardown \
  > /tmp/wp913/runs/2/full.log 2>&1 &
# 2. poll in the foreground: timeout 590 bash -c 'until grep -qE "all phases passed|PHASE FAILED" /tmp/wp913/runs/2/full.log; do sleep 3; done'; tail /tmp/wp913/runs/2/full.log
```

Phases (functions in `scripts/stranger/phases.sh`): start_dind, prereqs, sudo, origin, install1, build, install5, up, trust, bootstrap, browser_tools, nss, enrol, firstdata, backup, drill, publish, upgrade, verify_after_upgrade. The harness automates the README's commands as run 1 used them; the stranger must re-read the fixed README and, where its text changed (new commands, new steps, a recovery-codes screen, bootstrap-user as its own container), edit the phase before the run so the harness still follows the README literally. A single phase can be re-run with `RUN=<n> scripts/stranger/run.sh <phase>`. Per-step logs: `/tmp/wp913/runs/<n>/<step>.out`; the transcript is appended here with registration tokens and age public keys redacted (`redact` in `lib.sh`). `docker cp` into dind must target `/opt`, not `/tmp` (tmpfs). Lint of the harness was checked inside dind with a stand-in eslint config (recommended + `no-console`) and gitleaks v8.30.0 (`dir` mode) because the stranger rules forbid reading the repo's own config and running `git add`.

dind torn down (2026-10-07T22:38:39Z)

## Run 2a: candidate fd02965852e767b66e390711af6a0a18f41da648 (/tmp/wp913/personalfi-src.tar), previous wave fd02965 (/tmp/wp913/personalfi-src.tar), started 2026-10-08T15:04:21Z

--- phase start_dind (2026-10-08T15:04:21Z)

### Run 2a: dind setup (2026-10-08T15:04:21Z)

#### 2026-10-08T15:04:39Z dind started

```console
$ docker run -d --name pf-stranger-dind --privileged --memory 6g --memory-swap 6g --cpus 4 -e DOCKER_TLS_CERTDIR= -v /var/lib/docker docker:29-dind
inner engine 29.8.2
Docker Compose version v5.5.1
3.24.2
8
MemTotal:       24021296 kB
6442450944
uid=0(root) gid=0(root) groups=0(root),0(root),1(bin),2(daemon),3(sys),4(adm),6(disk),10(wheel),11(floppy),20(dialout),26(tape),27(video)
```

ready after 18s

--- phase prereqs (2026-10-08T15:04:40Z)

### Run 2a: host prerequisites (README 'What you need on the host')

#### 2026-10-08T15:04:40Z prereq-apk (README's Alpine package line)

```console
$ apk add git just nodejs openssl bash coreutils curl
( 1/19) Installing readline (8.3.3-r1)
( 2/19) Installing bash (5.3.9-r1)
  Executing bash-5.3.9-r1.post-install
( 3/19) Installing coreutils-env (9.11-r0)
( 4/19) Installing coreutils-fmt (9.11-r0)
( 5/19) Installing coreutils-sha512sum (9.11-r0)
( 6/19) Installing acl-libs (2.3.2-r1)
( 7/19) Installing libattr (2.5.2-r2)
( 8/19) Installing coreutils (9.11-r0)
( 9/19) Installing curl (8.22.0-r0)
(10/19) Installing libgcc (15.2.0-r5)
(11/19) Installing just (1.48.1-r0)
(12/19) Installing libstdc++ (15.2.0-r5)
(13/19) Installing ada-libs (3.3.0-r0)
(14/19) Installing icu-data-en (78.1-r0)
  Executing icu-data-en-78.1-r0.post-install
  * If you need ICU with non-English locales and legacy charset support, install
  * package icu-data-full.
(15/19) Installing icu-libs (78.1-r0)
(16/19) Installing simdjson (4.2.4-r0)
(17/19) Installing simdutf (9.0.0-r0)
(18/19) Installing sqlite-libs (3.53.4-r0)
(19/19) Installing nodejs (24.18.1-r0)
Executing busybox-1.37.0-r31.trigger
OK: 101.3 MiB in 72 packages
```

exit=0, duration=8s

#### 2026-10-08T15:04:48Z prereq-user (create the owning user and add to docker group (README: 'add that user to the docker group'))

```console
$ getent group docker || addgroup -S docker; adduser -D -s /bin/bash pf; addgroup pf docker; ls -l /var/run/docker.sock; id pf
docker:x:2375:
srw-rw---- 1 root docker 0 Oct  8 15:04 /var/run/docker.sock
uid=1000(pf) gid=1000(pf) groups=1000(pf),2375(docker)
```

exit=0, duration=0s

#### 2026-10-08T15:04:48Z prereq-versions (versions vs README minimums (Docker 29+, just 1.21+, Node 18+))

```console
$ docker version --format 'engine {{.Server.Version}}'; docker compose version; just --version; node --version; git --version; openssl version; bash --version | head -1
engine 29.8.2
Docker Compose version v5.5.1
just 1.48.1
v24.18.1
git version 2.54.0
OpenSSL 3.5.9 29 Sep 2026 (Library: OpenSSL 3.5.9 29 Sep 2026)
GNU bash, version 5.3.9(1)-release (x86_64-alpine-linux-musl)
```

exit=0, duration=0s

--- phase sudo (2026-10-08T15:04:48Z)

#### 2026-10-08T15:04:48Z prereq-sudo (README lists sudo (optional) for the /etc/hosts line and trust-store import)

```console
$ apk add sudo && echo 'pf ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/pf && chmod 440 /etc/sudoers.d/pf
(1/1) Installing sudo (1.9.17_p2-r1)
Executing busybox-1.37.0-r31.trigger
OK: 103.0 MiB in 73 packages
```

exit=0, duration=1s

--- phase origin (2026-10-08T15:04:49Z)

#### 2026-10-08T15:04:50Z origin-prev (build the stand-in origin (previous-wave commit))

```console
$ mkdir -p origin-work srv && cd origin-work && git init -q -b main && git config user.name stranger && git config user.email s@x && tar -xf /opt/prev.tar && git add -A && git commit -q -m previous-wave && git clone -q --bare . ../srv/origin.git && cd .. && git -C srv/origin.git log --oneline | head -3
02fd343 previous-wave
```

exit=0, duration=2s

--- phase install1 (2026-10-08T15:04:52Z)

### Run 2a: README Install steps 1-3 (clone is a stand-in: the repo is private, origin = local bare repo holding the previous-wave commit)

#### 2026-10-08T15:04:52Z s1-clone (README Install 1: git clone (URL substituted by the local origin))

```console
$ git clone /home/pf/srv/origin.git personalfi && cd personalfi && git log --oneline | head -2 && ls
Cloning into 'personalfi'...
done.
Updating files:  49% (1100/2222)
Updating files:  50% (1111/2222)
Updating files:  51% (1134/2222)
Updating files:  52% (1156/2222)
Updating files:  53% (1178/2222)
Updating files:  54% (1200/2222)
Updating files:  55% (1223/2222)
Updating files:  56% (1245/2222)
Updating files:  57% (1267/2222)
Updating files:  58% (1289/2222)
Updating files:  59% (1311/2222)
Updating files:  60% (1334/2222)
Updating files:  61% (1356/2222)
Updating files:  62% (1378/2222)
Updating files:  63% (1400/2222)
Updating files:  64% (1423/2222)
Updating files:  65% (1445/2222)
Updating files:  66% (1467/2222)
Updating files:  67% (1489/2222)
Updating files:  68% (1511/2222)
Updating files:  69% (1534/2222)
Updating files:  70% (1556/2222)
Updating files:  71% (1578/2222)
Updating files:  72% (1600/2222)
Updating files:  73% (1623/2222)
Updating files:  74% (1645/2222)
Updating files:  75% (1667/2222)
Updating files:  76% (1689/2222)
Updating files:  77% (1711/2222)
Updating files:  78% (1734/2222)
Updating files:  79% (1756/2222)
Updating files:  80% (1778/2222)
Updating files:  81% (1800/2222)
Updating files:  82% (1823/2222)
Updating files:  83% (1845/2222)
Updating files:  84% (1867/2222)
Updating files:  85% (1889/2222)
Updating files:  86% (1911/2222)
Updating files:  87% (1934/2222)
Updating files:  88% (1956/2222)
Updating files:  89% (1978/2222)
Updating files:  90% (2000/2222)
Updating files:  91% (2023/2222)
Updating files:  92% (2045/2222)
Updating files:  93% (2067/2222)
Updating files:  94% (2089/2222)
Updating files:  95% (2111/2222)
Updating files:  96% (2134/2222)
Updating files:  97% (2156/2222)
Updating files:  98% (2178/2222)
Updating files:  99% (2200/2222)
Updating files: 100% (2222/2222)
Updating files: 100% (2222/2222), done.
02fd343 previous-wave
LICENSE
README.md
RUNBOOK.md
THIRD_PARTY.md
apps
compose.dev.yml
compose.override.example.yml
compose.yml
docker
docs
eslint.config.js
justfile
lefthook.yml
licenses.policy.yaml
package.json
packages
pnpm-lock.yaml
pnpm-workspace.yaml
renovate.json
scripts
tsconfig.base.json
tsconfig.json
vitest.config.ts
```

exit=0, duration=2s

#### 2026-10-08T15:04:54Z s2-env (README Install 2: cp .env.example .env)

```console
$ cp .env.example .env && grep -v '^#' .env | grep -v '^$'
NODE_ENV=development
LOG_LEVEL=info
LOG_PRETTY=true
HTTP_HOST=127.0.0.1
HTTP_PORT=8080
BASE_URL=http://127.0.0.1:8080
TRUST_PROXY=1
PUBLIC_HOST=personalfi.lan
BIND_ADDRESS=127.0.0.1
DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev
DATABASE_POOL_MAX=10
DATABASE_STATEMENT_TIMEOUT_MS=30000
SECRETS_DIR=./secrets
DEMO_MODE=false
```

exit=0, duration=0s

#### 2026-10-08T15:04:54Z s3-pg (README Install 3: just gen-pg-secrets)

```console
$ just gen-pg-secrets
wrote /home/pf/personalfi/secrets/pg_password and /home/pf/personalfi/secrets/database_url
run 'just harden-secrets' (needs sudo) to take them to 0400 owned by the consuming uid
```

exit=0, duration=0s

#### 2026-10-08T15:04:54Z s3-mk (README Install 3: just gen-master-key)

```console
$ just gen-master-key; ls -la secrets
wrote /home/pf/personalfi/secrets/master_key — back it up somewhere that is not this host
run 'just harden-secrets' (needs sudo) to take it to 0400 owned by uid 10001
total 20
drwx--S---  2 pf pf 4096 Oct  8 15:04 .
drwxr-sr-x 10 pf pf 4096 Oct  8 15:04 ..
-r--r--r--  1 pf pf  106 Oct  8 15:04 database_url
-r--r--r--  1 pf pf   64 Oct  8 15:04 master_key
-r--r--r--  1 pf pf   65 Oct  8 15:04 pg_password
```

exit=0, duration=0s

--- phase build (2026-10-08T15:04:54Z)

### Run 2a: README Install step 4 (just build) - started 2026-10-08T15:04:54Z

#### 2026-10-08T15:04:54Z s4-build (README Install 4: just build (first build; README: several minutes))

```console
$ just build 2>&1 | tail -n 400
#29 exporting layers 13.2s done
#29 exporting manifest sha256:35262ccf6b3b1ca01ae9377ae80e2bfc2b7c341a184f254264baee828e01b6ac 1.9s done
#29 exporting config sha256:257bf49f6080fdfc224fb77f96a9404e8ba87f5babc1178e7230d074c96524df 2.6s done
#29 exporting attestation manifest sha256:5bd606b44def5fa4599b3fa62ed0b1790605bf08199aa48e9be52c43e1b33e1f
#29 ...

#30 [proxy web-build 5/6] RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked     pnpm install --frozen-lockfile --filter '@app/web...'
#30 20.43 Progress: resolved 719, reused 0, downloaded 702, added 687
#30 21.86 Progress: resolved 719, reused 0, downloaded 702, added 692
#30 23.05 Progress: resolved 719, reused 0, downloaded 702, added 699
#30 25.29 Progress: resolved 719, reused 0, downloaded 702, added 704
#30 26.80 Progress: resolved 719, reused 0, downloaded 707, added 704
#30 ...

#29 [backup] exporting to image
#29 exporting attestation manifest sha256:5bd606b44def5fa4599b3fa62ed0b1790605bf08199aa48e9be52c43e1b33e1f 6.4s done
#29 exporting manifest list sha256:355ed756b9b755b2e95dc73903aeb2b4d22ab08e0f6ee95f5a107e40873d22b9 2.7s done
#29 naming to docker.io/personalfi/backup:dev
#29 naming to docker.io/personalfi/backup:dev 0.7s done
#29 unpacking to docker.io/personalfi/backup:dev
#29 ...

#30 [proxy web-build 5/6] RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked     pnpm install --frozen-lockfile --filter '@app/web...'
#30 29.33 Progress: resolved 719, reused 0, downloaded 717, added 710
#30 29.95 Packages: +719
#30 29.95 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
#30 30.02 Progress: resolved 719, reused 0, downloaded 717, added 719, done
#30 32.05
#30 32.05 devDependencies:
#30 32.05 + @eslint/js 10.0.1
... [340 lines omitted; full log /tmp/wp913/runs/2a/s4-build.out]
#47 ...

#44 [worker] exporting to image
#44 unpacking to docker.io/personalfi/api:dev 17.6s done
#44 DONE 24.1s

#47 [api] exporting to image
#47 ...

#46 [migrator] exporting to image
#46 unpacking to docker.io/personalfi/api:dev 20.8s done
#46 DONE 26.3s

#47 [api] exporting to image
#47 unpacking to docker.io/personalfi/api:dev 22.2s done
#47 DONE 26.4s

#48 [worker] resolving provenance for metadata file
#48 DONE 0.1s

#49 [migrator] resolving provenance for metadata file
#49 DONE 0.1s

#50 [api] resolving provenance for metadata file
#50 DONE 0.0s
 Image personalfi/backup:dev Built
 Image personalfi/api:dev Built
 Image personalfi/proxy:dev Built
 Image personalfi/api:dev Built
 Image personalfi/api:dev Built
```

exit=0, duration=235s

--- phase install5 (2026-10-08T15:08:49Z)

#### 2026-10-08T15:08:49Z s5-age (README Install 5: backup keypair (verbatim))

```console
$ (umask 077; docker run --rm --entrypoint age-keygen personalfi/backup:dev > "$HOME/personalfi-age-identity.txt")
grep '^# public key:' "$HOME/personalfi-age-identity.txt" | cut -d' ' -f4 > secrets/age_recipient
chmod 444 secrets/age_recipient
cat secrets/age_recipient; ls -la secrets $HOME/personalfi-age-identity.txt
Public key: age1<redacted>
age1<redacted>
-rw------- 1 pf pf  184 Oct  8 15:09 /home/pf/personalfi-age-identity.txt

secrets:
total 24
drwx--S---  2 pf pf 4096 Oct  8 15:09 .
drwxr-sr-x 10 pf pf 4096 Oct  8 15:04 ..
-r--r--r--  1 pf pf   63 Oct  8 15:09 age_recipient
-r--r--r--  1 pf pf  106 Oct  8 15:04 database_url
-r--r--r--  1 pf pf   64 Oct  8 15:04 master_key
-r--r--r--  1 pf pf   65 Oct  8 15:04 pg_password
```

exit=0, duration=12s

#### 2026-10-08T15:09:01Z s6-placeholders (README Install 6: just secrets-placeholders)

```console
$ just secrets-placeholders; ls -la secrets
bash scripts/secrets-placeholders.sh
secrets-placeholders: set /home/pf/personalfi/secrets to 0700
secrets-placeholders: created 14 empty optional placeholder(s): advisor_token_secret b2_application_key b2_key_id coinbase_key_name coinbase_private_key coingecko_api_key etherscan_api_key fred_api_key migrator_database_url openfigi_api_key plaid_client_id plaid_env plaid_secret tiingo_api_key (0 already present, left untouched)
total 24
drwx--S---  2 pf pf 4096 Oct  8 15:09 .
drwxr-sr-x 10 pf pf 4096 Oct  8 15:04 ..
-r--r--r--  1 pf pf    0 Oct  8 15:09 advisor_token_secret
-r--r--r--  1 pf pf   63 Oct  8 15:09 age_recipient
-r--r--r--  1 pf pf    0 Oct  8 15:09 b2_application_key
-r--r--r--  1 pf pf    0 Oct  8 15:09 b2_key_id
-r--r--r--  1 pf pf    0 Oct  8 15:09 coinbase_key_name
-r--r--r--  1 pf pf    0 Oct  8 15:09 coinbase_private_key
-r--r--r--  1 pf pf    0 Oct  8 15:09 coingecko_api_key
-r--r--r--  1 pf pf  106 Oct  8 15:04 database_url
-r--r--r--  1 pf pf    0 Oct  8 15:09 etherscan_api_key
-r--r--r--  1 pf pf    0 Oct  8 15:09 fred_api_key
-r--r--r--  1 pf pf   64 Oct  8 15:04 master_key
-r--r--r--  1 pf pf    0 Oct  8 15:09 migrator_database_url
-r--r--r--  1 pf pf    0 Oct  8 15:09 openfigi_api_key
-r--r--r--  1 pf pf   65 Oct  8 15:04 pg_password
-r--r--r--  1 pf pf    0 Oct  8 15:09 plaid_client_id
-r--r--r--  1 pf pf    0 Oct  8 15:09 plaid_env
-r--r--r--  1 pf pf    0 Oct  8 15:09 plaid_secret
-r--r--r--  1 pf pf    0 Oct  8 15:09 tiingo_api_key
```

exit=0, duration=0s

--- phase up (2026-10-08T15:09:01Z)

### Run 2a: README Install step 7 (up --wait) started 2026-10-08T15:09:01Z

#### 2026-10-08T15:09:01Z s7-up (README Install 7: docker compose up -d --wait --wait-timeout 900)

```console
$ docker compose up -d --wait --wait-timeout 900 2>&1 | tail -n 60
 Container personalfi-pre-migrate-backup-1 Creating
 Container personalfi-pre-migrate-backup-1 Created
 Container personalfi-migrator-1 Creating
 Container personalfi-migrator-1 Created
 Container personalfi-worker-1 Creating
 Container personalfi-api-1 Creating
 Container personalfi-backup-1 Creating
 Container personalfi-backup-1 Created
 Container personalfi-worker-1 Created
 Container personalfi-api-1 Created
 Container personalfi-proxy-1 Creating
 Container personalfi-proxy-1 Created
 Container personalfi-db-1 Starting
 Container personalfi-db-1 Started
 Container personalfi-db-1 Waiting
 Container personalfi-db-1 Healthy
 Container personalfi-pre-migrate-backup-1 Starting
 Container personalfi-pre-migrate-backup-1 Started
 Container personalfi-db-1 Waiting
 Container personalfi-pre-migrate-backup-1 Waiting
 Container personalfi-pre-migrate-backup-1 Exited
 Container personalfi-db-1 Healthy
 Container personalfi-migrator-1 Starting
 Container personalfi-migrator-1 Started
 Container personalfi-db-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-db-1 Healthy
 Container personalfi-db-1 Healthy
 Container personalfi-db-1 Healthy
 Container personalfi-migrator-1 Exited
 Container personalfi-migrator-1 Exited
 Container personalfi-migrator-1 Exited
 Container personalfi-worker-1 Starting
 Container personalfi-backup-1 Starting
 Container personalfi-api-1 Starting
 Container personalfi-worker-1 Started
 Container personalfi-backup-1 Started
 Container personalfi-api-1 Started
 Container personalfi-api-1 Waiting
 Container personalfi-api-1 Healthy
 Container personalfi-proxy-1 Starting
 Container personalfi-proxy-1 Started
 Container personalfi-api-1 Waiting
 Container personalfi-backup-1 Waiting
 Container personalfi-proxy-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-worker-1 Waiting
 Container personalfi-pre-migrate-backup-1 Waiting
 Container personalfi-backup-1 Healthy
 Container personalfi-pre-migrate-backup-1 Exited
 Container personalfi-db-1 Healthy
 Container personalfi-migrator-1 Exited
 Container personalfi-worker-1 Healthy
 Container personalfi-api-1 Healthy
 Container personalfi-proxy-1 Healthy
```

exit=0, duration=47s

#### 2026-10-08T15:09:48Z s7-ps (README Install 7: docker compose ps)

```console
$ docker compose ps
NAME                  IMAGE                                                                                              COMMAND                  SERVICE   CREATED          STATUS                    PORTS
personalfi-api-1      personalfi/api:dev                                                                                 "/sbin/tini -- node …"   api       20 seconds ago   Up 11 seconds (healthy)   8080/tcp
personalfi-backup-1   personalfi/backup:dev                                                                              "/sbin/tini -- /usr/…"   backup    20 seconds ago   Up 11 seconds (healthy)
personalfi-db-1       postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2   "docker-entrypoint.s…"   db        30 seconds ago   Up 20 seconds (healthy)   5432/tcp
personalfi-proxy-1    personalfi/proxy:dev                                                                               "caddy run --config …"   proxy     20 seconds ago   Up 5 seconds (healthy)    80/tcp, 443/tcp, 2019/tcp, 443/udp, 127.0.0.1:80->8080/tcp, 127.0.0.1:443->8443/tcp
personalfi-worker-1   personalfi/api:dev                                                                                 "/sbin/tini -- node …"   worker    20 seconds ago   Up 11 seconds (healthy)   8080/tcp
```

exit=0, duration=0s

#### 2026-10-08T15:09:48Z s7-ready (README Install 7: readiness from inside the api container)

```console
$ docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(async r => console.log(r.status, await r.text()))"
200 {"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"0","maxLagEvents":0,"oldestUnprocessedAgeSeconds":null,"failedConsumers":[]},"queue":{"pending":0,"running":0,"dead":0,"stalled":0,"oldestPendingAgeSeconds":null}}
```

exit=0, duration=1s

--- phase browser_tools (2026-10-08T15:09:49Z)

Harness-only tooling (not a README prerequisite): chromium, nss-tools (certutil), npm + puppeteer-core in /home/pf/harness

#### 2026-10-08T15:09:49Z h-apk (harness: headless browser)

```console
$ apk add chromium nss-tools npm font-noto 2>&1 | tail -3; chromium --version
Executing gdk-pixbuf-2.44.7-r1.trigger
Executing gtk+3.0-3.24.52-r0.trigger
OK: 865.6 MiB in 245 packages
Chromium 152.0.7977.82 Alpine Linux
```

exit=0, duration=28s

#### 2026-10-08T15:10:17Z h-npm (harness: puppeteer-core (CDP client))

```console
$ mkdir -p harness && cd harness && npm init -y >/dev/null && npm install puppeteer-core 2>&1 | tail -3
  run `npm fund` for details

found 0 vulnerabilities
```

exit=0, duration=10s

--- phase trust (2026-10-08T15:10:27Z)

### Run 2a: README Install step 8 (trust the TLS certificate)

#### 2026-10-08T15:10:27Z s8-trustca (README Install 8: just trust-ca)

```console
$ just trust-ca; ls -la personalfi-ca.crt
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./personalfi-ca.crt
 personalfi-proxy-1 Copying personalfi-proxy-1:/data/caddy/pki/authorities/local/root.crt to ./personalfi-ca.crt
 personalfi-proxy-1 Copied personalfi-proxy-1:/data/caddy/pki/authorities/local/root.crt to ./personalfi-ca.crt
wrote ./personalfi-ca.crt — import it into your OS/browser trust store (see RUNBOOK.md)
-rw------- 1 pf pf 627 Oct  8 15:09 personalfi-ca.crt
```

exit=0, duration=0s

#### 2026-10-08T15:10:27Z s8-hosts (README Install 8: /etc/hosts line (verbatim))

```console
$ echo "127.0.0.1 personalfi.lan" | sudo tee -a /etc/hosts
127.0.0.1 personalfi.lan
```

exit=0, duration=0s

#### 2026-10-08T15:10:27Z s8-sys-trust (README Install 8: Debian, Ubuntu or Alpine system store line (verbatim))

```console
$ sudo cp personalfi-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
```

exit=0, duration=1s

#### 2026-10-08T15:10:28Z s8-curl (README Install 8: curl chain check (verbatim))

````console
$ curl --cacert personalfi-ca.crt --resolve personalfi.lan:443:127.0.0.1 https://personalfi.lan/api/ready
  % Total    % Received % Xferd  Average Speed  Time    Time    Time   Current
                                 Dload  Upload  Total   Spent   Left   Speed

  0      0   0      0   0      0      0      0                              0
100    247 100    247   0      0   7270      0                              0
100    247 100    247   0      0   7241      0                              0
100    247 100    247   0      0   7212      0                              0
{"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"0","maxLagEvents":0,"oldestUnprocessedAgeSeconds":null,"failedConsumers":[]},"queue":{"pending":0,"running":0,"dead":0,"stalled":0,"oldestPendingAgeSeconds":null}}```

exit=0, duration=0s

--- phase nss (2026-10-08T15:10:28Z)

README Install 8: Chrome/Chromium on Linux line, verbatim (certutil from nss-tools, installed with the harness browser)

#### 2026-10-08T15:10:28Z  h-nss  (import the CA into ~/.pki/nssdb for Chromium)

```console
$ certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt && certutil -d sql:$HOME/.pki/nssdb -L
certutil: function failed: SEC_ERROR_BAD_DATABASE: security library: bad database.
````

exit=255, duration=0s

PHASE FAILED: nss (see /tmp/wp913/runs/2a) - stopping; this is a finding to record.

#### 2026-10-08T15:10:39Z h-nss-init (workaround (NOT README): create the NSS db first)

```console
$ mkdir -p $HOME/.pki/nssdb && certutil -d sql:$HOME/.pki/nssdb -N --empty-password
```

exit=0, duration=0s

README Install 8: Chrome/Chromium on Linux line, verbatim (certutil from nss-tools, installed with the harness browser)

#### 2026-10-08T15:10:39Z h-nss (import the CA into ~/.pki/nssdb for Chromium)

```console
$ certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt && certutil -d sql:$HOME/.pki/nssdb -L

Certificate Nickname                                         Trust Attributes
                                                             SSL,S/MIME,JAR/XPI

personalfi                                                   C,,
```

exit=0, duration=0s

### Run 2a: README Install step 9 (create account)

#### 2026-10-08T15:10:39Z s9-bootstrap (README Install 9: just bootstrap-user (verbatim))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York"
bootstrap-user: running in its own one-shot container (the stack is up)
 Container personalfi-api-run-f6f40e7b4135 Creating
 Container personalfi-api-run-f6f40e7b4135 Created
(node:1) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:1) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user created      Your Name (01a11c11-3314-731f-ad0c-215200e9aefa)
time zone         America/New_York
taxonomy          153 categories seeded
advisors          40 manifests registered
schedules         categorization.retrain_weekly, notifications.deliver, notifications.digest, integrations.price_refresh, planning.net_worth_snapshot
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5615 ms · KEK generation 1

Enrol your first passkey within 60 minutes:

  https://personalfi.lan/register#token=<redacted>

  token only: <redacted>
  expires:    2026-10-08T16:11:03.729Z

Single-use. It is stored only as a SHA-256 digest, so this is the one and only
time it is readable — and it is not in any log. Enrol a second authenticator
and print your ten recovery codes straight after: one passkey on one device is
a self-inflicted denial of service.
```

exit=0, duration=25s

### Run 2a: README Install step 9-10 (browser: enrol, then sign in)

[resp] 200 GET https://personalfi.lan/api/auth/unlock-state
[resp] 200 POST https://personalfi.lan/api/auth/register/options
[resp] 200 POST https://personalfi.lan/api/auth/register/verify
credentials saved: 1
--- reg-step2: https://personalfi.lan/register#token=<redacted> | Set up a passkey · PersonalFi
Add a backup passkey

A phone, a security key, or another browser — so one lost device can’t lock you out.

Name this passkeyAdd passkeySkip for now
--- interactive:
input[text] name= id=friendly-name aria= text=Virtual passkey (this device)
button[submit] name= id= aria= text=Add passkey
button[button] name= id= aria= text=Skip for now
--- screenshot /home/pf/harness/shots/reg-step2.png
[resp] 200 POST https://personalfi.lan/api/auth/register/options
[resp] 200 POST https://personalfi.lan/api/auth/register/verify
credentials saved: 2
--- reg-step3: https://personalfi.lan/register#token=<redacted> | Set up a passkey · PersonalFi
Save your recovery codes

If you lose every passkey, a recovery code is the way back in.

Create my recovery codes
Skip for now — create them later in Settings › Security
--- interactive:
button[button] name= id= aria= text=Create my recovery codes
button[button] name= id= aria= text=Skip for now — create them later in Settings › Security
--- screenshot /home/pf/harness/shots/reg-step3.png
--- reg-recovery: https://personalfi.lan/register#token=<redacted> | Set up a passkey · PersonalFi
Save your recovery codes

If you lose every passkey, a recovery code is the way back in.

Create my recovery codes
Skip for now — create them later in Settings › Security
--- interactive:
button[button] name= id= aria= text=Create my recovery codes
button[button] name= id= aria= text=Skip for now — create them later in Settings › Security
--- screenshot /home/pf/harness/shots/reg-recovery.png
file:///home/pf/harness/node_modules/puppeteer-core/lib/puppeteer/util/assert.js:15
throw new Error(message);
^

Error: No element found for selector: input[type=checkbox],[role=checkbox]
at assert (file:///home/pf/harness/node_modules/puppeteer-core/lib/puppeteer/util/assert.js:15:15)
at CdpFrame.click (file:///home/pf/harness/node_modules/puppeteer-core/lib/puppeteer/api/Frame.js:753:17)
at async file:///home/pf/harness/browser/register.mjs:47:3

Node.js v24.18.1

#### 2026-10-08T15:11:33Z h-reissue (harness: reissue (wizard died mid-way on my script))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York" reissue=true
bootstrap-user: running in its own one-shot container (the stack is up)
 Container personalfi-api-run-26cd00fbe274 Creating
 Container personalfi-api-run-26cd00fbe274 Created
(node:1) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:1) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user              Your Name (01a11c11-3314-731f-ad0c-215200e9aefa)
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5525 ms · KEK generation 1

Enrol your first passkey within 60 minutes:

  https://personalfi.lan/register#token=<redacted>

  token only: <redacted>
  expires:    2026-10-08T16:11:45.325Z

Single-use. It is stored only as a SHA-256 digest, so this is the one and only
time it is readable — and it is not in any log. Enrol a second authenticator
and print your ten recovery codes straight after: one passkey on one device is
a self-inflicted denial of service.
```

exit=0, duration=12s

### Run 2a: README Install step 9-10 (browser: enrol, then sign in)

[resp] 200 GET https://personalfi.lan/api/auth/unlock-state
[resp] 200 POST https://personalfi.lan/api/auth/register/options
[resp] 200 POST https://personalfi.lan/api/auth/register/verify
credentials saved: 1
--- reg-step2: https://personalfi.lan/register#token=<redacted> | Set up a passkey · PersonalFi
Save your recovery codes

If you lose every passkey, a recovery code is the way back in.

Create my recovery codes
Skip for now — create them later in Settings › Security
--- interactive:
button[button] name= id= aria= text=Create my recovery codes
button[button] name= id= aria= text=Skip for now — create them later in Settings › Security
--- screenshot /home/pf/harness/shots/reg-step2.png
[resp] 200 POST https://personalfi.lan/api/auth/recovery-codes
--- reg-recovery: https://personalfi.lan/register#token=<redacted> | Set up a passkey · PersonalFi
Save your recovery codes

If you lose every passkey, a recovery code is the way back in.

Each code works once, in place of a passkey, if you lose every device. They are shown only now and cannot be shown again. Keep them somewhere that is not this computer.

<code>
<code>
<code>
<code>
<code>
<code>
<code>
<code>
<code>
<code>
Copy codes
Download as a text file
I have saved these codes somewhere safe
Continue
Skip for now — create them later in Settings › Security
--- interactive:
button[button] name= id= aria= text=Copy codes
button[button] name= id= aria= text=Download as a text file
input[checkbox] name= id= aria= text=on
button[button] name= id= aria= text=Continue
button[button] name= id= aria= text=Skip for now — create them later in Settings › Security
--- screenshot /home/pf/harness/shots/reg-recovery.png
--- [9 code-like tokens masked on this page]
--- reg-after-recovery: https://personalfi.lan/register#token=<redacted> | Set up a passkey · PersonalFi
You’re all set

Your passkeys are ready.

Continue to PersonalFi
--- interactive:
button[button] name= id= aria= text=Continue to PersonalFi
--- screenshot /home/pf/harness/shots/reg-after-recovery.png
[resp] 200 GET https://personalfi.lan/api/auth/session
[console.error] Failed to load resource: the server responded with a status of 404 ()
[console.error] Failed to load resource: the server responded with a status of 404 ()
--- reg-step4: https://personalfi.lan/ | Dashboard · PersonalFi
Skip to main content

### Run 2a: README 'Your first data' step 1 (sample CSV; browser part is browser/import.mjs)

#### 2026-10-08T15:12:32Z d1-sample (README Your first data 1: sample.csv (verbatim))

```console
$ printf 'Date,Description,Amount\n2026-09-01,Coffee shop,-4.50\n2026-09-02,Payroll,2500.00\n2026-09-03,Grocery store,-62.18\n' > sample.csv; cat sample.csv
Date,Description,Amount
2026-09-01,Coffee shop,-4.50
2026-09-02,Payroll,2500.00
2026-09-03,Grocery store,-62.18
```

exit=0, duration=0s

### Run 2a: README 'Your first data' step 2 (backup)

#### 2026-10-08T15:12:41Z d2-backup (README Your first data 2: just backup)

```console
$ just backup
docker compose exec backup /usr/local/bin/backup.sh
backup: dumping personalfi@db ...
backup: verified 586040 bytes, 1119 restorable object(s), schema_migrations present
backup: wrote /backups/personalfi-20261008T151241Z.dump.age (586368 bytes)
backup: pruning entries older than 30 day(s) locally
backup: RCLONE_REMOTE not set; local-only backup (see RUNBOOK.md to enable B2)
backup: complete
```

exit=0, duration=0s

### Run 2a: README 'Your first data' step 3 (restore drill) started 2026-10-08T15:12:41Z

#### 2026-10-08T15:12:41Z d3-drill (README Your first data 3: restore drill (verbatim))

```console
$ export AGE_IDENTITY_FILE="$HOME/personalfi-age-identity.txt"
export DRILL_EVIDENCE_DIR="$HOME/personalfi-drills"
just restore-drill
Unable to find image 'alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b' locally
docker.io/library/alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b: Pulling from library/alpine
56dceff11b33: Download complete
f5124fb579e2: Download complete
Digest: sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
Status: Downloaded newer image for alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
restore-drill: starting scratch db (restore-drill-db-6890 on personalfi_backend) ...
restore-drill: waiting for scratch db to accept connections ....ok
restore-drill: restoring /backups/personalfi-20261008T151241Z.dump.age (586368 bytes)
restore: decrypting /backups/personalfi-20261008T151241Z.dump.age
restore: target personalfi_restore_drill@restore-drill-db; --clean --if-exists will DROP and recreate these:
restore: archive contains 1119 restorable object(s)
restore: restoring into personalfi_restore_drill@restore-drill-db (--clean --if-exists --no-owner)
restore: complete
restore-drill: WARNING: the live database holds no plan scenario, so this drill cannot see a backup that fails to restore one (F-94-6). Save a plan on the Plan screen, run `just backup`, then drill again.
restore-drill: booting a throwaway api container against the restored db ...
# Restore drill — 20261008T151241Z

**Verdict: PASS**

- Backup restored: `/backups/personalfi-20261008T151241Z.dump.age` (586368 encrypted bytes)
- Restored db table count: 101
- Restored db schema_migrations max id: 0040
- Live db table count: 101
- Live db schema_migrations max id: 0040
- plan_scenarios rows, restored / live: 0 / 0
- WARNING: the live database holds no plan scenario, so this drill cannot see a backup that fails to restore one (F-94-6). Save a plan on the Plan screen, run `just backup`, then drill again.
- API /ready against restored db: pass (200 from /ready)

All assertions held: restored tables > 0, restored == live, schema_migrations agree,
and the API served /ready from the restored database. `just restore-drill` exited 0.
restore-drill: wrote /home/pf/personalfi-drills/restore-drill-20261008.md
```

exit=0, duration=28s

### Run 2a: README 'Your first data' step 1 (sample CSV; browser part is browser/import.mjs)

#### 2026-10-08T15:13:45Z d1-sample (README Your first data 1: sample.csv (verbatim))

```console
$ printf 'Date,Description,Amount\n2026-09-01,Coffee shop,-4.50\n2026-09-02,Payroll,2500.00\n2026-09-03,Grocery store,-62.18\n' > sample.csv; cat sample.csv
Date,Description,Amount
2026-09-01,Coffee shop,-4.50
2026-09-02,Payroll,2500.00
2026-09-03,Grocery store,-62.18
```

exit=0, duration=0s

## Run 2: candidate fd02965852e767b66e390711af6a0a18f41da648 (/tmp/wp913/personalfi-src.tar), previous wave 4f0c7b9084071ec75a97395a9acb61e879a940c9 (/tmp/wp913/personalfi-src-previous-wave.tar), started 2026-10-08T15:16:09Z

--- phase start_dind (2026-10-08T15:16:09Z)

### Run 2: dind setup (2026-10-08T15:16:09Z)

#### 2026-10-08T15:16:44Z dind started

```console
$ docker run -d --name pf-stranger-dind --privileged --memory 6g --memory-swap 6g --cpus 4 -e DOCKER_TLS_CERTDIR= -v /var/lib/docker docker:29-dind
inner engine 29.8.2
Docker Compose version v5.5.1
3.24.2
8
MemTotal:       24021296 kB
6442450944
uid=0(root) gid=0(root) groups=0(root),0(root),1(bin),2(daemon),3(sys),4(adm),6(disk),10(wheel),11(floppy),20(dialout),26(tape),27(video)
```

ready after 26s

--- phase prereqs (2026-10-08T15:16:45Z)

### Run 2: host prerequisites (README 'What you need on the host')

#### 2026-10-08T15:16:45Z prereq-apk (README's Alpine package line)

```console
$ apk add git just nodejs openssl bash coreutils curl
( 1/19) Installing readline (8.3.3-r1)
( 2/19) Installing bash (5.3.9-r1)
  Executing bash-5.3.9-r1.post-install
( 3/19) Installing coreutils-env (9.11-r0)
( 4/19) Installing coreutils-fmt (9.11-r0)
( 5/19) Installing coreutils-sha512sum (9.11-r0)
( 6/19) Installing acl-libs (2.3.2-r1)
( 7/19) Installing libattr (2.5.2-r2)
( 8/19) Installing coreutils (9.11-r0)
( 9/19) Installing curl (8.22.0-r0)
(10/19) Installing libgcc (15.2.0-r5)
(11/19) Installing just (1.48.1-r0)
(12/19) Installing libstdc++ (15.2.0-r5)
(13/19) Installing ada-libs (3.3.0-r0)
(14/19) Installing icu-data-en (78.1-r0)
  Executing icu-data-en-78.1-r0.post-install
  * If you need ICU with non-English locales and legacy charset support, install
  * package icu-data-full.
(15/19) Installing icu-libs (78.1-r0)
(16/19) Installing simdjson (4.2.4-r0)
(17/19) Installing simdutf (9.0.0-r0)
(18/19) Installing sqlite-libs (3.53.4-r0)
(19/19) Installing nodejs (24.18.1-r0)
Executing busybox-1.37.0-r31.trigger
OK: 101.3 MiB in 72 packages
```

exit=0, duration=6s

#### 2026-10-08T15:16:51Z prereq-user (create the owning user and add to docker group (README: 'add that user to the docker group'))

```console
$ getent group docker || addgroup -S docker; adduser -D -s /bin/bash pf; addgroup pf docker; ls -l /var/run/docker.sock; id pf
docker:x:2375:
srw-rw---- 1 root docker 0 Oct  8 15:16 /var/run/docker.sock
uid=1000(pf) gid=1000(pf) groups=1000(pf),2375(docker)
```

exit=0, duration=0s

#### 2026-10-08T15:16:51Z prereq-versions (versions vs README minimums (Docker 29+, just 1.21+, Node 18+))

```console
$ docker version --format 'engine {{.Server.Version}}'; docker compose version; just --version; node --version; git --version; openssl version; bash --version | head -1
engine 29.8.2
Docker Compose version v5.5.1
just 1.48.1
v24.18.1
git version 2.54.0
OpenSSL 3.5.9 29 Sep 2026 (Library: OpenSSL 3.5.9 29 Sep 2026)
GNU bash, version 5.3.9(1)-release (x86_64-alpine-linux-musl)
```

exit=0, duration=1s

--- phase sudo (2026-10-08T15:16:52Z)

#### 2026-10-08T15:16:52Z prereq-sudo (README lists sudo (optional) for the /etc/hosts line and trust-store import)

```console
$ apk add sudo && echo 'pf ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/pf && chmod 440 /etc/sudoers.d/pf
(1/1) Installing sudo (1.9.17_p2-r1)
Executing busybox-1.37.0-r31.trigger
OK: 103.0 MiB in 73 packages
```

exit=0, duration=1s

--- phase origin (2026-10-08T15:16:53Z)

#### 2026-10-08T15:16:54Z origin-prev (build the stand-in origin (previous-wave commit))

```console
$ mkdir -p origin-work srv && cd origin-work && git init -q -b main && git config user.name stranger && git config user.email s@x && tar -xf /opt/prev.tar && git add -A && git commit -q -m previous-wave && git clone -q --bare . ../srv/origin.git && cd .. && git -C srv/origin.git log --oneline | head -3
c438c30 previous-wave
```

exit=0, duration=2s

--- phase install1 (2026-10-08T15:16:56Z)

### Run 2: README Install steps 1-3 (clone is a stand-in: the repo is private, origin = local bare repo holding the previous-wave commit)

#### 2026-10-08T15:16:56Z s1-clone (README Install 1: git clone (URL substituted by the local origin))

```console
$ git clone /home/pf/srv/origin.git personalfi && cd personalfi && git log --oneline | head -2 && ls
Cloning into 'personalfi'...
done.
Updating files:  59% (1309/2196)
Updating files:  60% (1318/2196)
Updating files:  61% (1340/2196)
Updating files:  62% (1362/2196)
Updating files:  63% (1384/2196)
Updating files:  64% (1406/2196)
Updating files:  65% (1428/2196)
Updating files:  66% (1450/2196)
Updating files:  67% (1472/2196)
Updating files:  68% (1494/2196)
Updating files:  69% (1516/2196)
Updating files:  70% (1538/2196)
Updating files:  71% (1560/2196)
Updating files:  72% (1582/2196)
Updating files:  73% (1604/2196)
Updating files:  74% (1626/2196)
Updating files:  75% (1647/2196)
Updating files:  76% (1669/2196)
Updating files:  77% (1691/2196)
Updating files:  78% (1713/2196)
Updating files:  79% (1735/2196)
Updating files:  80% (1757/2196)
Updating files:  81% (1779/2196)
Updating files:  82% (1801/2196)
Updating files:  83% (1823/2196)
Updating files:  84% (1845/2196)
Updating files:  85% (1867/2196)
Updating files:  86% (1889/2196)
Updating files:  87% (1911/2196)
Updating files:  88% (1933/2196)
Updating files:  89% (1955/2196)
Updating files:  90% (1977/2196)
Updating files:  91% (1999/2196)
Updating files:  92% (2021/2196)
Updating files:  93% (2043/2196)
Updating files:  94% (2065/2196)
Updating files:  95% (2087/2196)
Updating files:  96% (2109/2196)
Updating files:  97% (2131/2196)
Updating files:  98% (2153/2196)
Updating files:  99% (2175/2196)
Updating files: 100% (2196/2196)
Updating files: 100% (2196/2196), done.
c438c30 previous-wave
LICENSE
README.md
RUNBOOK.md
THIRD_PARTY.md
apps
compose.dev.yml
compose.override.example.yml
compose.yml
docker
docs
eslint.config.js
justfile
lefthook.yml
licenses.policy.yaml
package.json
packages
pnpm-lock.yaml
pnpm-workspace.yaml
renovate.json
scripts
tsconfig.base.json
tsconfig.json
vitest.config.ts
```

exit=0, duration=2s

#### 2026-10-08T15:16:58Z s2-env (README Install 2: cp .env.example .env)

```console
$ cp .env.example .env && grep -v '^#' .env | grep -v '^$'
NODE_ENV=development
LOG_LEVEL=info
LOG_PRETTY=true
HTTP_HOST=127.0.0.1
HTTP_PORT=8080
BASE_URL=http://127.0.0.1:8080
TRUST_PROXY=1
PUBLIC_HOST=personalfi.lan
BIND_ADDRESS=127.0.0.1
DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev
DATABASE_POOL_MAX=10
DATABASE_STATEMENT_TIMEOUT_MS=30000
SECRETS_DIR=./secrets
DEMO_MODE=false
```

exit=0, duration=0s

#### 2026-10-08T15:16:58Z s3-pg (README Install 3: just gen-pg-secrets)

```console
$ just gen-pg-secrets
wrote /home/pf/personalfi/secrets/pg_password and /home/pf/personalfi/secrets/database_url
run 'just harden-secrets' (needs sudo) to take them to 0400 owned by the consuming uid
```

exit=0, duration=1s

#### 2026-10-08T15:16:59Z s3-mk (README Install 3: just gen-master-key)

```console
$ just gen-master-key; ls -la secrets
wrote /home/pf/personalfi/secrets/master_key — back it up somewhere that is not this host
run 'just harden-secrets' (needs sudo) to take it to 0400 owned by uid 10001
total 20
drwx--S---  2 pf pf 4096 Oct  8 15:16 .
drwxr-sr-x 10 pf pf 4096 Oct  8 15:16 ..
-r--r--r--  1 pf pf  106 Oct  8 15:16 database_url
-r--r--r--  1 pf pf   64 Oct  8 15:16 master_key
-r--r--r--  1 pf pf   65 Oct  8 15:16 pg_password
```

exit=0, duration=0s

--- phase build (2026-10-08T15:16:59Z)

### Run 2: README Install step 4 (just build) - started 2026-10-08T15:16:59Z

#### 2026-10-08T15:16:59Z s4-build (README Install 4: just build (first build; README: several minutes))

```console
$ just build 2>&1 | tail -n 400
#30 [backup] resolving provenance for metadata file
#30 DONE 0.0s

#31 [proxy web-build 5/6] RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked     pnpm install --frozen-lockfile --filter '@app/web...'
#31 0.836 Scope: 2 of 29 workspace projects
#31 0.920 ? Verifying lockfile against supply-chain policies (1011 entries)...
#31 1.413 Update available! 12.4.1 → 12.10.1.
#31 1.413 Changelog: https://pnpm.io/v/12.10.1
#31 1.413 To update, run: curl -fsSL https://get.pnpm.io/install.sh | sh -
#31 ...

#29 [worker deploy 3/9] RUN npm install --global pnpm@12.4.1
#29 6.996
#29 6.996 added 2 packages in 6s
#29 7.000 npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
#29 7.000 npm warn install-scripts   pnpm@12.4.1 (preinstall: node install.js; postinstall: node install.js)
#29 7.000 npm warn install-scripts
#29 7.000 npm warn install-scripts Run `npm install -g --allow-scripts=pnpm` to allow these scripts once, or `npm config set allow-scripts=pnpm --location=user` to allow them for all global installs.
#29 7.003 npm notice
#29 7.003 npm notice New major version of npm available! 11.19.1 -> 12.2.0
#29 7.003 npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.0
#29 7.003 npm notice To update run: npm install -g npm@12.2.0
#29 7.003 npm notice
#29 ...

#31 [proxy web-build 5/6] RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked     pnpm install --frozen-lockfile --filter '@app/web...'
#31 7.275 ✓ Lockfile passes supply-chain policies (1011 entries in 6.4s)
#31 7.275 Lockfile is up to date, resolution step is skipped
#31 7.486 Packages are copied from the content-addressable store to the virtual store.
#31 7.486   Content-addressable store is at: /root/.local/share/pnpm/store/v11
... [340 lines omitted; full log /tmp/wp913/runs/2/s4-build.out]
#45 exporting layers 4.5s done
#45 exporting manifest sha256:a48226fddf370564c5ece6c69c4d080124d1125265307147565bebab8cc2f843 0.0s done
#45 exporting config sha256:a2d16892a8faf84a8f8a3e060a441ece3bf949e5740b4bbe7c706506fe21c996 0.0s done
#45 exporting attestation manifest sha256:5e80069888680ddae516b801cc9f708ab00a28fe056c8d37a1457efe3c5bf5de 0.0s done
#45 exporting manifest list sha256:e368334b1664b53d7ee1a737aec0ba3914b4b720a706399ebb207d00cb5ce45e 0.0s done
#45 naming to docker.io/personalfi/api:dev done
#45 unpacking to docker.io/personalfi/api:dev 23.1s done
#45 DONE 27.9s

#44 [migrator] exporting to image
#44 unpacking to docker.io/personalfi/api:dev 23.2s done
#44 DONE 27.8s

#47 [api] exporting to image
#47 unpacking to docker.io/personalfi/api:dev 23.2s done
#47 DONE 27.8s

#48 [migrator] resolving provenance for metadata file
#48 DONE 0.2s

#49 [api] resolving provenance for metadata file
#49 DONE 0.1s

#50 [worker] resolving provenance for metadata file
#50 DONE 0.0s
 Image personalfi/api:dev Built
 Image personalfi/proxy:dev Built
 Image personalfi/api:dev Built
 Image personalfi/api:dev Built
 Image personalfi/backup:dev Built
```

exit=0, duration=208s

--- phase install5 (2026-10-08T15:20:27Z)

#### 2026-10-08T15:20:27Z s5-age (README Install 5: backup keypair (verbatim))

```console
$ (umask 077; docker run --rm --entrypoint age-keygen personalfi/backup:dev > "$HOME/personalfi-age-identity.txt")
grep '^# public key:' "$HOME/personalfi-age-identity.txt" | cut -d' ' -f4 > secrets/age_recipient
chmod 444 secrets/age_recipient
cat secrets/age_recipient; ls -la secrets $HOME/personalfi-age-identity.txt
Public key: age1<redacted>
age1<redacted>
-rw------- 1 pf pf  184 Oct  8 15:20 /home/pf/personalfi-age-identity.txt

secrets:
total 24
drwx--S---  2 pf pf 4096 Oct  8 15:20 .
drwxr-sr-x 10 pf pf 4096 Oct  8 15:16 ..
-r--r--r--  1 pf pf   63 Oct  8 15:20 age_recipient
-r--r--r--  1 pf pf  106 Oct  8 15:16 database_url
-r--r--r--  1 pf pf   64 Oct  8 15:16 master_key
-r--r--r--  1 pf pf   65 Oct  8 15:16 pg_password
```

exit=0, duration=16s

#### 2026-10-08T15:20:43Z s6-placeholders (README Install 6: just secrets-placeholders)

```console
$ just secrets-placeholders; ls -la secrets
bash scripts/secrets-placeholders.sh
secrets-placeholders: set /home/pf/personalfi/secrets to 0700
secrets-placeholders: created 14 empty optional placeholder(s): advisor_token_secret b2_application_key b2_key_id coinbase_key_name coinbase_private_key coingecko_api_key etherscan_api_key fred_api_key migrator_database_url openfigi_api_key plaid_client_id plaid_env plaid_secret tiingo_api_key (0 already present, left untouched)
total 24
drwx--S---  2 pf pf 4096 Oct  8 15:20 .
drwxr-sr-x 10 pf pf 4096 Oct  8 15:16 ..
-r--r--r--  1 pf pf    0 Oct  8 15:20 advisor_token_secret
-r--r--r--  1 pf pf   63 Oct  8 15:20 age_recipient
-r--r--r--  1 pf pf    0 Oct  8 15:20 b2_application_key
-r--r--r--  1 pf pf    0 Oct  8 15:20 b2_key_id
-r--r--r--  1 pf pf    0 Oct  8 15:20 coinbase_key_name
-r--r--r--  1 pf pf    0 Oct  8 15:20 coinbase_private_key
-r--r--r--  1 pf pf    0 Oct  8 15:20 coingecko_api_key
-r--r--r--  1 pf pf  106 Oct  8 15:16 database_url
-r--r--r--  1 pf pf    0 Oct  8 15:20 etherscan_api_key
-r--r--r--  1 pf pf    0 Oct  8 15:20 fred_api_key
-r--r--r--  1 pf pf   64 Oct  8 15:16 master_key
-r--r--r--  1 pf pf    0 Oct  8 15:20 migrator_database_url
-r--r--r--  1 pf pf    0 Oct  8 15:20 openfigi_api_key
-r--r--r--  1 pf pf   65 Oct  8 15:16 pg_password
-r--r--r--  1 pf pf    0 Oct  8 15:20 plaid_client_id
-r--r--r--  1 pf pf    0 Oct  8 15:20 plaid_env
-r--r--r--  1 pf pf    0 Oct  8 15:20 plaid_secret
-r--r--r--  1 pf pf    0 Oct  8 15:20 tiingo_api_key
```

exit=0, duration=0s

--- phase up (2026-10-08T15:20:43Z)

### Run 2: README Install step 7 (up --wait) started 2026-10-08T15:20:43Z

#### 2026-10-08T15:20:43Z s7-up (README Install 7: docker compose up -d --wait --wait-timeout 900)

```console
$ docker compose up -d --wait --wait-timeout 900 2>&1 | tail -n 60
 Container personalfi-pre-migrate-backup-1 Creating
 Container personalfi-pre-migrate-backup-1 Created
 Container personalfi-migrator-1 Creating
 Container personalfi-migrator-1 Created
 Container personalfi-backup-1 Creating
 Container personalfi-worker-1 Creating
 Container personalfi-api-1 Creating
 Container personalfi-backup-1 Created
 Container personalfi-api-1 Created
 Container personalfi-proxy-1 Creating
 Container personalfi-worker-1 Created
 Container personalfi-proxy-1 Created
 Container personalfi-db-1 Starting
 Container personalfi-db-1 Started
 Container personalfi-db-1 Waiting
 Container personalfi-db-1 Healthy
 Container personalfi-pre-migrate-backup-1 Starting
 Container personalfi-pre-migrate-backup-1 Started
 Container personalfi-pre-migrate-backup-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-pre-migrate-backup-1 Exited
 Container personalfi-db-1 Healthy
 Container personalfi-migrator-1 Starting
 Container personalfi-migrator-1 Started
 Container personalfi-db-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-db-1 Healthy
 Container personalfi-db-1 Healthy
 Container personalfi-db-1 Healthy
 Container personalfi-migrator-1 Exited
 Container personalfi-api-1 Starting
 Container personalfi-migrator-1 Exited
 Container personalfi-backup-1 Starting
 Container personalfi-migrator-1 Exited
 Container personalfi-worker-1 Starting
 Container personalfi-api-1 Started
 Container personalfi-api-1 Waiting
 Container personalfi-backup-1 Started
 Container personalfi-worker-1 Started
 Container personalfi-api-1 Healthy
 Container personalfi-proxy-1 Starting
 Container personalfi-proxy-1 Started
 Container personalfi-db-1 Waiting
 Container personalfi-worker-1 Waiting
 Container personalfi-backup-1 Waiting
 Container personalfi-api-1 Waiting
 Container personalfi-proxy-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-pre-migrate-backup-1 Waiting
 Container personalfi-db-1 Healthy
 Container personalfi-backup-1 Healthy
 Container personalfi-migrator-1 Exited
 Container personalfi-pre-migrate-backup-1 Exited
 Container personalfi-worker-1 Healthy
 Container personalfi-api-1 Healthy
 Container personalfi-proxy-1 Healthy
```

exit=0, duration=48s

#### 2026-10-08T15:21:31Z s7-ps (README Install 7: docker compose ps)

```console
$ docker compose ps
NAME                  IMAGE                                                                                              COMMAND                  SERVICE   CREATED          STATUS                    PORTS
personalfi-api-1      personalfi/api:dev                                                                                 "/sbin/tini -- node …"   api       21 seconds ago   Up 11 seconds (healthy)   8080/tcp
personalfi-backup-1   personalfi/backup:dev                                                                              "/sbin/tini -- /usr/…"   backup    21 seconds ago   Up 10 seconds (healthy)
personalfi-db-1       postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2   "docker-entrypoint.s…"   db        30 seconds ago   Up 20 seconds (healthy)   5432/tcp
personalfi-proxy-1    personalfi/proxy:dev                                                                               "caddy run --config …"   proxy     20 seconds ago   Up 5 seconds (healthy)    80/tcp, 443/tcp, 2019/tcp, 443/udp, 127.0.0.1:80->8080/tcp, 127.0.0.1:443->8443/tcp
personalfi-worker-1   personalfi/api:dev                                                                                 "/sbin/tini -- node …"   worker    21 seconds ago   Up 10 seconds (healthy)   8080/tcp
```

exit=0, duration=0s

#### 2026-10-08T15:21:31Z s7-ready (README Install 7: readiness from inside the api container)

```console
$ docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(async r => console.log(r.status, await r.text()))"
200 {"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"0","maxLagEvents":0,"oldestUnprocessedAgeSeconds":null,"failedConsumers":[]},"queue":{"pending":0,"running":0,"dead":0,"stalled":0,"oldestPendingAgeSeconds":null}}
```

exit=0, duration=1s

--- phase browser_tools (2026-10-08T15:21:32Z)

Harness-only tooling (not a README prerequisite): chromium, nss-tools (certutil), npm + puppeteer-core in /home/pf/harness

#### 2026-10-08T15:21:32Z h-apk (harness: headless browser)

```console
$ apk add chromium nss-tools npm font-noto 2>&1 | tail -3; chromium --version
Executing gdk-pixbuf-2.44.7-r1.trigger
Executing gtk+3.0-3.24.52-r0.trigger
OK: 865.6 MiB in 245 packages
Chromium 152.0.7977.82 Alpine Linux
```

exit=0, duration=29s

#### 2026-10-08T15:22:01Z h-npm (harness: puppeteer-core (CDP client))

```console
$ mkdir -p harness && cd harness && npm init -y >/dev/null && npm install puppeteer-core 2>&1 | tail -3
  run `npm fund` for details

found 0 vulnerabilities
```

exit=0, duration=12s

--- phase trust (2026-10-08T15:22:13Z)

### Run 2: README Install step 8 (trust the TLS certificate)

#### 2026-10-08T15:22:13Z s8-trustca (README Install 8: just trust-ca)

```console
$ just trust-ca; ls -la personalfi-ca.crt
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./personalfi-ca.crt
 personalfi-proxy-1 Copying personalfi-proxy-1:/data/caddy/pki/authorities/local/root.crt to ./personalfi-ca.crt
 personalfi-proxy-1 Copied personalfi-proxy-1:/data/caddy/pki/authorities/local/root.crt to ./personalfi-ca.crt
wrote ./personalfi-ca.crt — import it into your OS/browser trust store (see RUNBOOK.md)
-rw------- 1 pf pf 627 Oct  8 15:21 personalfi-ca.crt
```

exit=0, duration=1s

#### 2026-10-08T15:22:14Z s8-hosts (README Install 8: /etc/hosts line (verbatim))

```console
$ echo "127.0.0.1 personalfi.lan" | sudo tee -a /etc/hosts
127.0.0.1 personalfi.lan
```

exit=0, duration=0s

#### 2026-10-08T15:22:14Z s8-sys-trust (README Install 8: Debian, Ubuntu or Alpine system store line (verbatim))

```console
$ sudo cp personalfi-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
```

exit=0, duration=0s

#### 2026-10-08T15:22:14Z s8-curl (README Install 8: curl chain check (verbatim))

````console
$ curl --cacert personalfi-ca.crt --resolve personalfi.lan:443:127.0.0.1 https://personalfi.lan/api/ready
  % Total    % Received % Xferd  Average Speed  Time    Time    Time   Current
                                 Dload  Upload  Total   Spent   Left   Speed

  0      0   0      0   0      0      0      0                              0
100    247 100    247   0      0  15030      0                              0
100    247 100    247   0      0  14951      0                              0
100    247 100    247   0      0  14873      0                              0
{"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"0","maxLagEvents":0,"oldestUnprocessedAgeSeconds":null,"failedConsumers":[]},"queue":{"pending":0,"running":0,"dead":0,"stalled":0,"oldestPendingAgeSeconds":null}}```

exit=0, duration=0s

--- phase nss (2026-10-08T15:22:14Z)

README Install 8: Chrome/Chromium on Linux line, verbatim (certutil from nss-tools, installed with the harness browser)

#### 2026-10-08T15:22:14Z  h-nss  (import the CA into ~/.pki/nssdb for Chromium (README line, verbatim))

```console
$ certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt && certutil -d sql:$HOME/.pki/nssdb -L
certutil: function failed: SEC_ERROR_BAD_DATABASE: security library: bad database.
````

exit=255, duration=0s

FINDING F-13-9 hit again: the README's certutil line fails with SEC_ERROR_BAD_DATABASE when ~/.pki/nssdb does not exist; creating the db (not in the README) and retrying.

#### 2026-10-08T15:22:14Z h-nss-init (workaround (NOT README): create the NSS db first)

```console
$ mkdir -p $HOME/.pki/nssdb && certutil -d sql:$HOME/.pki/nssdb -N --empty-password
```

exit=0, duration=0s

#### 2026-10-08T15:22:14Z h-nss2 (README certutil line, retried)

```console
$ certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt && certutil -d sql:$HOME/.pki/nssdb -L

Certificate Nickname                                         Trust Attributes
                                                             SSL,S/MIME,JAR/XPI

personalfi                                                   C,,
```

exit=0, duration=0s

--- phase bootstrap (2026-10-08T15:22:14Z)

### Run 2: README Install step 9 (create account)

#### 2026-10-08T15:22:14Z s9-bootstrap (README Install 9: just bootstrap-user (verbatim))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York"
bootstrap-user: running inside the api container (the stack is up)
(node:97) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:97) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user created      Your Name (01a11c1b-ac4e-7247-8c8d-0a0688d50c38)
time zone         America/New_York
taxonomy          153 categories seeded
advisors          40 manifests registered
schedules         categorization.retrain_weekly, notifications.deliver, notifications.digest, integrations.price_refresh, planning.net_worth_snapshot
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5640 ms · KEK generation 1

Enrol your first passkey within 60 minutes:

  https://personalfi.lan/register#token=<redacted>

  token only: <redacted>
  expires:    2026-10-08T16:22:31.854Z

Single-use. It is stored only as a SHA-256 digest, so this is the one and only
time it is readable — and it is not in any log. Enrol a second authenticator
and print your ten recovery codes straight after: one passkey on one device is
a self-inflicted denial of service.
```

exit=0, duration=18s

--- phase enrol (2026-10-08T15:22:32Z)

### Run 2: README Install step 9-10 (browser: enrol, then sign in)

[resp] 200 GET https://personalfi.lan/api/auth/unlock-state
[resp] 200 POST https://personalfi.lan/api/auth/register/options
[resp] 200 POST https://personalfi.lan/api/auth/register/verify
credentials saved: 1
--- reg-step2: https://personalfi.lan/register#token=<redacted> | Set up a passkey · PersonalFi
Add a backup passkey

A phone, a security key, or another browser — so one lost device can’t lock you out.

Name this passkeyAdd passkeySkip for now
--- interactive:
input[text] name= id=friendly-name aria= text=Virtual passkey (this device)
button[submit] name= id= aria= text=Add passkey
button[button] name= id= aria= text=Skip for now
--- screenshot /home/pf/harness/shots/reg-step2.png
[resp] 200 POST https://personalfi.lan/api/auth/register/options
[resp] 200 POST https://personalfi.lan/api/auth/register/verify
credentials saved: 2
--- reg-step3: https://personalfi.lan/register#token=<redacted> | Set up a passkey · PersonalFi
You’re all set

Your passkeys are ready.

Continue to PersonalFi
--- interactive:
button[button] name= id= aria= text=Continue to PersonalFi
--- screenshot /home/pf/harness/shots/reg-step3.png
[resp] 200 GET https://personalfi.lan/api/auth/session
[console.error] Failed to load resource: the server responded with a status of 404 ()
[console.error] Failed to load resource: the server responded with a status of 404 ()
--- reg-step4: https://personalfi.lan/ | Dashboard · PersonalFi
Skip to main content
PersonalFi
OVERVIEW
Dashboard
Insights
Brief
MONEY
Inbox
Transactions
Budget
Recurring
WEALTH
Accounts
Investments
Plan
Goals
SYSTEM
Settings
No syncs yet
Collapse
Dashboard
No syncs yet
Search
⌘K
Net worth
—
No net worth recorded yet

No net worth history yet.

PHASE FAILED: enrol (see /tmp/wp913/runs/2) - stopping; this is a finding to record.

Harness fix (not a README matter): restoring both virtual-authenticator credentials into one authenticator failed; the harness now restores only the first. Resuming from the sign-in check (the wizard itself had completed).

## Run 2: candidate fd02965852e767b66e390711af6a0a18f41da648 (/tmp/wp913/personalfi-src.tar), previous wave 4f0c7b9084071ec75a97395a9acb61e879a940c9 (/tmp/wp913/personalfi-src-previous-wave.tar), started 2026-10-08T15:23:21Z

--- phase firstdata (2026-10-08T15:23:21Z)

### Run 2: README 'Your first data' step 1 (sample CSV; browser part is browser/import.mjs)

#### 2026-10-08T15:23:21Z d1-sample (README Your first data 1: sample.csv (verbatim))

```console
$ printf 'Date,Description,Amount\n2026-09-01,Coffee shop,-4.50\n2026-09-02,Payroll,2500.00\n2026-09-03,Grocery store,-62.18\n' > sample.csv; cat sample.csv
Date,Description,Amount
2026-09-01,Coffee shop,-4.50
2026-09-02,Payroll,2500.00
2026-09-03,Grocery store,-62.18
```

exit=0, duration=0s

--- phase backup (2026-10-08T15:24:49Z)

### Run 2: README 'Your first data' step 2 (backup)

#### 2026-10-08T15:24:49Z d2-backup (README Your first data 2: just backup)

```console
$ just backup
docker compose exec backup /usr/local/bin/backup.sh
backup: dumping personalfi@db ...
backup: verified 589125 bytes, 1119 restorable object(s), schema_migrations present
backup: wrote /backups/personalfi-20261008T152449Z.dump.age (589453 bytes)
backup: pruning entries older than 30 day(s) locally
backup: RCLONE_REMOTE not set; local-only backup (see RUNBOOK.md to enable B2)
backup: complete
```

exit=0, duration=0s

--- phase drill (2026-10-08T15:24:49Z)

### Run 2: README 'Your first data' step 3 (restore drill) started 2026-10-08T15:24:49Z

#### 2026-10-08T15:24:49Z d3-drill (README Your first data 3: restore drill (verbatim))

```console
$ export AGE_IDENTITY_FILE="$HOME/personalfi-age-identity.txt"
export DRILL_EVIDENCE_DIR="$HOME/personalfi-drills"
just restore-drill
Unable to find image 'alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b' locally
docker.io/library/alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b: Pulling from library/alpine
56dceff11b33: Download complete
f5124fb579e2: Download complete
Digest: sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
Status: Downloaded newer image for alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
restore-drill: starting scratch db (restore-drill-db-6454 on personalfi_backend) ...
restore-drill: waiting for scratch db to accept connections ..ok
restore-drill: restoring /backups/personalfi-20261008T152449Z.dump.age (589453 bytes)
restore: decrypting /backups/personalfi-20261008T152449Z.dump.age
restore: target personalfi_restore_drill@restore-drill-db; --clean --if-exists will DROP and recreate these:
restore: archive contains 1119 restorable object(s)
restore: restoring into personalfi_restore_drill@restore-drill-db (--clean --if-exists --no-owner)
restore: complete
restore-drill: booting a throwaway api container against the restored db ...
# Restore drill — 20261008T152450Z

**Verdict: PASS**

- Backup restored: `/backups/personalfi-20261008T152449Z.dump.age` (589453 encrypted bytes)
- Restored db table count: 101
- Restored db schema_migrations max id: 0040
- Live db table count: 101
- Live db schema_migrations max id: 0040
- API /ready against restored db: pass (200 from /ready)

All assertions held: restored tables > 0, restored == live, schema_migrations agree,
and the API served /ready from the restored database. `just restore-drill` exited 0.
restore-drill: wrote /home/pf/personalfi-drills/restore-drill-20261008.md
```

exit=0, duration=28s

--- phase publish (2026-10-08T15:25:17Z)

### Run 2: publish the candidate to the stand-in origin (harness; the README's upgrade starts at 'git pull')

#### 2026-10-08T15:25:17Z u0-publish (push the candidate tree as a child commit of main on the stand-in origin)

```console
$ cd origin-work && git rm -r -q --cached . >/dev/null && find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + && tar -xf /opt/cand.tar && git add -A && git commit -q -m candidate && git push -q ../srv/origin.git main && git -C ../srv/origin.git log --oneline | head -3
11ba8a3 candidate
c438c30 previous-wave
```

exit=0, duration=1s

--- phase upgrade (2026-10-08T15:25:18Z)

### Run 2: README Upgrade started 2026-10-08T15:25:18Z

#### 2026-10-08T15:25:18Z u1-pull (README Upgrade: git pull (verbatim))

```console
$ git pull; git status --short | head; git log --oneline | head -3
From /home/pf/srv/origin
   c438c30..11ba8a3  main       -> origin/main
Updating c438c30..11ba8a3
Fast-forward
 .env.example                                       |   6 +-
 README.md                                          |  16 +-
 RUNBOOK.md                                         |  26 +-
 apps/api/src/routes/investments.ts                 |  19 +-
 apps/api/test/db/auth-failure-uniform.test.ts      | 111 +++
 apps/api/test/db/budgets-card-owing.test.ts        | 142 ++++
 apps/api/test/db/holdings-reconcile.test.ts        |   2 +-
 apps/api/test/db/holdings-scale-perf.test.ts       |  35 +-
 apps/api/test/db/host-load-rule.test.ts            |  56 ++
 apps/api/test/db/nightly-perf.test.ts              |  70 ++
 apps/api/test/db/patch-mass-assignment.test.ts     | 156 ++++
 apps/api/test/db/perf-support.ts                   |  98 ++-
 apps/api/test/db/reports-aggregation.test.ts       |   3 +-
 apps/api/test/db/soak-canary-columns.ts            | 132 ++++
 apps/api/test/db/soak-canary-coverage.test.ts      | 101 +++
 apps/api/test/db/soak-report.test.ts               |  78 ++
 apps/api/test/price-holdings-batched.test.ts       |  66 ++
 apps/web/e2e/a11y-keyboard.spec.ts                 |   4 +
 apps/web/e2e/security.spec.ts                      | 163 ++++
 apps/web/e2e/support/mock-security.ts              | 154 ++++
 apps/web/src/app/router.test.tsx                   |   4 +-
 apps/web/src/features/auth/LoginRedirect.test.tsx  | 101 +++
 .../src/features/auth/PasskeyRegisterFlow.test.tsx | 142 ++++
 apps/web/src/features/auth/PasskeyRegisterFlow.tsx |  43 +-
 apps/web/src/features/security/RecoveryCodes.tsx   | 151 ++++
 .../src/features/security/SecurityScreen.test.tsx  | 418 +++++++++++
... [31 lines omitted; full log /tmp/wp913/runs/2/u1-pull.out]
 57 files changed, 5417 insertions(+), 137 deletions(-)
 create mode 100644 apps/api/test/db/auth-failure-uniform.test.ts
 create mode 100644 apps/api/test/db/budgets-card-owing.test.ts
 create mode 100644 apps/api/test/db/patch-mass-assignment.test.ts
 create mode 100644 apps/api/test/db/soak-canary-columns.ts
 create mode 100644 apps/api/test/db/soak-canary-coverage.test.ts
 create mode 100644 apps/api/test/price-holdings-batched.test.ts
 create mode 100644 apps/web/e2e/security.spec.ts
 create mode 100644 apps/web/e2e/support/mock-security.ts
 create mode 100644 apps/web/src/features/auth/LoginRedirect.test.tsx
 create mode 100644 apps/web/src/features/auth/PasskeyRegisterFlow.test.tsx
 create mode 100644 apps/web/src/features/security/RecoveryCodes.tsx
 create mode 100644 apps/web/src/features/security/SecurityScreen.test.tsx
 create mode 100644 apps/web/src/features/security/SecurityScreen.tsx
 create mode 100644 apps/web/src/features/security/api.ts
 create mode 100644 apps/web/src/lib/safe-redirect.test.ts
 create mode 100644 docs/evidence/phase-9/wp9.14-quality.md
 create mode 100644 packages/contexts/budgeting/test/db/card-owing-at-first-period.test.ts
 create mode 100644 packages/contexts/budgeting/test/db/card-spend-without-envelope.test.ts
 create mode 100644 packages/contexts/budgeting/test/db/consumer-backlog.test.ts
 create mode 100644 packages/contexts/investments/test/db/prices-bounded-read.test.ts
 create mode 100644 packages/platform/src/events/backlog.ts
 create mode 100644 packages/platform/test/jobs-completion-wake.test.ts
 create mode 100644 scripts/caddy-headers.test.ts
 create mode 100644 scripts/compose-env-passthrough.test.ts
 create mode 100644 scripts/eslint-html-sinks.test.ts
 create mode 100644 scripts/justfile-recipes.test.ts
?? sample.csv
11ba8a3 candidate
c438c30 previous-wave
```

exit=0, duration=3s

#### 2026-10-08T15:25:21Z u2-upgrade (README Upgrade: just upgrade (verbatim))

```console
$ just upgrade 2>&1 | tail -n 400
#30 39.17 devDependencies:
#30 39.17 + @eslint/js 10.0.1
#30 39.17 + @types/node 26.4.1
#30 39.17 + @vitest/coverage-v8 5.0.0
#30 39.17 + eslint 10.10.0
#30 39.17 + eslint-plugin-jsx-a11y 6.10.2
#30 39.17 + eslint-plugin-react-hooks 7.1.1
#30 39.17 + fast-check 4.9.0
#30 39.17 + globals 17.12.0
#30 39.17 + lefthook 2.1.12
#30 39.17 + prettier 3.9.6
#30 39.17 + typescript 6.0.3
#30 39.17 + typescript-eslint 8.69.0
#30 39.17 + vite 8.2.2
#30 39.17 + vitest 5.0.0
#30 39.17
#30 39.20 Done in 21.5s using pnpm v12.4.1
#30 DONE 51.5s

#31 [migrator deploy 7/9] RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked     projects() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s)){const r=require("node:path").relative("/app",p.path);if(r)console.log(r)}})'; } &&     KEEP="$(pnpm list --filter '@app/api...' --depth -1 --prod --json | projects)" &&     ALL="$(pnpm list -r --depth -1 --json | projects)" &&     test -n "$KEEP" && test -n "$ALL" &&     echo "$KEEP" | grep -qx 'apps/api' &&     printf 'keeping workspace projects:\n%s\n' "$KEEP" &&     for dir in $ALL; do       case "$dir" in /*|*..*) echo "refusing to prune $dir" >&2; exit 1;; esac;       [ -d "$dir" ] || continue;       echo "$KEEP" | grep -qx "$dir" || rm -rf "$dir";     done &&     find apps packages -depth -type d -empty -delete 2>/dev/null || true
#31 ...

#32 [proxy web-build 6/6] RUN pnpm --filter '@app/web' run gen &&     pnpm --filter '@app/web' exec vite build &&     pnpm --filter '@app/web' exec node scripts/check-sw-precache.ts &&     pnpm --filter '@app/web' exec node scripts/check-csp.ts &&     find apps/web/dist -name '*.map' -delete &&     find apps/web/dist -type f ( -name '*.js' -o -name '*.css' )       -exec sed -i -E '/[#@][[:space:]]*sourceMappingURL=/d' {} + &&     test -f apps/web/dist/index.html
#32 0.776 $ openapi-ts
#32 ...

#31 [migrator deploy 7/9] RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked     projects() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s)){const r=require("node:path").relative("/app",p.path);if(r)console.log(r)}})'; } &&     KEEP="$(pnpm list --filter '@app/api...' --depth -1 --prod --json | projects)" &&     ALL="$(pnpm list -r --depth -1 --json | projects)" &&     test -n "$KEEP" && test -n "$ALL" &&     echo "$KEEP" | grep -qx 'apps/api' &&     printf 'keeping workspace projects:\n%s\n' "$KEEP" &&     for dir in $ALL; do       case "$dir" in /*|*..*) echo "refusing to prune $dir" >&2; exit 1;; esac;       [ -d "$dir" ] || continue;       echo "$KEEP" | grep -qx "$dir" || rm -rf "$dir";     done &&     find apps packages -depth -type d -empty -delete 2>/dev/null || true
#31 35.28 keeping workspace projects:
#31 35.28 apps/api
#31 35.28 packages/seed
... [340 lines omitted; full log /tmp/wp913/runs/2/u2-upgrade.out]
 Container personalfi-worker-1 Started
 Container personalfi-api-1 Healthy
 Container personalfi-proxy-1 Starting
 Container personalfi-proxy-1 Started
 Container personalfi-backup-1 Waiting
 Container personalfi-db-1 Waiting
 Container personalfi-proxy-1 Waiting
 Container personalfi-api-1 Waiting
 Container personalfi-worker-1 Waiting
 Container personalfi-pre-migrate-backup-1 Waiting
 Container personalfi-migrator-1 Waiting
 Container personalfi-pre-migrate-backup-1 Exited
 Container personalfi-migrator-1 Exited
 Container personalfi-db-1 Healthy
 Container personalfi-backup-1 Healthy
 Container personalfi-api-1 Healthy
 Container personalfi-proxy-1 Healthy
 Container personalfi-worker-1 Healthy
upgrade: /ready 200 {"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"4","maxLagEvents":4,"oldestUnprocessedAgeSeconds":234.946523,"failedConsumer
upgrade: up-to-ready 29 s (load 3.50 3.20 2.57)
upgrade: pre-migrate: schema current (38 applied, newest 0040); nothing pending, no backup needed
upgrade: api running, restarts 0
upgrade: worker running, restarts 0
NAME                  IMAGE                                                                                              COMMAND                  SERVICE   CREATED          STATUS                    PORTS
personalfi-api-1      personalfi/api:dev                                                                                 "/sbin/tini -- node …"   api       58 seconds ago   Up 51 seconds (healthy)   8080/tcp
personalfi-backup-1   sha256:17f2ecfe5454f085ee94959a6df9d96626cd7903db5077b06283623e97fabe81                            "/sbin/tini -- /usr/…"   backup    6 minutes ago    Up 6 minutes (healthy)
personalfi-db-1       postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2   "docker-entrypoint.s…"   db        6 minutes ago    Up 6 minutes (healthy)    5432/tcp
personalfi-proxy-1    personalfi/proxy:dev                                                                               "caddy run --config …"   proxy     58 seconds ago   Up 40 seconds (healthy)   80/tcp, 443/tcp, 2019/tcp, 443/udp, 127.0.0.1:80->8080/tcp, 127.0.0.1:443->8443/tcp
personalfi-worker-1   personalfi/api:dev                                                                                 "/sbin/tini -- node …"   worker    58 seconds ago   Up 51 seconds (healthy)   8080/tcp
upgrade: complete
```

exit=0, duration=155s

#### 2026-10-08T15:27:56Z u3-ps (state after upgrade)

```console
$ docker compose ps; docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(async r => console.log(r.status, await r.text()))"
NAME                  IMAGE                                                                                              COMMAND                  SERVICE   CREATED          STATUS                    PORTS
personalfi-api-1      personalfi/api:dev                                                                                 "/sbin/tini -- node …"   api       59 seconds ago   Up 52 seconds (healthy)   8080/tcp
personalfi-backup-1   sha256:17f2ecfe5454f085ee94959a6df9d96626cd7903db5077b06283623e97fabe81                            "/sbin/tini -- /usr/…"   backup    6 minutes ago    Up 6 minutes (healthy)
personalfi-db-1       postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2   "docker-entrypoint.s…"   db        6 minutes ago    Up 6 minutes (healthy)    5432/tcp
personalfi-proxy-1    personalfi/proxy:dev                                                                               "caddy run --config …"   proxy     59 seconds ago   Up 40 seconds (healthy)   80/tcp, 443/tcp, 2019/tcp, 443/udp, 127.0.0.1:80->8080/tcp, 127.0.0.1:443->8443/tcp
personalfi-worker-1   personalfi/api:dev                                                                                 "/sbin/tini -- node …"   worker    59 seconds ago   Up 51 seconds (healthy)   8080/tcp
200 {"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"4","maxLagEvents":4,"oldestUnprocessedAgeSeconds":266.129724,"failedConsumers":[]},"queue":{"pending":0,"running":0,"dead":0,"stalled":0,"oldestPendingAgeSeconds":null}}
```

exit=0, duration=0s

--- phase verify_after_upgrade (2026-10-08T15:27:56Z)

After upgrade: same passkey signed in; transaction rows seen before/after: 6 / 6

## Run 2: all phases passed (2026-10-08T15:28:03Z); the verdict (findings or none) is written by hand below.

### Run 2: post-upgrade extra checks on the candidate (not README steps): backup + drill again, bootstrap-user reissue=true once more, recovery-codes wizard on the upgraded install

#### 2026-10-08T15:28:16Z x-backup (just backup on the candidate)

```console
$ just backup
docker compose exec backup /usr/local/bin/backup.sh
backup: dumping personalfi@db ...
backup: verified 590535 bytes, 1119 restorable object(s), schema_migrations present
backup: wrote /backups/personalfi-20261008T152817Z.dump.age (590879 bytes)
backup: pruning entries older than 30 day(s) locally
backup: RCLONE_REMOTE not set; local-only backup (see RUNBOOK.md to enable B2)
backup: complete
```

exit=0, duration=1s

### Run 2: README 'Your first data' step 3 (restore drill) started 2026-10-08T15:28:17Z

#### 2026-10-08T15:28:17Z d3-drill (README Your first data 3: restore drill (verbatim))

```console
$ export AGE_IDENTITY_FILE="$HOME/personalfi-age-identity.txt"
export DRILL_EVIDENCE_DIR="$HOME/personalfi-drills"
just restore-drill
restore-drill: starting scratch db (restore-drill-db-11753 on personalfi_backend) ...
restore-drill: waiting for scratch db to accept connections ..ok
restore-drill: restoring /backups/personalfi-20261008T152817Z.dump.age (590879 bytes)
restore: decrypting /backups/personalfi-20261008T152817Z.dump.age
restore: target personalfi_restore_drill@restore-drill-db; --clean --if-exists will DROP and recreate these:
restore: archive contains 1119 restorable object(s)
restore: restoring into personalfi_restore_drill@restore-drill-db (--clean --if-exists --no-owner)
restore: complete
restore-drill: WARNING: the live database holds no plan scenario, so this drill cannot see a backup that fails to restore one (F-94-6). Save a plan on the Plan screen, run `just backup`, then drill again.
restore-drill: booting a throwaway api container against the restored db ...
# Restore drill — 20261008T152817Z

**Verdict: PASS**

- Backup restored: `/backups/personalfi-20261008T152817Z.dump.age` (590879 encrypted bytes)
- Restored db table count: 101
- Restored db schema_migrations max id: 0040
- Live db table count: 101
- Live db schema_migrations max id: 0040
- plan_scenarios rows, restored / live: 0 / 0
- WARNING: the live database holds no plan scenario, so this drill cannot see a backup that fails to restore one (F-94-6). Save a plan on the Plan screen, run `just backup`, then drill again.
- API /ready against restored db: pass (200 from /ready)

All assertions held: restored tables > 0, restored == live, schema_migrations agree,
and the API served /ready from the restored database. `just restore-drill` exited 0.
restore-drill: wrote /home/pf/personalfi-drills/restore-drill-20261008.md
```

exit=0, duration=21s

#### 2026-10-08T15:28:38Z x-reissue (bootstrap-user reissue=true on the candidate (one-shot container))

```console
$ just bootstrap-user name="Your Name" timezone="America/New_York" reissue=true
bootstrap-user: running in its own one-shot container (the stack is up)
 Container personalfi-api-run-dbbb919b3330 Creating
 Container personalfi-api-run-dbbb919b3330 Created
(node:1) ExperimentalWarning: The supports Web Crypto API method is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:1) ExperimentalWarning: The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time
user              Your Name (01a11c1b-ac4e-7247-8c8d-0a0688d50c38)
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5736 ms · KEK generation 1

Enrol your first passkey within 60 minutes:

  https://personalfi.lan/register#token=<redacted>

  token only: <redacted>
  expires:    2026-10-08T16:28:48.002Z

Single-use. It is stored only as a SHA-256 digest, so this is the one and only
time it is readable — and it is not in any log. Enrol a second authenticator
and print your ten recovery codes straight after: one passkey on one device is
a self-inflicted denial of service.
```

exit=0, duration=10s

dind torn down (2026-10-08T15:29:25Z)

---

## Runs 2a and 2 - summary (candidate fd02965852e767b66e390711af6a0a18f41da648, previous wave 4f0c7b9084071ec75a97395a9acb61e879a940c9)

Before the runs I re-read the candidate's `README.md` (`tar -xOf`, nothing else opened; no RUNBOOK section was needed this time, no step failed in a way the README's Troubleshooting pointer applies to). Phases changed for the new README: package line with `curl`; step 8 now runs the Alpine system-store line and the Chromium NSS line verbatim (`nss-tools` installed with the harness browser, before step 8); the wizard handler clicks `Create my recovery codes`, ticks `I have saved these codes somewhere safe`, clicks `Continue`, and prints only the COUNT of code-like tokens (`describe` masks them; `redact` in `lib.sh` masks `XXXXX-XXXXX` before anything reaches this file; one code leaked into this file during development of the handler and was removed at once, from a destroyed throwaway install).

Two runs, each from a freshly created dind (`--memory 6g --cpus 4`), both following the same README:

- **Run 2a (rehearsal and fresh-candidate install):** the candidate installed directly (no upgrade), because the previous wave (Wave D) predates the 9.14 features the README now describes (one-shot bootstrap container, recovery-codes screen). Harness development happened here (wizard handler, sign-in race, signature counter); one `reissue=true` was used to re-run the wizard after my script died mid-wizard. Its README-visible observations are valid and counted below.
- **Run 2 (the required upgrade path):** previous wave 4f0c7b9 installed, then `git pull` + `just upgrade` to fd02965. Resumed once by hand after a harness error (restoring two virtual-authenticator credentials into one authenticator), noted in the transcript; the README steps themselves ran from a clean state.

### Goals reached

| #   | Goal                              | Run 2 (4f0c7b9 -> fd02965)                                                                                                                                                           | Run 2a (fd02965 fresh)                                                                     |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Stack up + passkey login over TLS | REACHED. build 208 s, `up --wait` 48 s, `bootstrap-user` 18 s, passkey sign-in 200                                                                                                   | REACHED. build 235 s, `up --wait` 47 s, `bootstrap-user` 25 s (one-shot container, no OOM) |
| 2   | Manual account + CSV import       | REACHED (3 rows, 2 accounts)                                                                                                                                                         | REACHED                                                                                    |
| 3   | `just backup`                     | REACHED, `backup: complete`, under 1 s                                                                                                                                               | REACHED                                                                                    |
| 4   | Restore drill                     | `Verdict: PASS` 28 s                                                                                                                                                                 | `Verdict: PASS` 28 s (with the plan-scenario WARNING, F-13-11)                             |
| 5   | `git pull` + `just upgrade`       | REACHED: `upgrade: complete` in 155 s (`git pull` 3 s), up-to-ready 29 s, restarts 0; same passkey signed in, the three imported rows listed before and after (row-line count 6 = 6) | not applicable                                                                             |

Notes: the upgrade logged `pre-migrate: schema current (38 applied, newest 0040); nothing pending, no backup needed` (both builds have schema 0040), so this upgrade applied no migration and took no pre-migrate backup (README: "takes a verified backup before the first migration" is conditional on there being one; not a finding). No `bootstrap-user` OOM in any attempt (4 attempts: runs 2a/2 first run, one `reissue=true` in 2a, one on the upgraded install). The recovery-codes screen appeared on the candidate: wizard `Add a backup passkey` -> `Save your recovery codes` -> `Create my recovery codes` -> ten codes (10 code-like tokens counted) -> checkbox -> `Continue` -> `You're all set`; also on the upgraded install via `reissue=true`. `Settings` has a `Security` tab on the candidate. The previous wave's wizard (run 2) shows no recovery step, as expected for that build.

### Findings, runs 2a and 2 (new; F-13-1..F-13-8 were fixed by f40de0e and 9.14 and did not recur)

| #       | Sev | README line                                     | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                         | What I did instead                                                                                        | Fix text wanted                                                                                                                                                                                                                                                            |
| ------- | --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-13-9  | M   | 166-168 (step 8, Chrome/Chromium/Edge on Linux) | `certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n personalfi -i personalfi-ca.crt` ends `certutil: function failed: SEC_ERROR_BAD_DATABASE: security library: bad database.` and exit 255 when `~/.pki/nssdb` does not exist, i.e. on any host where Chrome or Chromium has never been started (a fresh server, a container). Seen in both runs.                                                                                                                       | `mkdir -p $HOME/.pki/nssdb && certutil -d sql:$HOME/.pki/nssdb -N --empty-password`, then the README line | Prefix the line: "If `~/.pki/nssdb` does not exist yet (the browser has never run), create it first: `mkdir -p $HOME/.pki/nssdb && certutil -d sql:$HOME/.pki/nssdb -N --empty-password`."                                                                                 |
| F-13-10 | L   | 203-205 (step 9)                                | "The wizard then shows your ten recovery codes, once: save them ... and tick ..." The wizard first shows `Save your recovery codes` with two buttons, `Create my recovery codes` and `Skip for now - create them later in Settings > Security`; the codes appear only after clicking the first. I clicked it (obvious), but the README implies they are shown without an action.                                                                                      | clicked `Create my recovery codes`                                                                        | "The wizard then offers `Create my recovery codes`; choose it and it shows your ten codes, once: save them somewhere that is not this computer and tick ..."                                                                                                               |
| F-13-11 | L   | 251-252 (restore drill)                         | README: the drill "ends with `Verdict: PASS`". On a fresh install it also prints `- WARNING: the live database holds no plan scenario, so this drill cannot see a backup that fails to restore one (F-94-6). Save a plan on the Plan screen, run `just backup`, then drill again.` The README does not say whether that is expected, whether the PASS counts, or whether the extra steps are required. (Seen on the candidate; the previous wave printed no warning.) | ignored it, PASS stands                                                                                   | "On a fresh install the report also says `WARNING: the live database holds no plan scenario ...`: expected until you have saved a plan on the Plan screen; the verdict is still PASS. Once you have a plan, run `just backup` and the drill again so it also checks that." |

Observations that are not findings: the app may sign in by itself on page load (browser conditional mediation) before the button is pressed; the README's "choose Sign in with a passkey" still holds. `up --wait` 47-48 s vs "a minute or two"; upgrade 155 s vs "three to five minutes" (an upper bound, fine). `bootstrap-user` 18-25 s including starting its container (README: "about six seconds" of derivation; the log shows 5.6 s for the derivation itself).

### Run 2 verdict

NOT zero findings: F-13-9 (M), F-13-10 (L), F-13-11 (L). All five goals were reached in run 2 (and the fresh-candidate path in run 2a). Stopping per the brief: run 3 follows the README fix. Both dind containers were torn down (`docker rm -fv`; none left).

Re-run command for run 3 (same entry point, new archive and SHA, README line copied into `--apk`):

```bash
mkdir -p /tmp/wp913/runs/3
setsid nohup scripts/stranger/run2.sh --run 3 --cand-tar <new.tar> --cand-sha <sha> \
  --prev-tar /tmp/wp913/personalfi-src-previous-wave.tar --prev-sha 4f0c7b9084071ec75a97395a9acb61e879a940c9 \
  --apk "git just nodejs openssl bash coreutils curl" --teardown > /tmp/wp913/runs/3/full.log 2>&1 &
```

`--no-upgrade` runs the fresh-candidate install only; `--from PHASE` resumes after a harness workaround. If the fixed README changes the NSS step, edit `phase_nss` (it currently runs the README line, and on failure applies the F-13-9 workaround and records it).
