/**
 * Built-in OpenTelemetry metric emitter.
 *
 * `@opentelemetry/api` stays out of this package's dependency tree: the
 * module talks to it through structural types and resolves it at runtime
 * (injectable for tests / custom setups). Install `@opentelemetry/api` and
 * configure a MeterProvider (e.g. `@opentelemetry/sdk-node`) in your app,
 * then:
 *
 * ```ts
 * import { createOtelMetricEmitter } from "@leejpsd/nextjs-cache-handler/otel";
 *
 * createCacheComponentsHandler({
 *   client: { type: "redis", url: process.env.REDIS_URL },
 *   onMetric: createOtelMetricEmitter(),
 * });
 * ```
 *
 * Instruments:
 *   - counter   `nextjs_cache.events_total`  — one increment per event
 *   - histogram `nextjs_cache.op_latency_ms` — for events carrying `ms`
 *
 * Cardinality discipline: only an allowlist of meta fields (freshness,
 * backend, reason, op) is promoted to attributes. Cache keys and tag names
 * never enter the metric pipeline.
 */

import type { MetricEmitter, MetricEvent } from "../types.js";

export interface OtelCounterLike {
  add(value: number, attributes?: Record<string, string>): void;
}

export interface OtelHistogramLike {
  record(value: number, attributes?: Record<string, string>): void;
}

export interface OtelMeterLike {
  createCounter(
    name: string,
    options?: { description?: string }
  ): OtelCounterLike;
  createHistogram(
    name: string,
    options?: { description?: string; unit?: string }
  ): OtelHistogramLike;
}

/** The subset of `@opentelemetry/api` this adapter touches. */
export interface OtelApiLike {
  metrics: {
    getMeter(name: string, version?: string): OtelMeterLike;
  };
}

export interface OtelEmitterOptions {
  /**
   * The `@opentelemetry/api` module (or a compatible object). Defaults to
   * `require("@opentelemetry/api")` — pass explicitly in ESM-only setups
   * or tests.
   */
  api?: OtelApiLike;
  /** Meter name. Default: "nextjs-cache-handler". */
  meterName?: string;
  /** Counter instrument name. Default: "nextjs_cache.events_total". */
  counterName?: string;
  /** Histogram instrument name. Default: "nextjs_cache.op_latency_ms". */
  histogramName?: string;
}

const ATTR_ALLOWLIST = ["freshness", "backend", "reason", "op"] as const;

function lowCardinalityAttrs(event: MetricEvent): Record<string, string> {
  const out: Record<string, string> = { type: event.type };
  const meta = event.meta ?? {};
  for (const key of ATTR_ALLOWLIST) {
    const v = meta[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

function resolveApi(): OtelApiLike {
  try {
    // Runtime-only lookup — @opentelemetry/api is NOT a dependency of this
    // package. It must come from the application.
    return require("@opentelemetry/api") as OtelApiLike;
  } catch {
    throw new Error(
      "[next-cache] createOtelMetricEmitter needs @opentelemetry/api. " +
        "Install it in your app (npm i @opentelemetry/api) and configure a " +
        "MeterProvider, or pass the module via the `api` option."
    );
  }
}

/**
 * Build a `MetricEmitter` that forwards every handler event to OpenTelemetry.
 * Wire it to the `onMetric` option — emitter errors are already swallowed by
 * the handlers, so telemetry can never break the cache path.
 */
export function createOtelMetricEmitter(
  options: OtelEmitterOptions = {}
): MetricEmitter {
  const api = options.api ?? resolveApi();
  const meter = api.metrics.getMeter(
    options.meterName ?? "nextjs-cache-handler"
  );
  const counter = meter.createCounter(
    options.counterName ?? "nextjs_cache.events_total",
    { description: "Cache handler events by type" }
  );
  const histogram = meter.createHistogram(
    options.histogramName ?? "nextjs_cache.op_latency_ms",
    {
      description: "Per-op latency for events that carry an `ms` field",
      unit: "ms",
    }
  );

  return (event: MetricEvent) => {
    const attrs = lowCardinalityAttrs(event);
    counter.add(1, attrs);
    if (typeof event.ms === "number") {
      histogram.record(event.ms, attrs);
    }
  };
}
