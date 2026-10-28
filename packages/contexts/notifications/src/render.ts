// SPDX-License-Identifier: MIT
/**
 * Turning an event into a notification: the dedupe key, the group key, and the
 * words.
 *
 * The event types are written as **strings**, not imported from the publishing
 * packages, for the reason every other consumer in this repository gives:
 * importing them would be importing another context and the boundary lint
 * correctly refuses. An event type is a wire contract, the same kind of thing as
 * a URL, and duplicating the string is the honest cost of the decoupling the
 * outbox exists to provide.
 *
 * ## The dedupe key is derived from the fact, never from the event id
 *
 * This is the whole of at-most-once. `budgeting.BudgetThresholdCrossed` is
 * edge-triggered upstream, but a consumer replay re-delivers the same envelope
 * and a `domain_events` id would make each replay a fresh notification. Keying
 * on `(period, line, threshold)` means a replay collides with the row it
 * already wrote and nothing is sent twice — which is also why
 * `test/db/dedupe.test.ts` asserts the *delivery* count and not the insert
 * count.
 *
 * ## The group key is coarse on purpose
 *
 * `budgeting.thresholds` is one key for every envelope in every budget, not one
 * per line. The §5 exit criterion is "a 2,000-transaction backfill yields one
 * coalesced notification", and a backfill crosses thresholds on *many* lines at
 * once — a per-line group key would coalesce each line's own repeats and still
 * produce hundreds of notifications. The digest is "here is what changed", and
 * `groupCount` is how many things changed.
 *
 * ## `insights.InsightProposed` does not exist yet
 *
 * WP 2.6 defines it. The subscription is declared here and in
 * `CONSUMED_EVENT_TYPES` so that the wiring lands with this package rather than
 * being a later edit to a file somebody has to remember; `renderNotification`
 * returns a notification for it today, and
 * `test/insight-subscription.test.ts` asserts the subscription is present and
 * that the renderer handles the payload shape WP 2.6's dispatch entry
 * specifies. Until that event is registered no envelope of that type can reach
 * the pump, so the code is inert rather than speculative.
 *
 * ## `investments.SecurityResolutionFailed`, and the default-rule-seeding
 * decision (WP 4.12c, C-8's UI half; G3-11)
 *
 * `docs/evidence/phase-4/wp4.12b-gate-conditions.md` §8.2 investigated this
 * and left one decision for whoever builds it: a render case alone changes
 * nothing for a user, because **every `notification_rules` row in this
 * application is user-created** — there is no bootstrap or seeding path that
 * gives a fresh install a default rule for anything, and building one would
 * be a cross-cutting change (a bootstrap/seed concern, not a rendering one)
 * touching files this condition does not grant.
 *
 * **The decision: do not build default-rule-seeding in this pass.** The
 * holdings-response half of C-8
 * (`apps/api/src/routes/investments.ts`'s `unresolved` field) is the surface
 * that actually satisfies the condition's own words — "so a position the app
 * could not identify is visible rather than missing" — with **zero**
 * configuration: it is read directly from `domain_events`, not filtered
 * through whether a rule exists. This render case is real, sabotage-tested
 * infrastructure for the day a user (or a future default-rule-seeding
 * change) creates a rule for `investments.SecurityResolutionFailed`, but it
 * is not, by itself, sufficient — and is not claimed to be. Known gap,
 * carried rather than silently declared closed.
 */
import type { NotificationPriority } from '../schema/index.ts';

/**
 * The event types this context reacts to.
 *
 * Five exist today. `insights.InsightProposed` is WP 2.6's and is listed so the
 * consumer is already subscribed when it lands — see the header.
 */
export const CONSUMED_EVENT_TYPES = [
  'budgeting.BudgetThresholdCrossed',
  'recurring.PriceChangeDetected',
  'connections.ConnectionStatusChanged',
  'connections.SyncRunCompleted',
  // WP 4.12c, C-8's UI half (gate-security-review.md G3-11): before this, a
  // position the resolver could not identify was invisible everywhere —
  // `investments.SecurityResolutionFailed` had no render case, no route and
  // no consumer at all. This is the "somewhere a person reads it" half; the
  // route half (`unresolved` on GET /holdings and GET /accounts/:id/holdings`,
  // which needs no rule to exist) is `apps/api/src/routes/investments.ts`.
  'investments.SecurityResolutionFailed',
  // TODO(WP 2.6): `insights.InsightProposed` is defined by the insights
  // platform and is not yet registered in `apps/api/src/platform.ts`. The
  // subscription is declared now so the wiring is this package's concern and
  // not a later edit somewhere else; `test/insight-subscription.test.ts` fails
  // if it is removed.
  'insights.InsightProposed',
  // WP 11.4: the week's Brief, announced once its own composition step has
  // finished — the deterministic lines always, the "Your week" recap as
  // optional text only when the validator passed it (see the render case).
  'insights.BriefRecapReady',
] as const;

export type ConsumedEventType = (typeof CONSUMED_EVENT_TYPES)[number];

export interface RenderedNotification {
  readonly dedupeKey: string;
  readonly groupKey: string;
  readonly title: string;
  readonly bodyMd: string;
  readonly priority: NotificationPriority;
  readonly deepLink: string | null;
}

type Payload = Readonly<Record<string, unknown>>;

function str(payload: Payload, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Render an envelope, or return `null` if this context has nothing to say about
 * it.
 *
 * `null` rather than a throw for an unknown type: the pump's filter already
 * narrows the stream, and a consumer that threw on an event it merely did not
 * recognise would stall the whole offset behind it.
 */
export function renderNotification(
  eventType: string,
  payload: Payload,
): RenderedNotification | null {
  switch (eventType) {
    case 'budgeting.BudgetThresholdCrossed': {
      const threshold = str(payload, 'threshold');
      const lineId = str(payload, 'lineId');
      const periodId = str(payload, 'periodId');
      const available = str(payload, 'available');
      const currency = str(payload, 'currency');
      const overspent = threshold.startsWith('OVERSPENT') || threshold === 'RTA_NEGATIVE';
      return {
        dedupeKey: `budgeting.threshold:${periodId}:${lineId === '' ? 'budget' : lineId}:${threshold}`,
        groupKey: 'budgeting.thresholds',
        title: overspent ? 'A budget envelope is overspent' : 'A budget threshold was crossed',
        bodyMd:
          threshold === 'RTA_NEGATIVE'
            ? `Ready to Assign is negative (${available} ${currency}).`
            : `${humaniseThreshold(threshold)} — ${available} ${currency} available.`,
        priority: overspent ? 'high' : 'normal',
        deepLink: `/budget?period=${encodeURIComponent(periodId)}`,
      };
    }

    case 'recurring.PriceChangeDetected': {
      const id = str(payload, 'priceChangeEventId');
      const confirmed = payload['confirmed'] === true;
      const direction = str(payload, 'direction');
      const impact = str(payload, 'annualImpactMinor');
      const currency = str(payload, 'currency');
      return {
        // `confirmed` is part of the key because 04 §5.1 makes the
        // provisional→confirmed transition a second, genuinely different fact
        // that a rule is entitled to wait for.
        dedupeKey: `recurring.price:${id}:${confirmed ? 'confirmed' : 'provisional'}`,
        groupKey: 'recurring.price-changes',
        title:
          direction === 'INCREASE'
            ? 'A subscription price went up'
            : 'A subscription price went down',
        bodyMd: `Annual impact ${formatMinor(impact)} ${currency}${confirmed ? '.' : ' (not yet confirmed).'}`,
        priority: 'normal',
        deepLink: `/recurring?series=${encodeURIComponent(str(payload, 'seriesId'))}`,
      };
    }

    case 'connections.ConnectionStatusChanged': {
      const connectionId = str(payload, 'connectionId');
      const to = str(payload, 'to');
      if (to === 'active') return null; // Recovery is not news worth waking for.
      return {
        dedupeKey: `connections.status:${connectionId}:${to}`,
        groupKey: 'connections.status',
        title:
          to === 'reauth_required'
            ? `${str(payload, 'provider')} needs reconnection`
            : `${str(payload, 'provider')} is not syncing`,
        bodyMd:
          'Silent data staleness is the failure mode this alert exists for: ' +
          `the connection moved from ${str(payload, 'from')} to ${to}.`,
        priority: to === 'reauth_required' ? 'high' : 'normal',
        deepLink: `/settings/connections?connection=${encodeURIComponent(connectionId)}`,
      };
    }

    case 'connections.SyncRunCompleted': {
      const status = str(payload, 'status');
      if (status === 'success') return null;
      return {
        dedupeKey: `connections.sync:${str(payload, 'syncRunId')}`,
        groupKey: 'connections.sync',
        title: 'A sync did not complete',
        bodyMd: `The ${str(payload, 'trigger')} sync finished ${status}.`,
        priority: 'low',
        deepLink: `/settings/connections?connection=${encodeURIComponent(str(payload, 'connectionId'))}`,
      };
    }

    case 'investments.SecurityResolutionFailed': {
      // Payload shape is `@ctx/investments`' `SecurityResolutionFailed`
      // (`packages/contexts/investments/src/events.ts`), copied as a string
      // per this file's header — provider, syncRunId, providerSecurityId,
      // identifiers[], abstentions[], name.
      const provider = str(payload, 'provider');
      const providerSecurityId = str(payload, 'providerSecurityId');
      const name = str(payload, 'name');
      const displayName = name !== '' ? name : 'A position';
      // De-duped on the *identity* of the failure (provider + whichever of
      // providerSecurityId/name it had), not on the event id: the upstream
      // event may legitimately fire again for the same still-unresolved
      // position on a later sync (its own doc says so), and re-notifying
      // every night for an unresolved position nobody has acted on yet
      // would train a user to ignore this the way a chatty monitor always
      // does.
      const identity = providerSecurityId !== '' ? providerSecurityId : displayName;
      return {
        dedupeKey: `investments.resolution-failed:${provider}:${identity}`,
        groupKey: 'investments.resolution-failures',
        title: 'A position could not be identified',
        bodyMd:
          `${displayName} from ${provider} could not be matched to a security in your ` +
          'portfolio, so it is not included in your holdings yet. See the holdings screen ' +
          'for what is missing.',
        priority: 'normal',
        deepLink: '/investments',
      };
    }

    case 'insights.InsightProposed': {
      // TODO(WP 2.6): the payload shape is the one 02-phase-2-dispatch.md §3
      // WP 2.6 specifies. Until that event is registered, nothing reaches here.
      const insightId = str(payload, 'insightId');
      return {
        dedupeKey: `insights.insight:${insightId}`,
        groupKey: 'insights.proposed',
        title: 'New insight',
        bodyMd: 'An advisor proposed something worth a look.',
        priority: 'low',
        deepLink: `/insights?insight=${encodeURIComponent(insightId)}`,
      };
    }

    case 'insights.BriefRecapReady': {
      // WP 11.4. The deterministic lines are the notification: the week, the
      // counts the Brief carries, where to read it. The recap is optional
      // text after them, only when the payload carries one (it is present
      // only when it passed the validator) and always under the words that
      // say who wrote it — so a channel that truncates (`maxBytes`) cuts the
      // model's paragraph, never the Brief's own lines.
      const briefId = str(payload, 'briefId');
      const isoWeek = str(payload, 'isoWeek');
      const ranked = typeof payload['rankedCount'] === 'number' ? payload['rankedCount'] : 0;
      const attention =
        typeof payload['attentionCount'] === 'number' ? payload['attentionCount'] : 0;
      const nothingMaterial = payload['nothingMaterial'] === true;
      const lines = [
        nothingMaterial || ranked === 0
          ? `Nothing material this week (${isoWeek}).`
          : `${String(ranked)} ranked ${ranked === 1 ? 'action' : 'actions'} this week (${isoWeek}), in order of dollar impact.`,
        ...(attention === 0
          ? []
          : [`${String(attention)} ${attention === 1 ? 'item needs' : 'items need'} attention.`]),
      ];
      const recap = str(payload, 'recap');
      const by = payload['recapBy'];
      const byWords =
        by !== null && typeof by === 'object'
          ? recapAuthor(str(by as Payload, 'provider'), str(by as Payload, 'model'))
          : null;
      const body =
        recap !== '' && byWords !== null
          ? `${lines.join(' ')}\n\nYour week (AI-assisted wording, ${byWords}): ${recap}`
          : lines.join(' ');
      return {
        dedupeKey: `insights.brief:${briefId}`,
        groupKey: 'insights.brief',
        title: 'Your weekly Brief is ready',
        bodyMd: body,
        priority: 'low',
        deepLink: '/brief',
      };
    }

    default:
      return null;
  }
}

const RECAP_PROVIDERS: Readonly<Record<string, string>> = {
  ollama: 'the local model',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
};

/** "the local model qwen2.5…" / "Anthropic claude-…": who wrote the recap, or `null` for a provider not on the list. */
function recapAuthor(provider: string, model: string): string | null {
  const name = RECAP_PROVIDERS[provider];
  if (name === undefined || model === '') return null;
  return `${name} ${model}`;
}

function humaniseThreshold(threshold: string): string {
  switch (threshold) {
    case 'PCT_50':
      return 'Half of this envelope is spent';
    case 'PCT_80':
      return '80% of this envelope is spent';
    case 'PCT_100':
      return 'This envelope is fully spent';
    case 'OVERSPENT_CASH':
      return 'This envelope is overspent in cash';
    case 'OVERSPENT_CREDIT':
      return 'This envelope is overspent on credit';
    default:
      return threshold;
  }
}

/**
 * Minor units (a string, per the wire rule) rendered for a human.
 *
 * Two decimals and no currency symbol: the currency travels beside the figure
 * and a notification body is not the place to start guessing at locale
 * formatting. `BigInt`, never `Number` — the reason `Money.toJSON` exists.
 */
export function formatMinor(minor: string): string {
  if (!/^-?\d+$/.test(minor)) return minor;
  const value = BigInt(minor);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const units = absolute / 100n;
  const cents = absolute % 100n;
  return `${negative ? '-' : ''}${units.toString()}.${cents.toString().padStart(2, '0')}`;
}
