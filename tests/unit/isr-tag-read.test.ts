/**
 * How the ISR (singular) handler reads tag states on get() (#34).
 *
 * Default: one MGET for all of an entry's tags. Redis Cluster refuses a
 * multi-key command whose keys sit in different slots (CROSSSLOT), and ISR
 * tag keys are deliberately un-namespaced, so there the handler reads key
 * by key: from the start when the client says `isCluster` or the options say
 * `hashTag`, otherwise from the first CROSSSLOT reply on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createIncrementalCacheHandler } from "../../src/incremental/index.js";
import type { CacheHandlerOptions, MetricEvent } from "../../src/types.js";

import { MockRedisClient } from "./_mock-client.js";

const T0 = 1_700_000_000_000;
const CROSSSLOT = "CROSSSLOT Keys in request don't hash to the same slot";

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

function setup(extra: Partial<CacheHandlerOptions> = {}, client = new MockRedisClient()) {
  client.isOpen = true;
  const events: MetricEvent[] = [];
  const warns: string[] = [];
  const Handler = createIncrementalCacheHandler({
    client: () => client,
    abortTimeoutMs: 100,
    onMetric: (e) => events.push(e),
    logger: { debug() {}, info() {}, warn: (m: string) => warns.push(m), error() {} },
    ...extra,
  });
  return { Handler, client, events, warns };
}

const page = (tags: string) => ({
  kind: "APP_PAGE" as const,
  body: Buffer.from("hello"),
  headers: { "x-next-cache-tags": tags },
});
const ctx = { kind: "APP_PAGE", cacheControl: { revalidate: 60 } };

describe("ISR handler — tag state reads (#34)", () => {
  it("reads all of an entry's tags with one MGET", async () => {
    const { Handler, client, events } = setup();
    const h = new Handler();
    await h.set("/blog", page("posts,authors,_N_T_/blog"), ctx);
    const mget = vi.spyOn(client, "mGet");
    const get = vi.spyOn(client, "get");

    expect(await new Handler().get("/blog", ctx)).not.toBeNull();

    expect(mget).toHaveBeenCalledTimes(1);
    expect(mget.mock.calls[0]![0]).toHaveLength(3);
    expect(get).toHaveBeenCalledTimes(1); // the entry itself
    const read = events.find((e) => e.type === "tag.expiration.read");
    expect(read?.meta).toMatchObject({
      source: "redis",
      op: "incremental.get",
      count: 3,
      strategy: "mget",
    });
  });

  it("an entry with no tags touches no tag keys", async () => {
    const { Handler, client } = setup();
    await new Handler().set("/blog", page(""), ctx);
    const mget = vi.spyOn(client, "mGet");
    const get = vi.spyOn(client, "get");
    expect(await new Handler().get("/blog", ctx)).not.toBeNull();
    expect(mget).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("a single tag is a plain GET, not an MGET", async () => {
    const { Handler, client } = setup();
    await new Handler().set("/blog", page("posts"), ctx);
    const mget = vi.spyOn(client, "mGet");
    const get = vi.spyOn(client, "get");
    expect(await new Handler().get("/blog", ctx)).not.toBeNull();
    expect(mget).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2); // entry + tag
  });

  it("the MGET path still honours a hard invalidation from another instance", async () => {
    const { Handler } = setup();
    const a = new Handler();
    const b = new Handler();
    await a.set("/blog", page("posts,authors"), ctx);
    vi.setSystemTime(new Date(T0 + 10));
    await b.revalidateTag("authors"); // hard
    expect(await new Handler().get("/blog", ctx)).toBeNull();
  });

  it("the MGET path still honours a soft invalidation from another instance", async () => {
    const { Handler } = setup();
    const a = new Handler();
    const b = new Handler();
    await a.set("/blog", page("posts,authors"), ctx);
    vi.setSystemTime(new Date(T0 + 10));
    await b.revalidateTag("posts", { expire: 3600 }); // soft
    const got = await new Handler().get("/blog", ctx);
    expect(got).not.toBeNull();
    // Served, but backdated past its revalidate window so Next refreshes it.
    expect(got!.lastModified).toBeLessThan(T0);
  });

  it("hashTag: true reads key by key from the start (Cluster hint)", async () => {
    const { Handler, client, events } = setup({ hashTag: true });
    await new Handler().set("/blog", page("posts,authors,_N_T_/blog"), ctx);
    const mget = vi.spyOn(client, "mGet");
    const get = vi.spyOn(client, "get");
    expect(await new Handler().get("/blog", ctx)).not.toBeNull();
    expect(mget).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(4); // entry + 3 tags
    expect(events.find((e) => e.type === "tag.expiration.read")?.meta?.strategy).toBe("per-key");
  });

  it("a client flagged isCluster reads key by key from the start", async () => {
    const client = new MockRedisClient();
    client.isCluster = true;
    const { Handler } = setup({}, client);
    await new Handler().set("/blog", page("posts,authors"), ctx);
    const mget = vi.spyOn(client, "mGet");
    const get = vi.spyOn(client, "get");
    expect(await new Handler().get("/blog", ctx)).not.toBeNull();
    expect(mget).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("a CROSSSLOT reply latches the handler to per-key reads without losing that read", async () => {
    const { Handler, client, warns } = setup();
    const a = new Handler();
    const b = new Handler();
    await a.set("/blog", page("posts,authors,_N_T_/blog"), ctx);
    vi.setSystemTime(new Date(T0 + 10));
    await b.revalidateTag("authors"); // hard: the read below must see it

    const mget = vi.spyOn(client, "mGet").mockRejectedValue(new Error(CROSSSLOT));
    const get = vi.spyOn(client, "get");

    // First request: MGET fails, the same read retries key by key.
    expect(await new Handler().get("/blog", ctx)).toBeNull();
    expect(mget).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(4); // entry + 3 tags
    expect(warns.filter((w) => /CROSSSLOT/.test(w))).toHaveLength(1);

    // Later requests: no MGET probe any more.
    await a.set("/other", page("x,y"), ctx);
    expect(await new Handler().get("/other", ctx)).not.toBeNull();
    expect(mget).toHaveBeenCalledTimes(1);
    expect(warns.filter((w) => /CROSSSLOT/.test(w))).toHaveLength(1);
  });

  it("ioredis's client-side same-slot check (auto-pipelining) latches too", async () => {
    const { Handler, client, warns } = setup();
    await new Handler().set("/blog", page("posts,authors"), ctx);
    const mget = vi
      .spyOn(client, "mGet")
      .mockRejectedValue(
        new Error("All the keys in a pipeline command should belong to the same slot")
      );
    expect(await new Handler().get("/blog", ctx)).not.toBeNull();
    expect(await new Handler().get("/blog", ctx)).not.toBeNull();
    expect(mget).toHaveBeenCalledTimes(1);
    expect(warns.filter((w) => /CROSSSLOT/.test(w))).toHaveLength(1);
  });

  it("any other MGET error falls back to the local tag mirror and does not latch", async () => {
    const { Handler, client, warns } = setup();
    await new Handler().set("/blog", page("posts,authors"), ctx);
    const mget = vi.spyOn(client, "mGet").mockRejectedValueOnce(new Error("boom"));

    // Degrades like before: the entry is served from what the mirror knows.
    expect(await new Handler().get("/blog", ctx)).not.toBeNull();
    expect(mget).toHaveBeenCalledTimes(1);
    expect(warns.some((w) => /CROSSSLOT/.test(w))).toBe(false);

    // Next request tries MGET again.
    expect(await new Handler().get("/blog", ctx)).not.toBeNull();
    expect(mget).toHaveBeenCalledTimes(2);
  });

  it("per-key reads after a latch still honour invalidations", async () => {
    const { Handler, client } = setup();
    const a = new Handler();
    await a.set("/blog", page("posts,authors"), ctx);
    vi.spyOn(client, "mGet").mockRejectedValueOnce(new Error(CROSSSLOT));
    expect(await new Handler().get("/blog", ctx)).not.toBeNull(); // latches

    vi.setSystemTime(new Date(T0 + 10));
    await new Handler().revalidateTag("posts"); // hard
    expect(await new Handler().get("/blog", ctx)).toBeNull();
  });
});
