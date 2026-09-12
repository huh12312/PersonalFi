// SPDX-License-Identifier: MIT

/**
 * Counters and gauges for the pump, the queue, and the scheduler.
 *
 * In-process and deliberately tiny: no Prometheus client, no registry of metric
 * types, no third-party dependency in a repo whose threat model includes supply
 * chain (decision D14). `snapshot()` is the whole read API, and both the future
 * in-app sync dashboard and an opt-in `/metrics` exposition render from it.
 *
 * Labels are flattened into the metric name (`events.processed{consumer=x}`)
 * because there are a dozen series in this app, not a million, and a flat string
 * key is both cheaper and easier to assert on in a test.
 */

export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly gauges: Readonly<Record<string, number>>;
}

export interface Metrics {
  increment(name: string, labels?: MetricLabels, by?: number): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  snapshot(): MetricsSnapshot;
  reset(): void;
}

export function metricKey(name: string, labels?: MetricLabels): string {
  if (labels === undefined) return name;
  const entries = Object.entries(labels).filter(([, value]) => value !== '');
  if (entries.length === 0) return name;
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${name}{${entries.map(([key, value]) => `${key}=${value}`).join(',')}}`;
}

export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();

  return {
    increment(name, labels, by = 1) {
      const key = metricKey(name, labels);
      counters.set(key, (counters.get(key) ?? 0) + by);
    },
    gauge(name, value, labels) {
      gauges.set(metricKey(name, labels), value);
    },
    snapshot() {
      return {
        counters: Object.fromEntries(counters),
        gauges: Object.fromEntries(gauges),
      };
    },
    reset() {
      counters.clear();
      gauges.clear();
    },
  };
}

/** Metric names, in one place so the dashboard and the emitters cannot drift. */
export const METRIC = {
  eventsAppended: 'platform.events.appended',
  eventsProcessed: 'platform.events.processed',
  eventsSkippedDuplicate: 'platform.events.skipped_duplicate',
  eventsFailed: 'platform.events.failed',
  eventsDeadLettered: 'platform.events.dead_lettered',
  consumerBatches: 'platform.consumer.batches',
  consumerLagEvents: 'platform.consumer.lag_events',
  consumerStatus: 'platform.consumer.status',
  jobsEnqueued: 'platform.jobs.enqueued',
  jobsDeduped: 'platform.jobs.deduped',
  jobsStarted: 'platform.jobs.started',
  jobsSucceeded: 'platform.jobs.succeeded',
  jobsFailed: 'platform.jobs.failed',
  jobsDead: 'platform.jobs.dead',
  jobsReclaimed: 'platform.jobs.reclaimed',
  jobsInFlight: 'platform.jobs.in_flight',
  schedulerTicks: 'platform.scheduler.ticks',
  schedulerFired: 'platform.scheduler.fired',
  schedulerIsLeader: 'platform.scheduler.is_leader',
} as const;

/**
 * `status` is a string; a gauge is a number. Consumers are the one place we want
 * both, so map the four states onto an ordinal where higher is worse and a
 * dashboard can threshold on `>= 3`.
 */
export const CONSUMER_STATUS_ORDINAL: Readonly<Record<string, number>> = Object.freeze({
  running: 0,
  replaying: 1,
  paused: 2,
  failed: 3,
});
