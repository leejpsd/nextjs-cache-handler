/**
 * Process-local metric counters with an optional emit hook.
 *
 * Two layers:
 *   1. Always-on counter accumulation (free for app-side `getMetricSnapshot()`)
 *   2. Optional `onMetric` callback for OpenTelemetry / StatsD / Datadog
 *      forwarding (no transitive deps in this package)
 *
 * Cardinality discipline: callers pass low-cardinality `meta` (e.g. operation
 * name, freshness bucket). Cache keys and tag names are never emitted.
 */

import type { MetricEmitter, MetricEvent, MetricEventType } from "../types.js";

interface Counter {
  count: number;
  totalMs: number;
  lastTs: number;
}

const counters = new Map<MetricEventType, Counter>();

function bump(event: MetricEvent): void {
  const existing = counters.get(event.type);
  if (existing) {
    existing.count += 1;
    if (event.ms !== undefined) existing.totalMs += event.ms;
    existing.lastTs = Date.now();
    return;
  }
  counters.set(event.type, {
    count: 1,
    totalMs: event.ms ?? 0,
    lastTs: Date.now(),
  });
}

/** Bind the user-supplied emitter, return a curried emit function. */
export function createEmitter(onMetric?: MetricEmitter): MetricEmitter {
  return (event: MetricEvent) => {
    bump(event);
    if (onMetric) {
      try {
        onMetric(event);
      } catch {
        // Telemetry must never crash the cache layer.
      }
    }
  };
}

/** Snapshot of current counters. Useful for `/api/metrics` style endpoints. */
export function getMetricSnapshot(): Record<
  MetricEventType,
  { count: number; avgMs: number; lastTs: number } | undefined
> {
  const out: Partial<
    Record<MetricEventType, { count: number; avgMs: number; lastTs: number }>
  > = {};
  for (const [type, c] of counters.entries()) {
    out[type] = {
      count: c.count,
      avgMs: c.count > 0 ? c.totalMs / c.count : 0,
      lastTs: c.lastTs,
    };
  }
  return out as Record<
    MetricEventType,
    { count: number; avgMs: number; lastTs: number } | undefined
  >;
}

/** Reset counters. Test-only export; not part of the public API. */
export function __resetMetricsForTest(): void {
  counters.clear();
}
