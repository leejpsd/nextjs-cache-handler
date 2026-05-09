import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bufferToStream,
} from "../../src/cache-components/serialize.js";
import { createCacheComponentsHandler } from "../../src/cache-components/index.js";
import type {
  CacheComponentsEntry,
  MetricEvent,
} from "../../src/types.js";

import { MockRedisClient } from "./_mock-client.js";

const T0 = 1_700_000_000_000;

function makeStaleEntry(
  overrides: Partial<CacheComponentsEntry> = {}
): CacheComponentsEntry {
  return {
    value: bufferToStream(Buffer.from("stale-body")),
    tags: ["posts"],
    stale: 60,
    timestamp: T0,
    expire: 3600,
    revalidate: 1, // crossed almost immediately
    ...overrides,
  };
}

let originalPhase: string | undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  originalPhase = process.env.NEXT_PHASE;
  delete process.env.NEXT_PHASE;
});
afterEach(() => {
  vi.useRealTimers();
  if (originalPhase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = originalPhase;
});

function setup(opts: { singleFlight?: boolean } = {}) {
  const events: MetricEvent[] = [];
  const client = new MockRedisClient();
  client.isOpen = true;
  const handler = createCacheComponentsHandler({
    client: () => client,
    abortTimeoutMs: 100,
    onMetric: (e) => events.push(e),
    ...opts,
  });
  return { handler, client, events };
}

describe("single-flight refresh lock — disabled by default", () => {
  it("emits 'cache.stale' (legacy event) when singleFlight is unset", async () => {
    const { handler, events } = setup();

    await handler.set("k", Promise.resolve(makeStaleEntry()));
    vi.setSystemTime(new Date(T0 + 5_000)); // past revalidate=1s, stale window
    const got = await handler.get("k", []);

    expect(got).toBeDefined();
    expect(events.some((e) => e.type === "cache.stale")).toBe(true);
    expect(
      events.some((e) =>
        e.type.startsWith("cache.stale.refresh.")
      )
    ).toBe(false);
  });

  it("does not call the refresh-lock script when disabled", async () => {
    const { handler, client } = setup();
    const evalSpy = vi.spyOn(client, "eval");
    const evalShaSpy = vi.spyOn(client, "evalSha");

    await handler.set("k", Promise.resolve(makeStaleEntry()));
    // Reset spy state — the set() also calls Lua.
    evalSpy.mockClear();
    evalShaSpy.mockClear();

    vi.setSystemTime(new Date(T0 + 5_000));
    await handler.get("k", []);

    // No lock script should be invoked when singleFlight is off.
    const allCalls = [...evalSpy.mock.calls, ...evalShaSpy.mock.calls];
    const calledLock = allCalls.some((args) => {
      const first = String(args[0] ?? "");
      return first.includes("refresh-tag-lock") || first.includes("SETNX");
    });
    expect(calledLock).toBe(false);
  });
});

describe("single-flight refresh lock — enabled", () => {
  it("emits 'cache.stale.refresh.leader' on the first stale read", async () => {
    const { handler, events } = setup({ singleFlight: true });

    await handler.set("k", Promise.resolve(makeStaleEntry()));
    vi.setSystemTime(new Date(T0 + 5_000));
    const got = await handler.get("k", []);

    expect(got).toBeDefined();
    expect(
      events.some((e) => e.type === "cache.stale.refresh.leader")
    ).toBe(true);
  });

  it("emits 'cache.stale.refresh.follower' when another instance already holds the lock", async () => {
    // Two handlers sharing one Redis (mock). Same cache key, both reach
    // stale at the same time. First call wins the lock, second is the
    // follower.
    const eventsA: MetricEvent[] = [];
    const eventsB: MetricEvent[] = [];
    const client = new MockRedisClient();
    client.isOpen = true;

    const handlerA = createCacheComponentsHandler({
      client: () => client,
      abortTimeoutMs: 100,
      singleFlight: true,
      onMetric: (e) => eventsA.push(e),
    });
    const handlerB = createCacheComponentsHandler({
      client: () => client,
      abortTimeoutMs: 100,
      singleFlight: true,
      onMetric: (e) => eventsB.push(e),
    });

    await handlerA.set("k", Promise.resolve(makeStaleEntry()));
    vi.setSystemTime(new Date(T0 + 5_000));

    // First read on A: leader (acquires the lock).
    const a = await handlerA.get("k", []);
    expect(a).toBeDefined();

    // Second read on B (against the same Redis): follower.
    const b = await handlerB.get("k", []);
    expect(b).toBeDefined();

    expect(
      eventsA.some((e) => e.type === "cache.stale.refresh.leader")
    ).toBe(true);
    expect(
      eventsB.some((e) => e.type === "cache.stale.refresh.follower")
    ).toBe(true);
  });

  it("still serves the stale entry when the lock script fails", async () => {
    // The lock attempt is the second Redis call inside get() (after the
    // entry GET). We monkey-patch only the lock script invocation so the
    // GET succeeds and the entry is served, but lock acquisition fails.
    const { handler, client, events } = setup({ singleFlight: true });

    await handler.set("k", Promise.resolve(makeStaleEntry()));
    vi.setSystemTime(new Date(T0 + 5_000));

    const realEval = client.eval.bind(client);
    const realEvalSha = client.evalSha.bind(client);
    let lockCallSeen = 0;
    vi.spyOn(client, "eval").mockImplementation(async (script, opts) => {
      if (script.includes("refresh-tag-lock") || script.includes("SETNX")) {
        lockCallSeen += 1;
        throw new Error("[mock] forced lock failure");
      }
      return realEval(script, opts);
    });
    vi.spyOn(client, "evalSha").mockImplementation(async (sha, opts) => {
      // The mock client's evalSha looks up by SHA; we can't easily
      // identify the script from sha alone, so we identify it by KEYS
      // shape: lock keys end with the lock-suffix segment.
      const isLockKey = (opts.keys[0] ?? "").includes(":lock:");
      if (isLockKey) {
        lockCallSeen += 1;
        throw new Error("[mock] forced lock failure");
      }
      return realEvalSha(sha, opts);
    });

    const got = await handler.get("k", []);
    expect(got).toBeDefined();
    expect(lockCallSeen).toBeGreaterThan(0);
    // Lock failed → follower path (safe default), entry still served.
    expect(
      events.some((e) => e.type === "cache.stale.refresh.follower")
    ).toBe(true);
  });

  it("does not acquire the lock when entry is fresh (only stale entries take the path)", async () => {
    const { handler, events } = setup({ singleFlight: true });

    await handler.set("k", Promise.resolve(makeStaleEntry({ revalidate: 60 })));
    // Stay inside revalidate window — fresh.
    vi.setSystemTime(new Date(T0 + 30_000));
    const got = await handler.get("k", []);

    expect(got).toBeDefined();
    expect(events.some((e) => e.type === "cache.hit")).toBe(true);
    expect(
      events.some((e) =>
        e.type.startsWith("cache.stale.refresh.")
      )
    ).toBe(false);
  });
});
