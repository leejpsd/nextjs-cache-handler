/**
 * MCP server for @leejpsd/nextjs-cache-handler caches.
 *
 * Gives AI agents safe, structured access to a running deployment's Redis
 * cache: health, key search/inspection, tag invalidation state, SWR
 * simulation, and (explicitly confirmed) invalidation.
 *
 * Env: REDIS_URL (required), DEPLOYMENT_VERSION (optional — narrows
 * namespace-aware tools), CACHE_KEY_PREFIX / ISR_KEY_PREFIX (optional
 * overrides, defaults next-cache: / next-incremental:).
 *
 * All tools are read-only except `invalidate_tag`, which is DRY-RUN unless
 * `confirm: true` is passed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, type RedisClientType } from "redis";
import { gunzipSync, brotliDecompressSync } from "node:zlib";

const PLURAL_PREFIX = process.env.CACHE_KEY_PREFIX ?? "next-cache:";
const ISR_PREFIX = process.env.ISR_KEY_PREFIX ?? "next-incremental:";
const NS = process.env.DEPLOYMENT_VERSION;
/** Mirror of the handler's hashTag option — REQUIRED when the app sets
 *  hashTag: true (Redis Cluster), otherwise every 'use cache' key this
 *  server computes is wrong. */
const HASH_TAG = process.env.HASH_TAG === "true";
const wrapNs = (ns: string): string =>
  HASH_TAG && !ns.startsWith("{") ? `{${ns}}` : ns;
/** Escape Redis MATCH glob metacharacters (agent-supplied tags). */
const escapeMatch = (v: string): string => v.replace(/[\\*?[\]]/g, "\\$&");

let clientPromise: Promise<RedisClientType> | null = null;
async function redis(): Promise<RedisClientType> {
  if (!clientPromise) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    clientPromise = (async () => {
      const c = createClient({ url, socket: { connectTimeout: 3000 } });
      c.on("error", () => {});
      await c.connect();
      return c as RedisClientType;
    })();
  }
  return clientPromise;
}

const MAX_INSPECT_BYTES = 2 * 1024 * 1024; // refuse to fully decode above this
const MAX_DECOMPRESSED = 16 * 1024 * 1024; // zlib bomb guard

function decompress(raw: string): string {
  if (raw.startsWith("__ncgz__:")) {
    return gunzipSync(Buffer.from(raw.slice(9), "base64"), {
      maxOutputLength: MAX_DECOMPRESSED,
    }).toString("utf8");
  }
  if (raw.startsWith("__ncbr__:")) {
    return brotliDecompressSync(Buffer.from(raw.slice(9), "base64"), {
      maxOutputLength: MAX_DECOMPRESSED,
    }).toString("utf8");
  }
  return raw;
}

function text(s: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof s === "string" ? s : JSON.stringify(s, null, 2),
      },
    ],
  };
}

function explain(key: string): Record<string, string> {
  // ISR tag states are un-namespaced by design; the whole rest is the tag
  // (which may itself contain colons).
  if (key.startsWith(`${ISR_PREFIX}tag:`)) {
    return {
      layer: "cacheHandler (ISR)",
      kind: "tag",
      namespace: "(none — cross-deploy)",
      key: key.slice(`${ISR_PREFIX}tag:`.length),
    };
  }
  for (const prefix of [PLURAL_PREFIX, ISR_PREFIX]) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const m = rest.match(/^([a-z-]+):(?:\{([^}]+)\}|([^:]+)):(.*)$/s);
    if (m) {
      return {
        layer: prefix === PLURAL_PREFIX ? "cacheHandlers ('use cache')" : "cacheHandler (ISR)",
        kind: m[1]!,
        namespace: m[2] ?? m[3] ?? "",
        key: m[4] ?? "",
      };
    }
    // Un-namespaced (ISR tag states are cross-deploy by design).
    const m2 = rest.match(/^([a-z-]+):(.*)$/s);
    if (m2) {
      return {
        layer: prefix === PLURAL_PREFIX ? "cacheHandlers" : "cacheHandler (ISR)",
        kind: m2[1]!,
        namespace: "(none — cross-deploy)",
        key: m2[2] ?? "",
      };
    }
  }
  return { layer: "unknown", kind: "?", namespace: "?", key };
}

import { createRequire } from "node:module";

const pkgVersion: string = createRequire(import.meta.url)("../package.json").version;

const server = new McpServer({
  name: "nextjs-cache-handler",
  version: pkgVersion,
});

server.tool(
  "cache_health",
  "Ping Redis and summarize cache key counts per layer/kind. First tool to run when debugging cache issues.",
  {},
  async () => {
    const c = await redis();
    const t0 = Date.now();
    await c.ping();
    const pingMs = Date.now() - t0;
    const counts: Record<string, number> = {};
    for await (const keys of c.scanIterator({ MATCH: "next-*", COUNT: 500 })) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        const e = explain(String(k));
        const bucket = `${e.layer} / ${e.kind}` + (NS && e.namespace === NS ? " (this deploy)" : "");
        counts[bucket] = (counts[bucket] ?? 0) + 1;
      }
    }
    return text({ pingMs, deployment: NS ?? "(DEPLOYMENT_VERSION not set)", counts });
  }
);

server.tool(
  "cache_search",
  "Scan cache keys by glob pattern (e.g. 'next-incremental:entry:*/blog*'). Returns up to `limit` keys.",
  {
    pattern: z.string().describe("Redis MATCH glob, e.g. next-cache:entry:*"),
    limit: z.number().int().min(1).max(500).default(50),
  },
  async ({ pattern, limit }) => {
    const c = await redis();
    const out: string[] = [];
    for await (const keys of c.scanIterator({ MATCH: pattern, COUNT: 500 })) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        out.push(String(k));
        if (out.length >= limit) return text({ keys: out, truncated: true });
      }
    }
    return text({ keys: out, truncated: false });
  }
);

server.tool(
  "cache_inspect",
  "Decode a cache entry: kind, timestamps, tags, TTL, sizes, compression. Values are summarized, never dumped in full.",
  { key: z.string().describe("Full Redis key of a cache entry") },
  async ({ key }) => {
    const c = await redis();
    const size = await c.strLen(key);
    if (size === 0) {
      const exists = await c.exists(key);
      if (!exists) return text({ key, exists: false });
    }
    if (size > MAX_INSPECT_BYTES) {
      return text({
        key,
        explained: explain(key),
        exists: true,
        storedBytes: size,
        ttlSeconds: await c.ttl(key),
        note: `value larger than ${MAX_INSPECT_BYTES} bytes — full decode refused; sizes/TTL only`,
      });
    }
    const [raw, ttl] = await Promise.all([c.get(key), c.ttl(key)]);
    if (raw === null) return text({ key, exists: false });
    const compressed = raw.startsWith("__ncgz__:") ? "gzip" : raw.startsWith("__ncbr__:") ? "brotli" : "none";
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(decompress(raw)) as Record<string, unknown>;
    } catch {
      /* non-JSON (tag marker etc.) */
    }
    const value = (parsed?.value ?? parsed) as Record<string, unknown> | null;
    return text({
      key,
      explained: explain(key),
      exists: true,
      ttlSeconds: ttl,
      storedBytes: raw.length,
      compression: compressed,
      lastModified: parsed?.lastModified ?? null,
      ageSeconds:
        typeof parsed?.lastModified === "number"
          ? Math.round((Date.now() - (parsed.lastModified as number)) / 1000)
          : null,
      revalidateSec: parsed?.revalidateSec ?? null,
      entryTimestamp: (parsed?.timestamp as number | undefined) ?? null,
      kind: (value?.kind as string | undefined) ?? null,
      tags: (parsed?.tags as unknown) ?? (value?.tags as unknown) ?? null,
      htmlBytes: typeof value?.html === "string" ? (value.html as string).length : null,
    });
  }
);

server.tool(
  "tag_state",
  "Show invalidation state for a tag across BOTH cache layers: the ISR tag state (stale/expired timestamps) and the 'use cache' tag-expiration marker. Answers 'is this tag invalidated right now, and since when?'",
  { tag: z.string() },
  async ({ tag }) => {
    const c = await redis();
    const isrKey = `${ISR_PREFIX}tag:${tag}`;
    const isrRaw = await c.get(isrKey);
    let plural: Record<string, unknown> = {};
    if (NS) {
      const markerKey = `${PLURAL_PREFIX}tag-expiration:${wrapNs(NS)}:${tag}`;
      const v = await c.get(markerKey);
      plural = { markerKey, invalidatedAt: v ? Number(v) : null };
    } else {
      const found: Record<string, number> = {};
      for await (const keys of c.scanIterator({
        MATCH: `${PLURAL_PREFIX}tag-expiration:*:${escapeMatch(tag)}`,
        COUNT: 500,
      })) {
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          const v = await c.get(String(k));
          if (v) found[String(k)] = Number(v);
        }
      }
      plural = { markersByNamespace: found };
    }
    return text({
      tag,
      isr: { key: isrKey, state: isrRaw ? (JSON.parse(isrRaw) as unknown) : null },
      useCache: plural,
      hint: "ISR: 'expired' hits all kinds, 'stale' is SWR. 'use cache': entries older than invalidatedAt serve stale-while-revalidate.",
    });
  }
);

server.tool(
  "explain_key",
  "Parse a Redis key into layer / kind / namespace / cache key.",
  { key: z.string() },
  async ({ key }) => text(explain(key))
);

server.tool(
  "simulate_swr",
  "Given entry timing values, classify freshness the way the handler does (fresh / stale / expired) and explain what a read would do.",
  {
    timestampMs: z.number().describe("entry.timestamp (ms epoch)"),
    revalidateSec: z.number(),
    expireSec: z.number().describe("0 means 'never hard-expire'"),
    nowMs: z.number().optional(),
  },
  async ({ timestampMs, revalidateSec, expireSec, nowMs }) => {
    const now = nowMs ?? Date.now();
    const ageMs = now - timestampMs;
    const revMs = Math.max(0, revalidateSec) * 1000;
    const rawExpMs = expireSec === 0 ? Number.POSITIVE_INFINITY : Math.max(0, expireSec) * 1000;
    const expMs = Math.max(rawExpMs, revMs);
    const freshness = ageMs < 0 || ageMs <= revMs ? "fresh" : ageMs <= expMs ? "stale" : "expired";
    const outcome =
      freshness === "fresh"
        ? "served as a HIT"
        : freshness === "stale"
          ? "served immediately AND Next schedules a background re-render (SWR)"
          : "miss — entry evicted, blocking regeneration";
    return text({ ageSeconds: Math.round(ageMs / 1000), freshness, outcome });
  }
);

server.tool(
  "invalidate_tag",
  "Invalidate a tag across both layers. DRY-RUN by default: shows exactly what would be written/deleted. Pass confirm=true to execute. mode 'soft' = stale-while-revalidate (revalidateTag(tag,'max') semantics); 'hard' = delete entries now.",
  {
    tag: z.string(),
    mode: z.enum(["soft", "hard"]).default("soft"),
    confirm: z.boolean().default(false),
  },
  async ({ tag, mode, confirm }) => {
    const c = await redis();
    const now = Date.now();
    const namespaces: string[] = NS ? [wrapNs(NS)] : [];
    if (namespaces.length === 0) {
      for await (const keys of c.scanIterator({ MATCH: `${PLURAL_PREFIX}tag:*:${escapeMatch(tag)}`, COUNT: 500 })) {
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          const m = String(k).match(/tag:(\{[^}]+\}|[^:]+):/);
          // Keep braces when discovered — they are part of the key shape.
          const ns = m?.[1];
          if (ns && !namespaces.includes(ns)) namespaces.push(ns);
        }
      }
    }

    const plan: string[] = [
      `SET ${ISR_PREFIX}tag:${tag} ${JSON.stringify(mode === "hard" ? { expired: now } : { stale: now })} (ISR tag state)`,
    ];
    for (const ns of namespaces) {
      plan.push(`SET ${PLURAL_PREFIX}tag-expiration:${ns}:${tag} ${now} (use-cache marker)`);
      if (mode === "hard") plan.push(`DEL members of ${PLURAL_PREFIX}tag:${ns}:${tag} (tagged entries)`);
    }

    const warnings: string[] = [];
    if (!NS && namespaces.length === 0) {
      warnings.push(
        "No 'use cache' namespaces discovered (set DEPLOYMENT_VERSION to target one) — only the ISR tag state will be written."
      );
    }
    if (mode === "hard") {
      warnings.push(
        "Hard mode here is best-effort (SMEMBERS+DEL), not the handler's atomic Lua — a concurrent set() can survive."
      );
    }

    if (!confirm) {
      return text({ dryRun: true, mode, plan, warnings, note: "Pass confirm=true to execute." });
    }

    await c.set(
      `${ISR_PREFIX}tag:${tag}`,
      JSON.stringify(mode === "hard" ? { expired: now } : { stale: now }),
      { EX: 60 * 60 * 24 * 365 }
    );
    let deleted = 0;
    for (const ns of namespaces) {
      await c.set(`${PLURAL_PREFIX}tag-expiration:${ns}:${tag}`, String(now), { EX: 604800 });
      if (mode === "hard") {
        const setKey = `${PLURAL_PREFIX}tag:${ns}:${tag}`;
        const members = await c.sMembers(setKey);
        if (members.length > 0) deleted += await c.del(members);
        await c.del(setKey);
      }
      // Push notification for tagPubSub subscribers, if any.
      await c.publish(`${PLURAL_PREFIX}inval:${ns}`, JSON.stringify({ t: [tag], ts: now }));
    }
    return text({ executed: true, mode, namespaces, entriesDeleted: deleted, invalidatedAt: now, warnings });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
