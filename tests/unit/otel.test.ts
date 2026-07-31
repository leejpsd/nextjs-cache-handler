import { describe, expect, it } from "vitest";

import {
  createOtelMetricEmitter,
  type OtelApiLike,
} from "../../src/otel/index.js";
import { createCacheComponentsHandler } from "../../src/cache-components/index.js";

import { MockRedisClient } from "./_mock-client.js";

interface Recorded {
  counterAdds: Array<{
    value: number;
    attrs: Record<string, string> | undefined;
  }>;
  histogramRecords: Array<{
    value: number;
    attrs: Record<string, string> | undefined;
  }>;
  instruments: Array<{ kind: string; name: string }>;
}

function makeFakeApi(): { api: OtelApiLike; recorded: Recorded } {
  const recorded: Recorded = {
    counterAdds: [],
    histogramRecords: [],
    instruments: [],
  };
  const api: OtelApiLike = {
    metrics: {
      getMeter: () => ({
        createCounter: (name) => {
          recorded.instruments.push({ kind: "counter", name });
          return {
            add: (value, attrs) => recorded.counterAdds.push({ value, attrs }),
          };
        },
        createHistogram: (name) => {
          recorded.instruments.push({ kind: "histogram", name });
          return {
            record: (value, attrs) =>
              recorded.histogramRecords.push({ value, attrs }),
          };
        },
      }),
    },
  };
  return { api, recorded };
}

describe("createOtelMetricEmitter", () => {
  it("creates the counter and histogram instruments with default names", () => {
    const { api, recorded } = makeFakeApi();
    createOtelMetricEmitter({ api });
    expect(recorded.instruments).toEqual([
      { kind: "counter", name: "nextjs_cache.events_total" },
      { kind: "histogram", name: "nextjs_cache.op_latency_ms" },
    ]);
  });

  it("counts every event with the type attribute and allowlisted meta only", () => {
    const { api, recorded } = makeFakeApi();
    const emit = createOtelMetricEmitter({ api });

    emit({
      type: "cache.set",
      meta: {
        backend: "redis",
        count: 5, // numeric → dropped
        message: "high-cardinality junk", // not allowlisted → dropped
      },
    });

    expect(recorded.counterAdds).toEqual([
      { value: 1, attrs: { type: "cache.set", backend: "redis" } },
    ]);
    expect(recorded.histogramRecords).toEqual([]); // no ms on the event
  });

  it("records latency into the histogram when the event carries ms", () => {
    const { api, recorded } = makeFakeApi();
    const emit = createOtelMetricEmitter({ api });

    emit({ type: "cache.miss", ms: 12.5 });

    expect(recorded.histogramRecords).toEqual([
      { value: 12.5, attrs: { type: "cache.miss" } },
    ]);
  });

  it("throws a helpful error when @opentelemetry/api is not installed and no api is passed", () => {
    // The test environment intentionally has no @opentelemetry/* packages.
    expect(() => createOtelMetricEmitter()).toThrow(/@opentelemetry\/api/);
  });

  it("wires into a handler's onMetric end to end", async () => {
    const { api, recorded } = makeFakeApi();
    const client = new MockRedisClient();
    client.isOpen = true;
    const handler = createCacheComponentsHandler({
      client: () => client,
      abortTimeoutMs: 100,
      onMetric: createOtelMetricEmitter({ api }),
    });

    await handler.get("missing-key", []);

    expect(
      recorded.counterAdds.some((a) => a.attrs?.type === "cache.miss")
    ).toBe(true);
  });
});
