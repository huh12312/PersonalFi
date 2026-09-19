# WP 2.4 — Notifications context

_Evidence note for `packages/contexts/notifications/**` and
`packages/db/migrations/0011_notifications.sql`. Written against
[`02-phase-2-dispatch.md`](../../plan/02-phase-2-dispatch.md) §3 (WP 2.4), §4
(shared files), §5 (gate standard and the egress risk row) and §6 question 3._

Everything below was run on this machine at the commit this note lands with.
Every command is quoted with the output it actually produced; every control has
a sabotage beside it, and every sabotage was observed **red** before its PASS
was written down. A control that has never been seen failing is not evidence —
that is the Phase 0/Phase 1 gate finding this package was built under.

---

## 1. What is here

| Piece        | File                                            | What it is                                                                                 |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Schema       | `packages/db/migrations/0011_notifications.sql` | `notification_channels`, `notification_rules`, `notification_outbox`, `delivery_attempts`  |
| Port         | `src/channel.ts`                                | `NotificationChannel` with `send` and `verify` (08 §4.5)                                   |
| Adapters     | `src/adapters/{ntfy,smtp,fake}.ts`              | ntfy over HTTPS, SMTP over nodemailer, and the recorder every test uses                    |
| Egress guard | `src/egress.ts`                                 | the allow-lists, the address classifier, the DNS re-check                                  |
| Transport    | `src/transport.ts`                              | connects to a validated **address**, never follows a redirect, bounds the body, two timers |
| Outbox       | `src/outbox.ts`                                 | at-most-once insert, digest coalescing, claim, backoff, dead letter, retry                 |
| Jobs         | `src/jobs.ts`                                   | `notifications.deliver` (5 min), `notifications.digest` (hourly)                           |
| Consumer     | `src/consumer.ts`                               | five subscriptions → outbox rows; emits `NotificationQueued`                               |
| Read models  | `src/read.ts`                                   | outbox, dead letters **with their attempts**, per-notification attempts                    |

Test counts: **39 tests, 8 files** — `notifications` (24 tests, 3 files, pure)
and `notifications-db` (15 tests, 5 files, real Postgres).

```
$ pnpm exec vitest run --project notifications --project notifications-db
 Test Files  8 passed (8)
      Tests  39 passed (39)
   Duration  34.43s
```

---

## 2. Four defects that only existed because nothing had ever run

This package was written before it was exercised. Writing the suites found four
bugs, each of which would have made the feature **silently do nothing** in
production while every unit-level reading of the code said it worked. They are
listed first because they are the most useful thing in this note.

| #   | Defect                                                                                                                                                                                                                          | Symptom in production                                                                                                                          | Found by                                      | Fix                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `claimDueNotifications` returned raw `RETURNING target.*` rows (snake_case) cast to the Drizzle camelCase row type. `row.userId` was `undefined`, so the drain's per-user filter matched nothing.                               | Every notification is claimed, marked `sending`, and **never delivered**. The outbox fills up and no attempt row is ever written.              | `dedupe.test.ts` — the first drain returned 0 | `toOutboxRow()` maps the raw row explicitly, in one place (`src/outbox.ts`)                                                             |
| 2   | The transport's pinned `lookup` only answered the string callback form. Node's `net` calls `lookup` with `{ all: true }` whenever `autoSelectFamily` is on — the default since Node 20 — and then reads `addresses[0].address`. | **Every real HTTPS send** dies with `TypeError: Invalid IP address: undefined`. The whole ntfy path is dead on any current Node.               | `egress-allowlist.test.ts`'s live 302 fixture | `pinnedLookup` answers both shapes (`src/transport.ts`)                                                                                 |
| 3   | The rung that exhausts `max_attempts` recorded `outcome = 'retryable'` with no `next_attempt_at`, which `delivery_attempts_retryable_has_next` forbids.                                                                         | The **fifth** attempt throws inside the delivery job's transaction, rolls back, and the row never reaches `dead`. The ladder never terminates. | `delivery.test.ts`                            | the exhausting rung is written `permanent` with the reason kept in `detail`; the row's `last_failure_code` becomes `attempts_exhausted` |
| 4   | `retryNotification` reset `attempt_count` to 0, so the next attempt claimed `attempt = 1` again and collided with `delivery_attempts_notification_attempt_idx`.                                                                 | **Dead-letter recovery throws.** The one action the dead-letter view exists to offer is the one that cannot complete.                          | `delivery.test.ts`                            | the counter goes forward; a retry grants a fresh ladder by moving `max_attempts` out by five                                            |

Nos. 1 and 2 are the same shape as Phase 1's F-1/F-4 and Phase 0's P0-4: a
defect that lives only in the state no developer is ever in — here, "a row was
actually claimed" and "a socket was actually opened".

---

## 3. Egress: the refusal matrix

`test/egress-allowlist.test.ts`, project `notifications` (no database needed —
every refusal that does not require the network is provable without one, and the
DNS half runs against an injected resolver that cannot reach a real one).

### 3.1 The matrix

All twenty-five rows are asserted in one table-driven test
(`'the refusal matrix holds for every class of destination'`), against a policy
that allow-lists **more** than production would, so every refusal below is the
guard's and not the allow-list's absence.

| Destination                                                                 | Refusal                 | Why it exists                             |
| --------------------------------------------------------------------------- | ----------------------- | ----------------------------------------- |
| `https://localhost/topic`                                                   | `host_not_allowed`      | the operator never named it               |
| `https://db:5432/`                                                          | `host_not_allowed`      | the container name; see §3.2              |
| `https://metadata.google.internal/`                                         | `host_not_allowed`      | the metadata endpoint by name             |
| `https://db./`                                                              | `host_not_allowed`      | trailing-dot bypass, normalised first     |
| `http://ntfy.notify.test/`                                                  | `scheme_not_allowed`    | there is no cleartext member              |
| `file:///etc/passwd`                                                        | `scheme_not_allowed`    | the classic pivot                         |
| `gopher://…`                                                                | `scheme_not_allowed`    | the other classic pivot                   |
| `https://u:p@ntfy.notify.test/`                                             | `userinfo_in_url`       | a credential that ends up in logs         |
| `ntfy.notify.test/topic`                                                    | `url_malformed`         | not an absolute URL                       |
| `https://ntfy.notify.test:6379/`                                            | `port_not_allowed`      | redis                                     |
| `https://ntfy.notify.test:25/`                                              | `port_not_allowed`      | port 25 is relay, not submission          |
| `https://127.0.0.1/`                                                        | `literal_ip`            | a destination as an address, never a name |
| `https://[::1]/`                                                            | `literal_ip`            | v6 loopback                               |
| `https://2130706433/`                                                       | `literal_ip`            | decimal form of 127.0.0.1                 |
| `https://0x7f000001/`                                                       | `literal_ip`            | hex form of 127.0.0.1                     |
| `https://169.254.169.254/latest/meta-data/`                                 | `literal_ip`            | §3.3                                      |
| `https://2852039166/`, `https://0xa9fea9fe/`, `https://[::ffff:a9fe:a9fe]/` | `literal_ip`            | the metadata IP in every numeric costume  |
| a name resolving to `127.0.0.1`                                             | `private_address`       | rebinding                                 |
| a name resolving into `10/8`                                                | `private_address`       | RFC 1918                                  |
| a name resolving into `100.64/10`                                           | `private_address`       | CGNAT                                     |
| a name resolving to `fd00::1`                                               | `private_address`       | v6 ULA                                    |
| a name resolving to `fe80::1`                                               | `private_address`       | v6 link-local                             |
| a name resolving to `::ffff:127.0.0.1`                                      | `private_address`       | loopback in a v6 hat                      |
| a name resolving to `0.0.0.0`                                               | `private_address`       | the unspecified address                   |
| a name resolving to `224.0.0.1`                                             | `private_address`       | multicast                                 |
| a name that does not resolve                                                | `dns_resolution_failed` | fail closed, never "try it and see"       |
| the operator's own ntfy host                                                | **allowed**             | so the matrix is not vacuously green      |

Plus: `createEgressPolicy` throws on an allow-list entry that is an IP literal or
a wildcard, so an operator cannot spell `127.0.0.1` into the list and reach the
same place by another door. A CR/LF in an ntfy access token is refused by
`assertHeaderValueSafe` before the transport writes a byte
(`header_not_allowed`), a response past the cap is refused **while it arrives**
(`response_too_large`, proved against a real flooding server), and a server that
accepts the socket and answers nothing is refused at the idle timer (`timeout`,
proved against a real silent server).

### 3.2 `'a channel URL pointing at db:5432 is refused'`

Refused three separate times, each against a policy that has had the _previous_
layer deliberately misconfigured, because defence in depth is only real when the
layers are independent:

1. production policy → `host_not_allowed`;
2. an operator who allow-listed `db` → `port_not_allowed`;
3. an operator who allow-listed `db` **and** port 5432 → the name resolves to
   `172.18.0.2` → `private_address`.

And through `createNtfyChannel` with a transport that throws if it is ever
called: `outcome: 'refused'`, `transport.calls === 0` — nothing was dialled.

**Sabotage** — the allow-list check in `checkDestination` replaced with `if (false)`:

```
× a channel URL pointing at db:5432 is refused
AssertionError: expected 'port_not_allowed' to be 'host_not_allowed'
      Tests  1 failed | 9 skipped (10)
```

Red on the first try. Restored; green.

### 3.3 `'169.254.169.254 is refused'`

Asserted as a literal, in all three numeric forms, and — the case that matters —
as a **resolved address**: an allow-listed name whose DNS answer is the metadata
endpoint. A name answering with one public and one metadata address is refused
outright rather than filtered down to the public one, because there is no benign
reason for that answer and filtering it would be an invitation to race it.

**Sabotage A** — `looksLikeIpLiteral`'s `isIP` clause neutered _and_ the
link-local classification removed:

```
× 169.254.169.254 is refused
AssertionError: expected true to be false
```

**Sabotage B** — only the link-local classifier neutered, to show the
_resolved-address_ half fails on its own:

```
× 169.254.169.254 is refused
AssertionError: expected true to be false
 ❯ test/egress-allowlist.test.ts:153:24     ← the guardDestination assertion
```

Both red on the first try. Restored; green.

### 3.4 `'a 302 to an internal host is not followed'`

Two **real** HTTP servers on the loopback: one answering `302` with
`Location:` pointing at the other, and the other counting every request it
receives and answering `INTERNAL SERVICE — THIS SHOULD NEVER BE REACHED`. The
transport is pointed at the redirector directly, because `transport.ts` holds no
policy by design — which is what lets this half be proven without a switch that
turns a security control off.

Asserted: the internal server's counter is **0**; the response is 302; the
location was recorded; the internal body never appeared in what we read;
`classifyStatus(302)` is a _refusal_ (`redirect_not_followed`), not a failure;
and end-to-end through the ntfy adapter the outcome is `refused` with
`httpStatus: 302` and the counter still 0.

**Sabotage** — the transport made to follow the `Location`, the way a naive
client would:

```
× a 302 to an internal host is not followed
AssertionError: the redirect target was never contacted: expected 1 to be +0
 ❯ test/egress-allowlist.test.ts:339:69
```

Red on the first try: the internal service was reached exactly once. Restored;
green.

### 3.5 What the adapters can and cannot do

- The ntfy topic travels in the **JSON body**, never interpolated into a path,
  and is validated `/^[A-Za-z0-9_-]{1,64}$/` before it gets there. There is one
  code path by which user data reaches the wire and it cannot split a request.
- The SMTP adapter is handed the **validated address** as `host` and the
  hostname as `tls.servername`, with `rejectUnauthorized: true`,
  `minVersion: 'TLSv1.2'` and `requireTLS: true` on both schemes — asserted in
  `test/adapters.test.ts`. Opportunistic STARTTLS is not reachable and is not a
  member of the scheme enum.
- A refused destination **never constructs a transport**: `state.options` is
  empty, so no socket options were ever built.
- `verify()` on SMTP calls nodemailer's `verify()` — connect, TLS, authenticate,
  hang up — and puts **no message in anybody's inbox** (`state.messages` is
  empty). No test in this package sends a real email or a real push: every
  database suite registers the fake recorder for _both_ channel kinds, and the
  two allow-listed hosts are under `.test`, which RFC 6761 guarantees never
  resolves.

---

## 4. Custody (D5): the raw column read

`test/db/custody.test.ts` → `'the raw channel config column contains no
plaintext SMTP password'`.

The column is read with a plain `SELECT` through `pg`, exactly as somebody with
a `psql` prompt and a stolen backup would — not through the read model, which
would say "yes, protected" because it never returns the column at all.

What is asserted on the bytes:

- `octet_length > 57` (41 bytes of envelope header + a 16-byte tag), which the
  `CHECK` in 0011 also enforces;
- the password, the username and even the string `password` appear in **no**
  decoding — `utf8`, `latin1`, `ascii`;
- an **8-byte sliding window** over the password, stepping one byte at a time,
  against both `latin1` and `utf8` — a partial or chunked leak that a
  whole-string search walks straight past;
- `to_jsonb(the whole row)` does not contain it either, so no _other_ column
  leaked what `sealed_config` protected;
- and it **opens**, so this is custody and not a corrupted write.

Two further properties, because "not plaintext" is the weakest of the three
things sealing buys:

- **Across rows.** Channel A's bytes lifted into channel B's row fail to open:
  the AAD is `personalfi/v1|notification_channels|sealed_config|<id>|<version>`
  and it names the row, so the Poly1305 tag stops verifying.
- **Across the clear columns.** `UPDATE notification_channels SET
destination_host = 'db'` — the exact move available to somebody with write
  access and no passphrase — makes `openChannelConfig` throw
  `ChannelRefusedError`. The host, port and scheme live _both_ inside the
  envelope and in the clear, and they are compared on every open. That is what
  makes the split (auditable allow-list without the KEK) safe.

**Sabotage** — `createChannel` made to store `Buffer.from(JSON.stringify(config))`
instead of sealing:

```
× the raw channel config column contains no plaintext SMTP password
AssertionError: expected '{"kind":"smtp","scheme":"smtps","host…' not to contain
  'correct-horse-battery-staple-DO-NOT-L…'
 ❯ test/db/custody.test.ts:92:27
```

Red on the first try. Restored; green.

---

## 5. Coalescing, at the window boundary

`test/db/coalescing.test.ts` → `'a 2,000-transaction backfill yields exactly one
notification'` — the §5 exit criterion, asserted **on the outbox and not on the
adapter**, which is the dispatch note's own wording and the difference between
proving coalescing and proving that something downstream swallowed 1,999 rows.

2,000 `budgeting.BudgetThresholdCrossed` envelopes, each with its **own** natural
dedupe key (a backfill crosses thresholds on many lines at once), through the
real pump and the real consumer:

- `SELECT … FROM notification_outbox` → **exactly one row**;
- `group_count = 2000`, `group_key = 'budgeting.thresholds'`;
- `status = 'held'`, `held_reason = 'digest_window'`;
- `dedupe_key = digest:budgeting.thresholds:<window start ISO>` — derived by the
  outbox, never supplied by the rule, so both UNIQUE indexes agree about what
  "the same notification" means;
- `not_before` = the window **end**: a digest that could be sent mid-window
  would not be a digest;
- exactly **one** `notifications.NotificationQueued` in `domain_events`, not
  2,000 — the announcement is on the insert;
- draining while the window is open delivers nothing; closing the window and
  draining delivers **once**, and the body the user would actually read contains
  the figure 2000.

### The boundary, proven from both sides

`'an event one minute after the window boundary opens a second digest'` — two
events one minute _before_ the boundary and one event one minute _after_ it:

|                     | rows | `group_count` |
| ------------------- | ---- | ------------- |
| before the boundary | 1    | 2             |
| after the boundary  | +1   | 1             |

with `rows[0].group_window_end === rows[1].group_window_start`. The separation is
the UNIQUE index's doing, not a job's: a different `group_window_start` derives a
different dedupe key.

**Sabotage** — `digestWindowFor` made to return one window that never closes:

```
× an event one minute after the window boundary opens a second digest
AssertionError: the boundary separated the third event from the first two:
  expected [ { …(29) } ] to have a length of 2 but got 1
```

Red on the first try. Restored; green.

### At-most-once

`test/db/dedupe.test.ts` → `'the same dedupeKey inserted twice delivers once'`.
One fact, two envelopes with different `domain_events` ids → one row,
`group_count` still 1, one `NotificationQueued`, and — the assertion the index
cannot make for us — **the adapter was called once**, with one
`NotificationDelivered`. A consumer replay from `seq = 0` re-delivers the
envelope, collides with the row it already wrote, and sends nothing more. Two
account holders deriving the same key get one notification **each**, because the
index is `(user_id, dedupe_key)`: a duplicate is an annoyance, a dropped alert is
the failure this table exists to prevent.

**Sabotage** — the consumer keyed on `${rendered.dedupeKey}:${event.id}`:

```
× the same dedupeKey inserted twice delivers once
AssertionError: expected [ { …(29) }, { …(29) } ] to have a length of 1 but got 2
```

Red on the first try. Restored; green.

---

## 6. Quiet hours hold, across a DST boundary

`test/db/quiet-hours.test.ts` → `'a quiet-hours notification is held, not
dropped, across a DST boundary'`.

A `PROMPT` notification arrives at **2026-03-08 00:30 America/New_York**
(`05:30Z`, still EST). Spring forward is at 02:00 that morning. Quiet hours are
22:00–07:00, §6 question 3's default.

| Reading                                       | Release                  |              |
| --------------------------------------------- | ------------------------ | ------------ |
| "now + the remaining 390 minutes"             | `12:00Z` = 08:00 local   | an hour late |
| "the next instant the wall clock reads 07:00" | **`11:00Z`** = 07:00 EDT | correct      |

Asserted: `status = 'held'`, `held_reason = 'quiet_hours'`, `not_before` is
exactly `2026-03-08T11:00:00.000Z` and explicitly **not** `12:00Z`. Then, one
second before the release, a drain claims **nothing** and a raw
`SELECT count(*)` still returns 1 — _nothing on the hold path deletes a row_,
which is the half a `DELETE` would fail and a "it was never sent" test would
not catch. At the release instant the row is claimed and delivered, and
`held_reason` is cleared.

The autumn direction is asserted too (`2026-11-01`, a 25-hour day): the naive
arithmetic releases at 06:00 EST — _inside_ the window, which is the one thing
the feature exists to prevent — and `quietHoursReleaseAt` returns `12:00Z`
(07:00 EST), 450 wall-clock minutes later. A `P0_SAFETY` rule is not held at all:
overdraft at 00:30 is precisely the case §6 question 3 reserves immediacy for,
and `notification_rules_p0_ignores_quiet_hours` makes "P0 **and** quiet hours" a
row the schema cannot hold.

**Sabotage** — `quietHoursReleaseAt` replaced with "now + remaining minutes":

```
× a quiet-hours notification is held, not dropped, across a DST boundary
AssertionError: expected '2026-03-08T12:00:00.000Z' to be '2026-03-08T11:00:00.000Z'
```

Red on the first try, and off by exactly the predicted hour. Restored; green.

---

## 7. Dead-letter recovery, walked

`test/db/delivery.test.ts`.

| Step                                            | State                                                                                                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| attempts 1–4 fail retryably                     | `status = 'pending'`, `not_before` moved out by the ladder, one `delivery_attempts` row each with a `next_attempt_at`                                                                              |
| attempt 5 fails                                 | `status = 'dead'`, `dead_at` set, `attempt_count = 5`, `last_failure_code = 'attempts_exhausted'`; the rung is recorded `permanent` with `connection reset … exhausted` in `detail` (see defect 3) |
| a sixth drain                                   | claims **nothing** — `dead` is not a claimable status                                                                                                                                              |
| `listDeadLetters`                               | one entry, with **all five attempts** attached and the title the user would have seen                                                                                                              |
| `domain_events`                                 | five `NotificationFailed`, exactly one with `dead: true`                                                                                                                                           |
| operator fixes the channel, `retryNotification` | `status = 'pending'`, `dead_at` null, history kept                                                                                                                                                 |
| next drain                                      | delivered — as **attempt 6**, not a second attempt 1 (see defect 4)                                                                                                                                |
| `listAttempts`                                  | `[1, 2, 3, 4, 5, 6]`, the last one `delivered`; `listDeadLetters` is empty                                                                                                                         |

Two failure classes that never climb the ladder at all:

- **`refused`** — the egress guard declined. Dead on attempt 1, never retried
  (asserted: the second drain claims nothing), `refusal_code` on the attempt
  _and_ on the row, and it reads as a refusal all the way out to
  `listDeadLetters`. A destination does not become legitimate by waiting, and
  retrying it four more times would turn one refused connection into five and
  make an SSRF probe look like a flapping mail server.
- **`permanent`** — they refused us. Also dead on attempt 1, and `refusal_code`
  is **null**: "we would not connect" and "their server said no" stay
  distinguishable, which is the whole reason `delivery_attempts.outcome` has four
  members and not three.

A notification whose channel was disabled between enqueue and send fails
permanently and is **never dialled** (`channel.deliveries` is empty):
`notification_channels.enabled` is the kill switch for everything behind it.

---

## 8. Registration — the exact lines

**No agent edits these files** (§4); they are the orchestrator's, applied at the
wave boundary. These are the lines, ready to paste.

### `apps/api/src/platform.ts` — inside `MODULE_FLAGS` (after `module.categorization`, line 82)

```ts
  Object.freeze({
    key: 'module.notifications',
    defaultEnabled: false,
    owner: 'notifications',
    removeWhen:
      'never — this is the kill switch for every outbound message the app can send',
  }),
```

`defaultEnabled: false` until the consumer is registered and green, per §4 item 3.
Note that flipping it `true` is _not_ sufficient to send anything: a channel
cannot be `enabled` without a `verified_at`
(`notification_channels_enabled_is_verified`), and the egress policy is
`DENY_ALL` until an operator names a host. "Both built, both disabled until
configured" (§6 Q3) is three independent locks, not a default.

### `apps/api/src/domain.ts` — the `ChannelRegistry` adapter (the `LedgerPort`-shaped piece)

```ts
import {
  createEgressPolicy,
  createNtfyChannel,
  createSmtpChannel,
  type ChannelRegistry,
  type EgressPolicy,
} from '@ctx/notifications';

/**
 * The destinations this deployment may talk to, from operator configuration.
 *
 * An empty list is a deny-all policy and is the correct default: a
 * notification channel is the first outbound path a *user-supplied string*
 * controls, and an operator who has not named a host has not consented to one.
 */
export function createNotificationEgressPolicy(config: AppConfig): EgressPolicy {
  return createEgressPolicy({ allowedHosts: config.notifications.allowedHosts });
}

/** One adapter per kind, both sharing the one policy. */
export function createNotificationChannels(policy: EgressPolicy): ChannelRegistry {
  return { ntfy: createNtfyChannel({ policy }), smtp: createSmtpChannel({ policy }) };
}
```

### `apps/api/src/modules.ts` — inside `appModules()`, after the `module.categorization` entry

```ts
    {
      flagKey: 'module.notifications',
      events: NOTIFICATIONS_EVENTS,
      // Writes to the outbox and stops. Delivery is the job's business: the
      // pump's transaction must not be held open across a call to somebody
      // else's mail server.
      consumers: [createNotificationsConsumer({ database })],
      jobs: [
        createDeliveryJob({
          database,
          registry: options.notificationChannels,
          // Per-user; this deployment has one holder (D6).
          secretBoxFor: () => options.secretBox,
          clock,
        }),
        createDigestJob({ database, clock }),
      ],
      schedules: async (userId: string): Promise<void> => {
        await registerNotificationSchedules(
          platformExecutor(database),
          { userId, timezone: options.timezone },
          clock,
        );
      },
    },
```

with these added to `ModuleWiringOptions`:

```ts
  /** Built by `createNotificationChannels` in domain.ts. */
  readonly notificationChannels: ChannelRegistry;
  /** The delivery job opens a sealed channel config per attempt. */
  readonly secretBox: SecretBox;
```

and to the imports:

```ts
import {
  NOTIFICATIONS_EVENTS,
  createDeliveryJob,
  createDigestJob,
  createNotificationsConsumer,
  registerNotificationSchedules,
} from '@ctx/notifications';
```

`secretBox` is already derived in both processes (`apps/api/src/worker.ts:138`
and the API's `security.requireSecretBox()`), so no new key handling is
introduced: the module is simply unavailable while the app is locked, which is
the same posture `module.connections` already has.

### One thing the orchestrator must add that this package could not

`config.notifications.allowedHosts` does not exist yet.
`packages/config/src/schema.ts` is not this WP's to edit, so the key is specified
here rather than written:

```
NOTIFICATIONS_ALLOWED_HOSTS   comma-separated hostnames, lowercase, no wildcards,
                              no IP literals (createEgressPolicy throws on both).
                              Default: empty ⇒ DENY_ALL_POLICY.
```

Until it exists, wire `DENY_ALL_POLICY` — every send is refused
`host_not_allowed` and nothing else about the package changes.

---

## 9. Checks

```
$ pnpm exec tsc -p tsconfig.json --noEmit
(no error in packages/contexts/notifications/** or packages/db/**)

$ pnpm exec eslint packages/contexts/notifications
(clean — nodemailer is allowed by the `notifications` layer and only there)

$ node scripts/check-schema-ownership.ts
schema-ownership: ok — 95 table(s) claimed across 14 package(s), 57 defined.

$ pnpm exec vitest run --project db
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

`packages/db/test/migrate.test.ts` carries the four names —
`delivery_attempts`, `notification_channels`, `notification_outbox`,
`notification_rules` — in the alphabetical list, with the per-migration
attribution comment for `0011` above it. `OWNERSHIP.md` claims the same four and
nothing else claims them.

---

## 10. Carried, and what a reviewer should attack

1. **No composition-root wiring exists yet** (§8). Until the orchestrator applies
   those lines, no envelope reaches this consumer and no job runs. The package is
   inert, which is the correct state for `defaultEnabled: false`, but it means
   the gate's browser walk item — "a test notification actually delivered" —
   cannot be performed from this WP alone.
2. **`insights.InsightProposed` is declared but unwired**, on purpose (WP 2.6
   owns the event). `test/insight-subscription.test.ts` fails if the subscription
   is removed, and the renderer handles the payload shape §3's WP 2.6 entry
   specifies. Nothing can reach it until the event type is registered.
3. **The gate should re-run `egress-allowlist.test.ts` from inside the worker
   container**, as §5's risk row requires. Everything in §3 was proven on the
   host, where `db` does not resolve at all; inside the compose network it
   resolves to a real address on a real port, which is a strictly stronger test
   and the one that matters.
4. **`verify()` has never reached a real server.** Both adapters' `verify()` are
   proven against injected stubs — the rule for this WP is that no test sends a
   real message. The first real exercise is the gate's "send test" click.
5. **The SMTP `from`/`to` pair is single-recipient by construction** (D6). There
   is no list and no CC; a deployment that wants two recipients configures two
   channels, which is also what keeps one bad address from suppressing the other.
