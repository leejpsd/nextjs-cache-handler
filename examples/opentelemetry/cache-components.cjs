/**
 * OpenTelemetry-instrumented cache handler wiring.
 *
 * This is a *reference adapter*, not part of the published runtime: the
 * library deliberately ships zero observability dependencies. Copy this
 * file (or its shape) into your own project, then point next.config.ts
 * at it.
 *
 * What you get:
 *   - one OTel counter per metric event type (cache.hit, cache.miss,
 *     cache.stale, cache.stale.refresh.leader, etc.)
 *   - a histogram of operation latencies for events that carry `ms`
 *   - low-cardinality attributes only (event type, freshness bucket,
 *     backend) — no cache keys or tag names
 *
 * The handler itself never blocks on telemetry: if the OTel SDK throws,
 * the createEmitter() in the library swallows it and continues.
 */
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createCacheComponentsHandler } = require("@leejpsd/nextjs-cache-handler/cache-components");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { metrics } = require("@opentelemetry/api");

// Bring your own MeterProvider — see @opentelemetry/sdk-node setup. This
// example assumes it's already configured before this file is imported.
const meter = metrics.getMeter("nextjs-cache-handler", "0.2.0");

// One counter for every event type the library emits. Keep cardinality
// low: type + low-cardinality meta only.
const eventCounter = meter.createCounter("nextjs_cache.events_total", {
  description: "Cache handler events by type",
});
const opLatency = meter.createHistogram("nextjs_cache.op_latency_ms", {
  description: "Per-op latency for events that carry an `ms` field",
  unit: "ms",
});

function lowCardinalityAttrs(event) {
  // Promote a small allowlist of meta fields into attributes. Anything
  // else stays out of the metric pipeline.
  const meta = event.meta || {};
  const out = { type: event.type };
  if (typeof meta.freshness === "string") out.freshness = meta.freshness;
  if (typeof meta.backend === "string") out.backend = meta.backend;
  if (typeof meta.reason === "string") out.reason = meta.reason;
  if (typeof meta.op === "string") out.op = meta.op;
  return out;
}

module.exports = createCacheComponentsHandler({
  client: {
    type: "redis",
    url: process.env.REDIS_URL,
  },
  buildNamespace: process.env.DEPLOYMENT_VERSION,
  abortTimeoutMs: 1500,
  staleWhileRevalidate: true,
  singleFlight: true,
  onMetric(event) {
    const attrs = lowCardinalityAttrs(event);
    eventCounter.add(1, attrs);
    if (typeof event.ms === "number") {
      opLatency.record(event.ms, attrs);
    }
  },
});
