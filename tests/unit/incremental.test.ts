import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIncrementalCacheHandler } from "../../src/incremental/index.js";

import { MockRedisClient } from "./_mock-client.js";

const T0 = 1_700_000_000_000;

let originalPhase: string | undefined;
let originalDeployment: string | undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  originalPhase = process.env.NEXT_PHASE;
  originalDeployment = process.env.DEPLOYMENT_VERSION;
  delete process.env.NEXT_PHASE;
});
afterEach(() => {
  vi.useRealTimers();
  if (originalPhase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = originalPhase;
  if (originalDeployment === undefined) delete process.env.DEPLOYMENT_VERSION;
  else process.env.DEPLOYMENT_VERSION = originalDeployment;
});

function setup() {
  const client = new MockRedisClient();
  client.isOpen = true;
  const Handler = createIncrementalCacheHandler({
    client: () => client,
    abortTimeoutMs: 100,
  });
  return { Handler, client };
}

describe("incremental cacheHandler — basic ISR round-trip", () => {
  it("set then get returns the stored record", async () => {
    const { Handler } = setup();
    const h = new Handler();
    await h.set(
      "/blog",
      { kind: "APP_PAGE", body: Buffer.from("hello"), headers: {} },
      { kind: "APP_PAGE" }
    );
    const out = await h.get("/blog", { kind: "APP_PAGE" });
    expect(out).not.toBeNull();
    expect(out?.lastModified).toBe(T0);
    expect(Buffer.isBuffer((out?.value as unknown as { body: Buffer }).body)).toBe(true);
  });

  it("revalidatedTags in ctx force a cache miss for matching entries", async () => {
    const { Handler } = setup();
    const h = new Handler({ revalidatedTags: ["posts"] });
    await h.set(
      "/blog",
      {
        kind: "APP_PAGE",
        body: Buffer.from("hello"),
        headers: { "x-next-cache-tags": "posts,layout" },
      },
      { kind: "APP_PAGE" }
    );
    const out = await h.get("/blog", { kind: "APP_PAGE" });
    expect(out).toBeNull();
  });

  it("revalidateTag (soft) writes a tag state that future get() observes", async () => {
    const { Handler } = setup();
    const h = new Handler();
    await h.set(
      "/blog",
      {
        kind: "FETCH",
        revalidate: 60,
        tags: ["posts"],
        body: "x",
      },
      { kind: "FETCH" }
    );
    // Soft revalidate (no durations.expire).
    vi.setSystemTime(new Date(T0 + 100));
    await h.revalidateTag("posts");

    // FETCH kind treats `stale` as expired → next get() returns null.
    const out = await h.get("/blog", { kind: "FETCH" });
    expect(out).toBeNull();
  });

  it("hard revalidate (durations.expire=0) propagates to APP_PAGE entries", async () => {
    const { Handler } = setup();
    const h = new Handler();
    await h.set(
      "/blog",
      {
        kind: "APP_PAGE",
        body: Buffer.from("x"),
        headers: { "x-next-cache-tags": "posts" },
      },
      { kind: "APP_PAGE" }
    );
    vi.setSystemTime(new Date(T0 + 100));
    await h.revalidateTag("posts", { expire: 0 });
    const out = await h.get("/blog", { kind: "APP_PAGE" });
    expect(out).toBeNull();
  });

  it("instance-local: tag bypasses Redis (uses memory only)", async () => {
    const { Handler, client } = setup();
    const h = new Handler();
    const setSpy = vi.spyOn(client, "set");
    await h.set(
      "/blog",
      {
        kind: "APP_PAGE",
        body: Buffer.from("x"),
        headers: { "x-next-cache-tags": "instance-local:user-1" },
      },
      { kind: "APP_PAGE" }
    );
    expect(setSpy).not.toHaveBeenCalled();
    const out = await h.get("/blog", {
      kind: "APP_PAGE",
      tags: ["instance-local:user-1"],
    });
    expect(out).not.toBeNull();
  });
});

describe("incremental cacheHandler — soft tag SWR for route entries (#1 outer layer)", () => {
  it("backdates lastModified after a soft revalidateTag so Next regenerates in background", async () => {
    const { Handler } = setup();
    const h = new Handler();
    await h.set(
      "/page",
      {
        kind: "APP_PAGE",
        body: Buffer.from("html"),
        headers: { "x-next-cache-tags": "soft-probe" },
      },
      { kind: "APP_PAGE", cacheControl: { revalidate: 300 } }
    );

    vi.setSystemTime(new Date(T0 + 10));
    await h.revalidateTag("soft-probe", {}); // soft: stale-only tag state

    h.resetRequestCache();
    const out = await h.get("/page", { kind: "APP_PAGE" });
    // Entry is SERVED (not null — that would be a blocking miss)...
    expect(out).not.toBeNull();
    // ...aged just past ITS OWN revalidate window (300s) — far enough for
    // Next to schedule a background regen, near enough to stay inside the
    // route's expire window (backdating a year would cross expire and turn
    // SWR into a blocking re-render).
    expect(out!.lastModified).toBe(T0 + 10 - 301 * 1000);
  });

  it("degrades to a blocking miss when the entry has no SWR window (revalidate: false)", async () => {
    const { Handler } = setup();
    const h = new Handler();
    await h.set(
      "/page",
      { kind: "APP_PAGE", body: Buffer.from("html"), headers: { "x-next-cache-tags": "soft-probe" } },
      { kind: "APP_PAGE" } // no revalidate → ONE_YEAR sentinel, no SWR window
    );
    vi.setSystemTime(new Date(T0 + 10));
    await h.revalidateTag("soft-probe", {});
    h.resetRequestCache();
    expect(await h.get("/page", { kind: "APP_PAGE" })).toBeNull();
  });

  it("a fresh regeneration after the soft invalidation serves normally again", async () => {
    const { Handler } = setup();
    const h = new Handler();
    await h.set(
      "/page",
      { kind: "APP_PAGE", body: Buffer.from("v1"), headers: { "x-next-cache-tags": "soft-probe" } },
      { kind: "APP_PAGE", cacheControl: { revalidate: 300 } }
    );
    vi.setSystemTime(new Date(T0 + 10));
    await h.revalidateTag("soft-probe", {});
    // Background regeneration writes a new entry AFTER the invalidation.
    vi.setSystemTime(new Date(T0 + 5_000));
    await h.set(
      "/page",
      { kind: "APP_PAGE", body: Buffer.from("v2"), headers: { "x-next-cache-tags": "soft-probe" } },
      { kind: "APP_PAGE", cacheControl: { revalidate: 300 } }
    );
    h.resetRequestCache();
    const out = await h.get("/page", { kind: "APP_PAGE" });
    expect(out).not.toBeNull();
    expect(out!.lastModified).toBe(T0 + 5_000); // NOT backdated anymore
  });

  it("hard revalidateTag still yields a blocking miss", async () => {
    const { Handler } = setup();
    const h = new Handler();
    await h.set(
      "/page",
      { kind: "APP_PAGE", body: Buffer.from("html"), headers: { "x-next-cache-tags": "soft-probe" } },
      { kind: "APP_PAGE" }
    );
    vi.setSystemTime(new Date(T0 + 10));
    await h.revalidateTag("soft-probe"); // no durations → hard ({expired})
    h.resetRequestCache();
    expect(await h.get("/page", { kind: "APP_PAGE" })).toBeNull();
  });
});

describe("incremental cacheHandler — Next 15 ctx compatibility", () => {
  it("ctx.revalidate (Next 15 shape, no cacheControl) drives the Redis TTL", async () => {
    const { Handler, client } = setup();
    const h = new Handler();
    const setSpy = vi.spyOn(client, "set");

    await h.set(
      "/blog",
      { kind: "APP_PAGE", body: Buffer.from("x"), headers: {} },
      { kindHint: "app", revalidate: 300 }
    );

    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      EX: 300,
    });
  });

  it("Next 16 cacheControl.revalidate wins over a Next 15 ctx.revalidate", async () => {
    const { Handler, client } = setup();
    const h = new Handler();
    const setSpy = vi.spyOn(client, "set");

    await h.set(
      "/blog",
      { kind: "APP_PAGE", body: Buffer.from("x"), headers: {} },
      { cacheControl: { revalidate: 120 }, revalidate: 300 }
    );

    expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      EX: 120,
    });
  });

  it("kindHint 'fetch' (Next 15) observes soft tag staleness", async () => {
    const { Handler } = setup();
    const h = new Handler();
    await h.set(
      "/data",
      { kind: "FETCH", tags: ["feed"], data: { body: "x" } } as never,
      { kindHint: "fetch", revalidate: 60 }
    );

    await h.revalidateTag("feed", {}); // soft: stale-only tag state

    const out = await h.get("/data", { kindHint: "fetch", tags: ["feed"] });
    expect(out).toBeNull();
  });

  it("soft tag staleness leaves non-fetch pages intact (Next 15 shape)", async () => {
    const { Handler } = setup();
    const h = new Handler();
    await h.set(
      "/page",
      {
        kind: "APP_PAGE",
        body: Buffer.from("x"),
        headers: { "x-next-cache-tags": "feed" },
      },
      { kindHint: "app", revalidate: 60 }
    );

    await h.revalidateTag("feed", {});

    const out = await h.get("/page", { kindHint: "app" });
    expect(out).not.toBeNull();
  });
});

describe("incremental cacheHandler — request-scoped read deduplication", () => {
  const body = {
    kind: "APP_PAGE",
    body: Buffer.from("hello"),
    headers: {},
  } as const;

  it("parallel get() calls for the same key share one Redis GET", async () => {
    const { Handler, client } = setup();
    const h = new Handler();
    await h.set("/blog", { ...body }, { kind: "APP_PAGE" });
    const getSpy = vi.spyOn(client, "get");

    const [a, b] = await Promise.all([
      h.get("/blog", { kind: "APP_PAGE" }),
      h.get("/blog", { kind: "APP_PAGE" }),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("sequential get() calls within one request are also deduplicated", async () => {
    const { Handler, client } = setup();
    const h = new Handler();
    await h.set("/blog", { ...body }, { kind: "APP_PAGE" });
    const getSpy = vi.spyOn(client, "get");

    await h.get("/blog", { kind: "APP_PAGE" });
    await h.get("/blog", { kind: "APP_PAGE" });

    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("resetRequestCache() drops the memo so the next request reads Redis again", async () => {
    const { Handler, client } = setup();
    const h = new Handler();
    await h.set("/blog", { ...body }, { kind: "APP_PAGE" });
    const getSpy = vi.spyOn(client, "get");

    await h.get("/blog", { kind: "APP_PAGE" });
    h.resetRequestCache();
    await h.get("/blog", { kind: "APP_PAGE" });

    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it("set() invalidates a memoized miss for the same key", async () => {
    const { Handler } = setup();
    const h = new Handler();

    expect(await h.get("/blog", { kind: "APP_PAGE" })).toBeNull(); // memoized miss
    await h.set("/blog", { ...body }, { kind: "APP_PAGE" });
    const out = await h.get("/blog", { kind: "APP_PAGE" });

    expect(out).not.toBeNull();
    expect(out?.lastModified).toBe(T0);
  });

  it("different keys are not conflated", async () => {
    const { Handler, client } = setup();
    const h = new Handler();
    await h.set("/a", { ...body }, { kind: "APP_PAGE" });
    await h.set("/b", { ...body }, { kind: "APP_PAGE" });
    const getSpy = vi.spyOn(client, "get");

    await h.get("/a", { kind: "APP_PAGE" });
    await h.get("/b", { kind: "APP_PAGE" });

    expect(getSpy).toHaveBeenCalledTimes(2);
  });
});

describe("incremental cacheHandler — fallback: 'never' consistency (parity with plural handler)", () => {
  function setupNever() {
    const client = new MockRedisClient();
    client.isOpen = true;
    const Handler = createIncrementalCacheHandler({
      client: () => client,
      abortTimeoutMs: 100,
      fallback: "never",
    });
    return { Handler, client };
  }

  it("a Redis outage surfaces as a miss instead of degrading to per-process memory", async () => {
    const { Handler, client } = setupNever();
    const h = new Handler();
    client.failNext(2); // SET fails, then GET fails
    await h.set(
      "/blog",
      { kind: "APP_PAGE", body: Buffer.from("hello"), headers: {} },
      { kind: "APP_PAGE" }
    );
    const out = await h.get("/blog", { kind: "APP_PAGE" });
    expect(out).toBeNull();
  });

  it("set() during a Redis failure leaves no memory copy behind", async () => {
    const { Handler, client } = setupNever();
    const h = new Handler();
    client.failNext(1); // Redis SET fails
    await h.set(
      "/blog",
      { kind: "APP_PAGE", body: Buffer.from("hello"), headers: {} },
      { kind: "APP_PAGE" }
    );
    // Redis is healthy again but empty — the entry must not resurface from
    // the (unwritten) memory fallback.
    expect(client.kv.size).toBe(0);
    const out = await h.get("/blog", { kind: "APP_PAGE" });
    expect(out).toBeNull();
  });

  it("get() after a healthy Redis write misses when Redis starts failing", async () => {
    const { Handler, client } = setupNever();
    const h = new Handler();
    await h.set(
      "/blog",
      { kind: "APP_PAGE", body: Buffer.from("hello"), headers: {} },
      { kind: "APP_PAGE" }
    );
    client.failNext(10);
    const out = await h.get("/blog", { kind: "APP_PAGE" });
    expect(out).toBeNull();
  });

  it("instance-local: tags still store and serve from memory (explicit opt-in wins)", async () => {
    const { Handler, client } = setupNever();
    const h = new Handler();
    const setSpy = vi.spyOn(client, "set");
    await h.set(
      "/local",
      {
        kind: "APP_PAGE",
        body: Buffer.from("x"),
        headers: { "x-next-cache-tags": "instance-local:user-1" },
      },
      { kind: "APP_PAGE" }
    );
    expect(setSpy).not.toHaveBeenCalled();
    const out = await h.get("/local", {
      kind: "APP_PAGE",
      tags: ["instance-local:user-1"],
    });
    expect(out).not.toBeNull();
  });
});

describe("incremental cacheHandler — BUILD_NAMESPACE deployment isolation", () => {
  it("entry from old DEPLOYMENT_VERSION is invisible after deploy roll", async () => {
    process.env.DEPLOYMENT_VERSION = "deploy-A";
    const { Handler, client } = setup();
    let h = new Handler();
    await h.set(
      "/blog",
      { kind: "APP_PAGE", body: Buffer.from("v1"), headers: {} },
      { kind: "APP_PAGE" }
    );

    // Roll deployment.
    process.env.DEPLOYMENT_VERSION = "deploy-B";
    h = new Handler();
    const out = await h.get("/blog", { kind: "APP_PAGE" });
    expect(out).toBeNull();

    // Old key is still in Redis (it'll TTL out), but the new namespace can't
    // see it. This is exactly the static-chunk-404 incident remediation.
    const keysWithOld = [...client.kv.keys()].filter((k) => k.includes("deploy-A"));
    expect(keysWithOld.length).toBe(1);
  });
});

describe("incremental cacheHandler — build phase skip", () => {
  it("set() does not call Redis during phase-production-build", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    const { Handler, client } = setup();
    const setSpy = vi.spyOn(client, "set");
    const h = new Handler();
    await h.set(
      "/blog",
      { kind: "APP_PAGE", body: Buffer.from("x"), headers: {} },
      { kind: "APP_PAGE" }
    );
    expect(setSpy).not.toHaveBeenCalled();
  });
});
