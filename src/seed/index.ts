/**
 * Build-output cache seeding.
 *
 * `next build` prerenders pages and fetch-cache entries into `.next/`, but a
 * fresh deployment's Redis is empty — every first request pays a full
 * regeneration (and N instances pay it N times). `seedBuildOutput()` walks
 * the build output and inserts it into Redis in the exact record format the
 * incremental handler reads, using **NX semantics**: an entry that a running
 * instance has already written (necessarily newer) is never overwritten.
 *
 * Run it once per deploy, after `next build` and before (or while) traffic
 * shifts — e.g. as a Docker entrypoint step or CI job:
 *
 *   npx nextjs-cache-handler seed            # uses REDIS_URL / DEPLOYMENT_VERSION
 *   npx nextjs-cache-handler seed --dir .next
 *
 * Seeds:
 *   - App Router routes (`.next/server/app/<route>.{html,rsc,meta}` +
 *     PPR `.segments/`) → APP_PAGE records
 *   - Pages Router routes (`.next/server/pages/<route>.{html,json}`) → PAGES
 *   - fetch cache (`.next/cache/fetch-cache/<hash>`) → FETCH records
 */

import fs from "node:fs";
import path from "node:path";

import { buildClient } from "../shared/client/index.js";
import { compressValue } from "../shared/compress.js";
import { buildKey, resolveBuildNamespace } from "../shared/namespace.js";
import { serializeCacheRecord } from "../incremental/serialize.js";
import type {
  Logger,
  RedisClientConfig,
  RedisClientFactory,
  RedisClientLike,
} from "../types.js";

const ONE_YEAR_SEC = 60 * 60 * 24 * 365;
const MIN_TTL_SEC = 60;
const DEFAULT_KEY_PREFIX = "next-incremental:";

export interface SeedOptions {
  client: RedisClientFactory | RedisClientConfig;
  /** Path to the build output. Default: `./.next`. */
  dir?: string;
  keyPrefix?: string;
  buildNamespace?: string | (() => string);
  compression?: "gzip" | "brotli";
  hashTag?: boolean;
  logger?: Pick<Logger, "warn">;
}

export interface SeedSummary {
  /** App Router routes written. */
  routes: number;
  /** Pages Router routes written. */
  pages: number;
  /** fetch-cache entries written. */
  fetch: number;
  /** Entries skipped because a (newer) live entry already existed (NX). */
  skippedExisting: number;
  /** Routes skipped because their files were incomplete or PPR-postponed. */
  skippedIncomplete: number;
  /** Prerendered route handlers (.body) — never seeded, by design. */
  skippedRouteHandlers: number;
  errors: string[];
}

interface ManifestRoute {
  initialRevalidateSeconds?: number | false;
  dataRoute?: string | null;
  srcRoute?: string | null;
}

function clampTtl(revalidate: number | false | undefined): number {
  if (revalidate === false || revalidate === undefined) return ONE_YEAR_SEC;
  if (typeof revalidate === "number" && revalidate > 0) {
    return Math.min(Math.max(Math.ceil(revalidate), MIN_TTL_SEC), ONE_YEAR_SEC);
  }
  return MIN_TTL_SEC;
}

function routeToFileBase(route: string): string {
  return route === "/" ? "/index" : route;
}

function readMeta(file: string): {
  status?: number;
  headers?: Record<string, string>;
  segmentPaths?: string[];
  postponed?: string;
} | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ReturnType<typeof readMeta>;
  } catch {
    return null;
  }
}

async function writeRecord(
  client: RedisClientLike,
  key: string,
  value: unknown,
  revalidateSec: number | false | undefined,
  opts: Required<Pick<SeedOptions, "keyPrefix" | "hashTag">> & {
    ns: string;
    compression?: "gzip" | "brotli";
  }
): Promise<"written" | "skipped"> {
  const record = {
    lastModified: Date.now(),
    value,
    revalidateSec: clampTtl(revalidateSec),
  };
  const redisKey = buildKey(`${opts.keyPrefix}entry:`, opts.ns, key, opts.hashTag);
  const payload = await compressValue(
    serializeCacheRecord(record),
    opts.compression
  );
  const result = await client.set(redisKey, payload, {
    EX: clampTtl(revalidateSec),
    NX: true,
  });
  // Redis returns null (nil) when NX blocks the write.
  return result === null ? "skipped" : "written";
}

export async function seedBuildOutput(options: SeedOptions): Promise<SeedSummary> {
  const dir = path.resolve(options.dir ?? ".next");
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const hashTag = options.hashTag ?? false;
  const ns = resolveBuildNamespace(options.buildNamespace);
  const warn = options.logger?.warn ?? (() => {});
  const summary: SeedSummary = {
    routes: 0,
    pages: 0,
    fetch: 0,
    skippedExisting: 0,
    skippedIncomplete: 0,
    skippedRouteHandlers: 0,
    errors: [],
  };

  const manifestPath = path.join(dir, "prerender-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `[next-cache] no prerender-manifest.json in ${dir} — run \`next build\` first`
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    routes?: Record<string, ManifestRoute>;
  };

  const client = await buildClient(options.client);
  if (!client.isOpen) await client.connect();

  const writeOpts = { keyPrefix, hashTag, ns, ...(options.compression ? { compression: options.compression } : {}) };

  try {
    // ── 1) Prerendered routes ────────────────────────────────────────────────
    for (const [route, info] of Object.entries(manifest.routes ?? {})) {
      try {
        const isPages = typeof info.dataRoute === "string" && info.dataRoute.endsWith(".json");
        const base = routeToFileBase(route);

        if (isPages) {
          const html = path.join(dir, "server", "pages", `${base.slice(1)}.html`);
          const data = path.join(dir, "server", "pages", `${base.slice(1)}.json`);
          if (!fs.existsSync(html)) {
            summary.skippedIncomplete += 1;
            continue;
          }
          const value = {
            kind: "PAGES",
            html: fs.readFileSync(html, "utf8"),
            pageData: fs.existsSync(data)
              ? (JSON.parse(fs.readFileSync(data, "utf8")) as unknown)
              : {},
            headers: undefined,
            status: undefined,
          };
          const r = await writeRecord(client, route, value, info.initialRevalidateSeconds, writeOpts);
          if (r === "written") summary.pages += 1;
          else summary.skippedExisting += 1;
          continue;
        }

        // App Router
        const htmlPath = path.join(dir, "server", "app", `${base.slice(1)}.html`);
        const rscPath = path.join(dir, "server", "app", `${base.slice(1)}.rsc`);
        const metaPath = path.join(dir, "server", "app", `${base.slice(1)}.meta`);
        if (!fs.existsSync(htmlPath) || !fs.existsSync(metaPath)) {
          // Prerendered route handlers emit .body/.meta instead of .html —
          // they are intentionally not seeded, and not "incomplete".
          if (fs.existsSync(path.join(dir, "server", "app", `${base.slice(1)}.body`))) {
            summary.skippedRouteHandlers += 1;
          } else {
            summary.skippedIncomplete += 1;
          }
          continue;
        }
        const meta = readMeta(metaPath) ?? {};
        if (meta.postponed) {
          // PPR routes with resume state cannot be faithfully seeded from
          // static files (the runtime needs `postponed` to resume dynamic
          // holes, and Next intentionally omits the .rsc for them). Serving
          // a seeded copy would freeze the unresolved shell as final HTML.
          summary.skippedIncomplete += 1;
          continue;
        }

        let segmentData: Map<string, Buffer> | undefined;
        if (Array.isArray(meta.segmentPaths) && meta.segmentPaths.length > 0) {
          const segDir = path.join(dir, "server", "app", `${base.slice(1)}.segments`);
          segmentData = new Map();
          for (const segPath of meta.segmentPaths) {
            const segFile = path.join(segDir, `${segPath.slice(1)}.segment.rsc`);
            if (fs.existsSync(segFile)) {
              segmentData.set(segPath, fs.readFileSync(segFile));
            }
          }
          if (segmentData.size !== meta.segmentPaths.length) {
            // Partial segment sets would break PPR resumes — safer to skip.
            summary.skippedIncomplete += 1;
            continue;
          }
        }

        const value: Record<string, unknown> = {
          kind: "APP_PAGE",
          html: fs.readFileSync(htmlPath, "utf8"),
          rscData: fs.existsSync(rscPath) ? fs.readFileSync(rscPath) : undefined,
          headers: meta.headers,
          status: meta.status,
        };
        if (segmentData) value.segmentData = segmentData;

        const r = await writeRecord(client, route, value, info.initialRevalidateSeconds, writeOpts);
        if (r === "written") summary.routes += 1;
        else summary.skippedExisting += 1;
      } catch (err) {
        summary.errors.push(`${route}: ${(err as Error).message}`);
        warn("seed: route failed", { route, message: (err as Error).message });
      }
    }

    // ── 2) fetch cache ───────────────────────────────────────────────────────
    const fetchDir = path.join(dir, "cache", "fetch-cache");
    if (fs.existsSync(fetchDir)) {
      for (const file of fs.readdirSync(fetchDir)) {
        if (file.startsWith(".")) continue;
        try {
          const raw = fs.readFileSync(path.join(fetchDir, file), "utf8");
          const value = JSON.parse(raw) as { kind?: string; revalidate?: number };
          if (value.kind !== "FETCH") continue;
          const r = await writeRecord(client, file, value, value.revalidate, writeOpts);
          if (r === "written") summary.fetch += 1;
          else summary.skippedExisting += 1;
        } catch (err) {
          summary.errors.push(`fetch:${file}: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    const c = client as RedisClientLike & {
      destroy?: () => unknown;
      disconnect?: () => unknown;
    };
    try {
      (c.dispose ?? c.destroy ?? c.disconnect)?.call(c);
    } catch {
      /* best-effort */
    }
  }

  return summary;
}
