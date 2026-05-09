# Example: OpenTelemetry-instrumented cache handler

This directory shows how to forward `@leejpsd/nextjs-cache-handler`
metric events to OpenTelemetry counters and histograms.

The library itself does **not** depend on `@opentelemetry/api`. The
handler exposes an `onMetric(event)` hook with strictly typed events
(see `MetricEventType` in the package); you wire that hook to whichever
observability stack you already run.

## What you get

When this example wrapper is registered as
`cacheHandlers.default` in `next.config.ts`, every cache event lands
in your OTel pipeline:

| OTel instrument | Source | Notable attributes |
|---|---|---|
| `nextjs_cache.events_total` (counter) | every `onMetric` event | `type`, `freshness`, `backend`, `reason`, `op` |
| `nextjs_cache.op_latency_ms` (histogram) | events with a `ms` field (`cache.hit`, `cache.miss`, `cache.stale`, …) | same |

Cache keys and tag names are **never** emitted as attributes —
cardinality stays bounded.

## Files

- `cache-components.cjs` — the wrapper. Copy into your project root and
  point `next.config.ts` `cacheHandlers.default` at it.

## Setup

```bash
npm install @leejpsd/nextjs-cache-handler @opentelemetry/api \
  @opentelemetry/sdk-node @opentelemetry/exporter-metrics-otlp-http
```

Initialize the OTel SDK once at process start (e.g. in
`instrumentation.ts` for Next.js 14+):

```ts
// instrumentation.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

export function register() {
  const sdk = new NodeSDK({
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      }),
      exportIntervalMillis: 10_000,
    }),
  });
  sdk.start();
}
```

Then point Next.js at the wrapper:

```ts
// next.config.ts
import path from "path";
import type { NextConfig } from "next";

const enabled = !!process.env.REDIS_URL;
const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname),
  cacheComponents: true,
  cacheMaxMemorySize: 0,
  cacheHandlers: enabled
    ? { default: require.resolve("./cache-components.cjs") }
    : {},
};
export default nextConfig;
```

## Suggested dashboards

Once metrics are flowing, three views answer most operational questions:

1. **Hit-rate over time** — rate of `nextjs_cache.events_total{type="cache.hit"}`
   divided by the sum of `cache.hit + cache.miss + cache.stale`. Drops
   indicate either an upstream invalidation storm or a cache backend
   issue.
2. **Stale-window leadership distribution** — split
   `cache.stale.refresh.leader` vs `cache.stale.refresh.follower` per
   instance. If one instance is always the leader you may have an
   imbalanced load balancer; if no instances are leaders you may have
   `singleFlight: false`.
3. **Op latency p50/p95/p99** — `nextjs_cache.op_latency_ms` filtered
   to `op="get"`. Tails above 50 ms usually mean network blips between
   the app and Redis; tails near `abortTimeoutMs` mean the AbortSignal
   guard is firing and the in-memory fallback is being used.

## What's NOT in this example

- **Distributed tracing.** The handler runs synchronously inside the
  Next.js render path, so individual `get()` / `set()` calls already
  appear inside the parent server request span. Adding more spans here
  is high noise / low value.
- **Logs.** Use the `logger` option for structured logs; the OTel logs
  signal is intentionally separate from this metrics-focused example.
