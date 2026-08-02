/**
 * Redis Cluster e2e — runs against a real local 3-master cluster
 * (scripts/cluster-test-env.sh up; ports 7100-7102).
 *
 * What this pins down beyond the single-node integration suite:
 *   - multi-key Lua scripts (set-with-tags / revalidate-hard) work under
 *     CROSSSLOT constraints via `hashTag: true`
 *   - the cluster-aware scanIterator (per-master cursors) feeds refreshTags
 *   - cross-"instance" (two handler objects) tag propagation on a cluster
 *   - tagPubSub degrades gracefully (no subscribe on the cluster adapter)
 */
import { describe, expect, it } from "vitest";

import { createCacheComponentsHandler } from "../../src/cache-components/index.js";
import { createIncrementalCacheHandler } from "../../src/incremental/index.js";
import {
  bufferToStream,
  readStreamFully,
} from "../../src/cache-components/serialize.js";
import type { CacheComponentsEntry } from "../../src/types.js";

const NODES = [
  { host: "127.0.0.1", port: 7100 },
  { host: "127.0.0.1", port: 7101 },
  { host: "127.0.0.1", port: 7102 },
];

function entry(overrides: Partial<CacheComponentsEntry> = {}): CacheComponentsEntry {
  return {
    value: bufferToStream(Buffer.from("cluster body")),
    tags: ["posts"],
    stale: 60,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 60,
    ...overrides,
  };
}

function plural(ns: string, extra: Record<string, unknown> = {}) {
  return createCacheComponentsHandler({
    client: { type: "cluster", nodes: NODES },
    hashTag: true,
    abortTimeoutMs: 3000,
    buildNamespace: ns,
    ...extra,
  });
}

describe("Redis Cluster e2e — cacheHandlers (plural)", () => {
  it("set-with-tags Lua + get round-trip under hashTag slotting", async () => {
    const ns = `cl-${Math.floor(Math.random() * 1e9)}`;
    const h = plural(ns);
    await h.set("k1", Promise.resolve(entry({ tags: ["a", "b"] })));
    const got = await h.get("k1", []);
    expect(got).toBeDefined();
    expect((await readStreamFully(got!.value)).toString()).toBe("cluster body");
    expect(got!.tags).toEqual(["a", "b"]);
  });

  it("hard updateTags (revalidate-hard Lua) deletes tagged entries", async () => {
    const ns = `cl-${Math.floor(Math.random() * 1e9)}`;
    const h = plural(ns);
    await h.set("k1", Promise.resolve(entry({ tags: ["posts"] })));
    await h.set("k2", Promise.resolve(entry({ tags: ["posts"] })));

    await h.updateTags(["posts"], { expire: 0 });

    expect(await h.get("k1", [])).toBeUndefined();
    expect(await h.get("k2", [])).toBeUndefined();
  });

  it("soft invalidation propagates to a second handler via refreshTags (cluster scanIterator)", async () => {
    const ns = `cl-${Math.floor(Math.random() * 1e9)}`;
    const a = plural(ns);
    const b = plural(ns);

    await a.set("k", Promise.resolve(entry({ tags: ["feed"] })));
    await new Promise((r) => setTimeout(r, 20));
    const before = Date.now();
    await a.updateTags([`feed`]);

    await b.refreshTags(); // scans per-master cursors
    const learned = await b.getExpiration(["feed"]);
    expect(learned).toBeGreaterThanOrEqual(before - 5);
  });

  it("tagPubSub on a cluster degrades to polling with a single warning", async () => {
    const ns = `cl-${Math.floor(Math.random() * 1e9)}`;
    const warns: string[] = [];
    const h = plural(ns, {
      tagPubSub: true,
      logger: { debug() {}, info() {}, warn: (m: string) => warns.push(m), error() {} },
    });
    await h.get("warm", []);
    await h.get("warm", []);
    expect(warns.filter((w) => w.includes("tagPubSub unavailable")).length).toBe(1);

    // And the normal path still works.
    await h.set("k", Promise.resolve(entry()));
    expect(await h.get("k", [])).toBeDefined();
  });
});

describe("Redis Cluster e2e — cacheHandler (ISR)", () => {
  it("round-trip + hard revalidateTag", async () => {
    const ns = `cl-${Math.floor(Math.random() * 1e9)}`;
    const Handler = createIncrementalCacheHandler({
      client: { type: "cluster", nodes: NODES },
      hashTag: true,
      abortTimeoutMs: 3000,
      buildNamespace: ns,
    });
    const h = new Handler();

    await h.set(
      "/page",
      {
        kind: "APP_PAGE",
        body: Buffer.from("hello-cluster"),
        headers: { "x-next-cache-tags": "posts" },
      },
      { kind: "APP_PAGE", cacheControl: { revalidate: 300 } }
    );
    const out = await h.get("/page", { kind: "APP_PAGE" });
    expect(out).not.toBeNull();

    await h.revalidateTag("posts"); // hard
    h.resetRequestCache();
    expect(await h.get("/page", { kind: "APP_PAGE" })).toBeNull();
  });
});
