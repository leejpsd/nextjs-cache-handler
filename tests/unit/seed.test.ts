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
    expect(client.kv.has("next-incremental:entry:deploy-1:/index")).toBe(true);
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
    // Next < 16.3.8 asks for the normalized page path: "/" is "/index".
    const out = await h.get("/index", { kind: "APP_PAGE" });
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
    client.kv.set("next-incremental:entry:d:/index", "live-entry");
    const summary = await seedBuildOutput({ client: () => client, dir, buildNamespace: "d" });
    expect(client.kv.get("next-incremental:entry:d:/index")).toBe("live-entry");
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

describe("seedBuildOutput — route-scoped keys (Next.js 16.3.8+, #16)", () => {
  // Key shapes as emitted by `next build` on 16.4.6.
  const APP_KEY =
    "/route-cache/APP_PAGE/c6377dd9ce6a1c2cd100eb4344e843eb4639b9ed26f84643f77680e9eb454c4b/$/index";
  const PAGES_KEY =
    "/route-cache/PAGES/15486b37abb374f051d18b6144500dc7d20cbed764c27b2cea8a3bd79ab9af48/$/legacy";

  function writeAppMeta(routeCache: unknown) {
    fs.writeFileSync(
      path.join(dir, "server", "app", "index.meta"),
      JSON.stringify({ status: 200, headers: { "x-next-cache-tags": "home" }, routeCache })
    );
  }

  it("seeds an App Router route under meta.routeCache.key, not the pathname", async () => {
    writeAppMeta({
      key: APP_KEY,
      owner: { kind: "APP_PAGE", sourceRoute: "/page" },
      isFallback: false,
    });

    const client = mock();
    const summary = await seedBuildOutput({ client: () => client, dir, buildNamespace: "deploy-1" });

    expect(summary).toMatchObject({ routes: 2, pages: 1, errors: [] });
    expect(client.kv.has(`next-incremental:entry:deploy-1:${APP_KEY}`)).toBe(true);
    expect(client.kv.has("next-incremental:entry:deploy-1:/index")).toBe(false);
    // "/blog" has no routeCache metadata → still seeded by page path.
    expect(client.kv.has("next-incremental:entry:deploy-1:/blog")).toBe(true);
  });

  it("seeds a Pages Router route under the key in its .meta", async () => {
    fs.writeFileSync(
      path.join(dir, "server", "pages", "legacy.meta"),
      JSON.stringify({
        routeCache: {
          key: PAGES_KEY,
          owner: { kind: "PAGES", sourceRoute: "/legacy" },
          isFallback: false,
        },
      })
    );

    const client = mock();
    const summary = await seedBuildOutput({ client: () => client, dir, buildNamespace: "deploy-1" });

    expect(summary).toMatchObject({ routes: 2, pages: 1, errors: [] });
    expect(client.kv.has(`next-incremental:entry:deploy-1:${PAGES_KEY}`)).toBe(true);
    expect(client.kv.has("next-incremental:entry:deploy-1:/legacy")).toBe(false);
  });

  it("the handler serves the seeded entry when asked for the scoped key", async () => {
    writeAppMeta({ key: APP_KEY });

    const client = mock();
    await seedBuildOutput({ client: () => client, dir, buildNamespace: "deploy-1" });

    const Handler = createIncrementalCacheHandler({
      client: () => client,
      abortTimeoutMs: 100,
      buildNamespace: "deploy-1",
    });
    const h = new Handler();
    const out = await h.get(APP_KEY, { kind: "APP_PAGE" });
    expect(out).not.toBeNull();
    const value = out!.value as { kind: string; html: string };
    expect(value.html).toContain("home");
    // The page path is not a key the 16.3.8+ runtime ever asks for.
    h.resetRequestCache();
    expect(await h.get("/index", { kind: "APP_PAGE" })).toBeNull();
  });

  it.each([
    ["an empty key", { key: "" }],
    ["a non-string key", { key: 42 }],
    ["no key", {}],
    ["a null routeCache", null],
  ])("falls back to the page path for %s", async (_label, routeCache) => {
    writeAppMeta(routeCache);

    const client = mock();
    const summary = await seedBuildOutput({ client: () => client, dir, buildNamespace: "deploy-1" });

    expect(summary.errors).toEqual([]);
    expect(client.kv.has("next-incremental:entry:deploy-1:/index")).toBe(true);
  });

  it("an unreadable Pages .meta falls back to the page path", async () => {
    fs.writeFileSync(path.join(dir, "server", "pages", "legacy.meta"), "{not json");

    const client = mock();
    const summary = await seedBuildOutput({ client: () => client, dir, buildNamespace: "deploy-1" });

    expect(summary).toMatchObject({ pages: 1, errors: [] });
    expect(client.kv.has("next-incremental:entry:deploy-1:/legacy")).toBe(true);
  });
});

describe("seedBuildOutput — page path normalization (Next.js < 16.3.8)", () => {
  // Next stores and looks up prerendered routes under normalizePagePath():
  // "/" → "/index", "/index" → "/index/index", "/index/sub" → "/index/index/sub".
  function addIndexNamedRoutes() {
    const app = path.join(dir, "server", "app");
    const manifestPath = path.join(dir, "prerender-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      routes: Record<string, unknown>;
    };
    manifest.routes["/index"] = { initialRevalidateSeconds: 60, dataRoute: "/index.rsc" };
    manifest.routes["/index/sub"] = { initialRevalidateSeconds: 60, dataRoute: "/index/sub.rsc" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    fs.mkdirSync(path.join(app, "index", "index"), { recursive: true });
    fs.writeFileSync(path.join(app, "index", "index.html"), "<html>index-named</html>");
    fs.writeFileSync(path.join(app, "index", "index.meta"), JSON.stringify({ status: 200 }));
    fs.writeFileSync(path.join(app, "index", "index", "sub.html"), "<html>index-sub</html>");
    fs.writeFileSync(path.join(app, "index", "index", "sub.meta"), JSON.stringify({ status: 200 }));
  }

  async function seededHtml(client: MockRedisClient, key: string): Promise<string | null> {
    const Handler = createIncrementalCacheHandler({
      client: () => client,
      abortTimeoutMs: 100,
      buildNamespace: "deploy-1",
    });
    const out = await new Handler().get(key, { kind: "APP_PAGE" });
    return out ? (out.value as { kind: string; html: string }).html : null;
  }

  it("seeds the root route under /index, the key the runtime asks for", async () => {
    const client = mock();
    await seedBuildOutput({ client: () => client, dir, buildNamespace: "deploy-1" });

    expect(client.kv.has("next-incremental:entry:deploy-1:/index")).toBe(true);
    expect(client.kv.has("next-incremental:entry:deploy-1:/")).toBe(false);
    expect(await seededHtml(client, "/index")).toContain("home");
  });

  it("an /index-prefixed route reads its own files and gets its own key", async () => {
    addIndexNamedRoutes();

    const client = mock();
    const summary = await seedBuildOutput({ client: () => client, dir, buildNamespace: "deploy-1" });

    expect(summary).toMatchObject({ routes: 4, skippedExisting: 0, errors: [] });
    expect(await seededHtml(client, "/index")).toContain("home");
    expect(await seededHtml(client, "/index/index")).toContain("index-named");
    expect(await seededHtml(client, "/index/index/sub")).toContain("index-sub");
  });
});
