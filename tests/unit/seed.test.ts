import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { seedBuildOutput } from "../../src/seed/index.js";
import { createIncrementalCacheHandler } from "../../src/incremental/index.js";
import { deserializeCacheRecord } from "../../src/incremental/serialize.js";

import { MockRedisClient } from "./_mock-client.js";

let dir: string;

function fixture() {
  const app = path.join(dir, "server", "app");
  fs.mkdirSync(path.join(app, "blog.segments", "blog"), { recursive: true });
  fs.mkdirSync(path.join(dir, "server", "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "cache", "fetch-cache"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "prerender-manifest.json"),
    JSON.stringify({
      routes: {
        "/": { initialRevalidateSeconds: 60, dataRoute: "/index.rsc" },
        "/blog": { initialRevalidateSeconds: 300, dataRoute: "/blog.rsc" },
        "/legacy": { initialRevalidateSeconds: 120, dataRoute: "/legacy.json" },
        "/broken": { initialRevalidateSeconds: 60, dataRoute: "/broken.rsc" },
      },
    })
  );

  // App route "/" — plain (no segments)
  fs.writeFileSync(path.join(app, "index.html"), "<html>home</html>");
  fs.writeFileSync(path.join(app, "index.rsc"), "RSC-home");
  fs.writeFileSync(
    path.join(app, "index.meta"),
    JSON.stringify({ status: 200, headers: { "x-next-cache-tags": "home" } })
  );

  // App route "/blog" — PPR segments
  fs.writeFileSync(path.join(app, "blog.html"), "<html>blog</html>");
  fs.writeFileSync(path.join(app, "blog.rsc"), "RSC-blog");
  fs.writeFileSync(
    path.join(app, "blog.meta"),
    JSON.stringify({
      status: 200,
      headers: { "x-next-cache-tags": "posts" },
      segmentPaths: ["/_index", "/blog/__PAGE__"],
    })
  );
  fs.writeFileSync(path.join(app, "blog.segments", "_index.segment.rsc"), "seg-index");
  fs.writeFileSync(
    path.join(app, "blog.segments", "blog", "__PAGE__.segment.rsc"),
    "seg-page"
  );

  // Pages route
  fs.writeFileSync(path.join(dir, "server", "pages", "legacy.html"), "<html>legacy</html>");
  fs.writeFileSync(
    path.join(dir, "server", "pages", "legacy.json"),
    JSON.stringify({ pageProps: { n: 1 } })
  );

  // fetch cache
  fs.writeFileSync(
    path.join(dir, "cache", "fetch-cache", "abc123"),
    JSON.stringify({
      kind: "FETCH",
      data: { headers: {}, body: "ZmV0Y2g=", status: 200, url: "https://x" },
      revalidate: 900,
      tags: ["feed"],
    })
  );
  // "/broken" has manifest entry but no files → skippedIncomplete
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nch-seed-"));
  fixture();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function mock() {
  const client = new MockRedisClient();
  client.isOpen = true;
  return client;
}

describe("seedBuildOutput", () => {
  it("seeds app routes, pages routes, and fetch entries with correct keys", async () => {
    const client = mock();
    const summary = await seedBuildOutput({
      client: () => client,
      dir,
      buildNamespace: "deploy-1",
    });

    expect(summary).toMatchObject({
      routes: 2,
      pages: 1,
      fetch: 1,
      skippedExisting: 0,
      skippedIncomplete: 1, // "/broken"
      errors: [],
    });
    expect(client.kv.has("next-incremental:entry:deploy-1:/")).toBe(true);
    expect(client.kv.has("next-incremental:entry:deploy-1:/blog")).toBe(true);
    expect(client.kv.has("next-incremental:entry:deploy-1:/legacy")).toBe(true);
    expect(client.kv.has("next-incremental:entry:deploy-1:abc123")).toBe(true);
  });

  it("writes records the incremental handler can actually serve", async () => {
    const client = mock();
    await seedBuildOutput({ client: () => client, dir, buildNamespace: "deploy-1" });

    const Handler = createIncrementalCacheHandler({
      client: () => client,
      abortTimeoutMs: 100,
      buildNamespace: "deploy-1",
    });
    const h = new Handler();
    const out = await h.get("/", { kind: "APP_PAGE" });
    expect(out).not.toBeNull();
    const value = out!.value as { kind: string; html: string; status: number };
    expect(value.kind).toBe("APP_PAGE");
    expect(value.html).toContain("home");
    expect(out!.tags).toContain("home");
  });

  it("round-trips PPR segmentData as a Map of Buffers", async () => {
    const client = mock();
    await seedBuildOutput({ client: () => client, dir, buildNamespace: "d" });

    const raw = client.kv.get("next-incremental:entry:d:/blog")!;
    const rec = deserializeCacheRecord<{
      value: { segmentData?: Map<string, Buffer> };
      revalidateSec?: number;
    }>(raw)!;
    expect(rec.revalidateSec).toBe(300);
    const seg = rec.value.segmentData!;
    expect(seg).toBeInstanceOf(Map);
    expect(seg.get("/_index")?.toString()).toBe("seg-index");
    expect(seg.get("/blog/__PAGE__")?.toString()).toBe("seg-page");
  });

  it("NX: never overwrites an existing (newer) live entry", async () => {
    const client = mock();
    client.kv.set("next-incremental:entry:d:/", "live-entry");
    const summary = await seedBuildOutput({ client: () => client, dir, buildNamespace: "d" });
    expect(client.kv.get("next-incremental:entry:d:/")).toBe("live-entry");
    expect(summary.skippedExisting).toBe(1);
    expect(summary.routes).toBe(1); // "/blog" still seeded
  });

  it("skips a PPR route whose segment files are incomplete", async () => {
    fs.rmSync(path.join(dir, "server", "app", "blog.segments", "blog", "__PAGE__.segment.rsc"));
    const client = mock();
    const summary = await seedBuildOutput({ client: () => client, dir, buildNamespace: "d" });
    expect(client.kv.has("next-incremental:entry:d:/blog")).toBe(false);
    expect(summary.skippedIncomplete).toBe(2); // /blog + /broken
  });

  it("BLOCKER regression: skips PPR routes carrying resume state (postponed)", async () => {
    // A seeded copy without `postponed` would freeze the unresolved shell
    // as the final page — such routes must be skipped, not seeded.
    const app = path.join(dir, "server", "app");
    fs.writeFileSync(path.join(app, "ppr.html"), "<html>shell</html>");
    fs.writeFileSync(
      path.join(app, "ppr.meta"),
      JSON.stringify({ status: 200, headers: {}, postponed: "RESUME-STATE" })
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "prerender-manifest.json"), "utf8")
    );
    manifest.routes["/ppr"] = { initialRevalidateSeconds: 60, dataRoute: "/ppr.rsc" };
    fs.writeFileSync(path.join(dir, "prerender-manifest.json"), JSON.stringify(manifest));

    const client = mock();
    const summary = await seedBuildOutput({ client: () => client, dir, buildNamespace: "d" });
    expect(client.kv.has("next-incremental:entry:d:/ppr")).toBe(false);
    expect(summary.skippedIncomplete).toBe(2); // /ppr + /broken
  });

  it("prerendered route handlers (.body) are counted separately, not as incomplete", async () => {
    const app = path.join(dir, "server", "app");
    fs.writeFileSync(path.join(app, "api-route.body"), "payload");
    fs.writeFileSync(path.join(app, "api-route.meta"), JSON.stringify({ status: 200 }));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "prerender-manifest.json"), "utf8")
    );
    manifest.routes["/api-route"] = { initialRevalidateSeconds: 60, dataRoute: null };
    fs.writeFileSync(path.join(dir, "prerender-manifest.json"), JSON.stringify(manifest));

    const client = mock();
    const summary = await seedBuildOutput({ client: () => client, dir, buildNamespace: "d" });
    expect(summary.skippedRouteHandlers).toBe(1);
    expect(summary.skippedIncomplete).toBe(1); // only /broken
  });

  it("throws a clear error without a build", async () => {
    await expect(
      seedBuildOutput({ client: () => mock(), dir: path.join(dir, "nope") })
    ).rejects.toThrow(/next build/);
  });
});
