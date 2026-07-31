/**
 * Spec-compliant `cacheHandlers` (plural) implementation. See docs/next16-spec.md.
 *
 * This module owns the five required methods (`get`, `set`, `refreshTags`,
 * `getExpiration`, `updateTags`) and threads them through:
 *   - build-phase short-circuit                 (src/shared/build-phase.ts)
 *   - per-call abort timeout                    (src/shared/abort.ts)
 *   - in-memory fallback when Redis unavailable (src/shared/memory-fallback.ts)
 *   - 3-axis SWR partition                      (./swr.ts)
 *   - Lua-atomic SET-with-tags / hard-revalidate (src/shared/lua/)
 *
 * Error policy follows spec §6 verbatim — this module never re-throws on
 * `get` / `set`. `updateTags` with `expire === 0` (hard expire) propagates
 * so the user observes invalidation failures.
 */

import { CacheTimeoutError, withAbortSignal } from "../shared/abort.js";
import { compressValue, decompressValue } from "../shared/compress.js";
import { ConnectionManager } from "../shared/client/index.js";
import { defaultLogger } from "../shared/logger.js";
import { execLuaScript } from "../shared/lua/index.js";
import { MemoryStore, MemorySetStore } from "../shared/memory-fallback.js";
import { createEmitter } from "../shared/metrics.js";
import { buildKey, resolveBuildNamespace } from "../shared/namespace.js";
import { shouldUseRedis } from "../shared/build-phase.js";
import type {
  CacheComponentsEntry,
  CacheHandlerOptions,
  Logger,
  MetricEmitter,
  RedisClientLike,
} from "../types.js";

import {
  bufferToStream,
  decodeEnvelope,
  encodeEnvelope,
  readStreamFully,
} from "./serialize.js";
import { partitionEntry, shouldServeStale } from "./swr.js";

// ─── Defaults / constants ────────────────────────────────────────────────────

const DEFAULT_KEY_PREFIX = "next-cache:";
const ENTRY_SUFFIX = "entry:";
const TAG_SUFFIX = "tag:";
const TAG_EXP_SUFFIX = "tag-expiration:";
const LOCK_SUFFIX = "lock:";

const DEFAULT_ABORT_MS = 1500;
const DEFAULT_LOCK_TTL_SEC = 10;
/** When entry.expire === Infinity (the "never" sentinel), use this as the
 *  Redis EX. One year matches the upstream cap and avoids leaking forever. */
const ONE_YEAR_SEC = 60 * 60 * 24 * 365;
/** Fallback floor when both expire and revalidate are unset/0. */
const FALLBACK_TTL_SEC = 3600;
/** TTL for tag-expiration markers — kept long so cross-deployment readers
 *  can still observe an invalidation that happened in the previous deploy. */
const TAG_EXP_MARKER_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

// ─── Public factory contract ─────────────────────────────────────────────────

export interface CacheComponentsHandler {
  get(
    cacheKey: string,
    softTags: string[]
  ): Promise<CacheComponentsEntry | undefined>;
  set(
    cacheKey: string,
    pendingEntry: Promise<CacheComponentsEntry>
  ): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<number>;
  updateTags(
    tags: string[],
    durations?: { expire?: number }
  ): Promise<void>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

interface HandlerState {
  opts: Required<
    Pick<
      CacheHandlerOptions,
      | "abortTimeoutMs"
      | "fallback"
      | "staleWhileRevalidate"
      | "hashTag"
      | "keyPrefix"
      | "singleFlight"
      | "singleFlightLockTtlSec"
      | "tagPubSub"
    >
  > & { rest: CacheHandlerOptions };
  /** Stable instance identifier baked into refresh-lock owner field. Helps
   *  operators tell from Redis which task held a given lock. */
  instanceId: string;
  logger: Logger;
  emit: MetricEmitter;
  conn: ConnectionManager;
  /** Memory cache for entries when Redis is unavailable. */
  memEntries: MemoryStore<string>;
  /** Memory tag-set index for memory fallback path. */
  memTags: MemorySetStore;
  /** Memory tag-expiration timestamps. Mirrors next-cache:tag-expiration:*. */
  memTagExp: Map<string, number>;
  /** Local mirror of recent tag invalidations refreshed from Redis. */
  localTagTimestamps: Map<string, number>;
  /** tagPubSub subscription state (opt-in acceleration; polling remains). */
  pubsub: {
    active: boolean;
    disabled: boolean;
    attempting: boolean;
    lastAttempt: number;
    stop?: () => Promise<void>;
  };
  /** Resolved build namespace, computed once per call. */
  resolveNs: () => string;
}

function gateRedis(state: HandlerState): boolean {
  const fb = state.opts.fallback;
  const ibp = state.opts.rest.isBuildPhase;
  return ibp ? shouldUseRedis({ fallback: fb, isBuildPhase: ibp }) : shouldUseRedis({ fallback: fb });
}

function init(opts: CacheHandlerOptions): HandlerState {
  const logger = opts.logger ?? defaultLogger;
  const emit = createEmitter(opts.onMetric);
  const conn = new ConnectionManager(opts.client, (err) => {
    logger.warn("Redis client error", { message: err.message });
    emit({ type: "redis.connect.failed", meta: { message: err.message } });
  });

  return {
    opts: {
      abortTimeoutMs: opts.abortTimeoutMs ?? DEFAULT_ABORT_MS,
      fallback: opts.fallback ?? "auto",
      staleWhileRevalidate: opts.staleWhileRevalidate ?? true,
      hashTag: opts.hashTag ?? false,
      keyPrefix: opts.keyPrefix ?? DEFAULT_KEY_PREFIX,
      singleFlight: opts.singleFlight ?? false,
      tagPubSub: opts.tagPubSub ?? false,
      singleFlightLockTtlSec:
        opts.singleFlightLockTtlSec ?? DEFAULT_LOCK_TTL_SEC,
      rest: opts,
    },
    logger,
    emit,
    conn,
    memEntries: new MemoryStore<string>(opts.memoryMaxEntries),
    memTags: new MemorySetStore(opts.memoryMaxEntries),
    memTagExp: new Map(),
    localTagTimestamps: new Map(),
    pubsub: { active: false, disabled: false, attempting: false, lastAttempt: 0 },
    resolveNs: () => resolveBuildNamespace(opts.buildNamespace),
    instanceId:
      process.env.HOSTNAME ||
      process.env.ECS_TASK_ID ||
      `pid-${process.pid}`,
  };
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

function entryKey(state: HandlerState, cacheKey: string): string {
  return buildKey(
    `${state.opts.keyPrefix}${ENTRY_SUFFIX}`,
    state.resolveNs(),
    cacheKey,
    state.opts.hashTag
  );
}

function tagKey(state: HandlerState, tag: string): string {
  return buildKey(
    `${state.opts.keyPrefix}${TAG_SUFFIX}`,
    state.resolveNs(),
    tag,
    state.opts.hashTag
  );
}

function tagExpKey(state: HandlerState, tag: string): string {
  return buildKey(
    `${state.opts.keyPrefix}${TAG_EXP_SUFFIX}`,
    state.resolveNs(),
    tag,
    state.opts.hashTag
  );
}

function lockKey(state: HandlerState, cacheKey: string): string {
  return buildKey(
    `${state.opts.keyPrefix}${LOCK_SUFFIX}`,
    state.resolveNs(),
    cacheKey,
    state.opts.hashTag
  );
}

/**
 * Try to acquire the single-flight lock for a stale cache key. Returns true
 * if this instance is the refresh leader, false if someone else already
 * holds the lock or Redis is unavailable.
 *
 * On any error path we return `false` (the safe default — we'd rather miss
 * the leadership signal than block the user response). The lock is purely
 * an observability + stampede-suppression hint; the entry itself is still
 * returned regardless of outcome.
 */
async function tryAcquireRefreshLock(
  state: HandlerState,
  cacheKey: string
): Promise<boolean> {
  if (!state.opts.singleFlight) return false;
  if (!gateRedis(state)) return false;

  try {
    return await withAbortSignal(
      "cacheHandlers.singleFlight.lock",
      state.opts.abortTimeoutMs,
      async () => {
        const client = await state.conn.getOrConnect();
        if (!client) return false;
        const result = await execLuaScript<number>(
          client,
          "refreshTagLock",
          [lockKey(state, cacheKey)],
          [
            state.instanceId,
            String(state.opts.singleFlightLockTtlSec),
          ]
        );
        return result === 1;
      }
    );
  } catch {
    // Best-effort. A failed lock attempt should never block a serve.
    return false;
  }
}

// ─── TTL resolution ──────────────────────────────────────────────────────────

function resolveTtlSeconds(entry: CacheComponentsEntry): number {
  // Per spec §4 cacheLife: expire can be Infinity; map to ONE_YEAR_SEC.
  if (Number.isFinite(entry.expire) && entry.expire > 0) {
    return Math.max(60, Math.ceil(entry.expire));
  }
  if (Number.isFinite(entry.revalidate) && entry.revalidate > 0) {
    return Math.max(60, Math.ceil(entry.revalidate));
  }
  if (entry.expire === Number.POSITIVE_INFINITY) {
    return ONE_YEAR_SEC;
  }
  return FALLBACK_TTL_SEC;
}

// ─── get() ───────────────────────────────────────────────────────────────────

async function getImpl(
  state: HandlerState,
  cacheKey: string,
  softTags: string[]
): Promise<CacheComponentsEntry | undefined> {
  const start = Date.now();
  const useRedis = gateRedis(state);
  if (useRedis) void ensureTagSubscription(state);

  if (!useRedis && state.opts.fallback === "never") {
    state.emit({ type: "cache.miss", meta: { reason: "no-redis" } });
    return undefined;
  }

  const eKey = entryKey(state, cacheKey);

  // Try Redis first when allowed.
  let envelope: ReturnType<typeof decodeEnvelope> = null;
  let raw: string | null = null;

  if (useRedis) {
    try {
      raw = await withAbortSignal(
        "cacheHandlers.get",
        state.opts.abortTimeoutMs,
        async () => {
          const client = await state.conn.getOrConnect();
          if (!client) return null;
          return await client.get(eKey);
        }
      );
    } catch (err) {
      if (err instanceof CacheTimeoutError) {
        state.emit({ type: "redis.timeout", meta: { op: "get" } });
      } else {
        state.logger.warn("get() Redis error, falling back", {
          message: (err as Error).message,
        });
      }
      raw = null;
    }
  }

  if (raw === null && state.opts.fallback !== "never") {
    raw = state.memEntries.get(eKey);
    if (raw !== null) state.emit({ type: "fallback.activated", meta: { op: "get" } });
  }

  if (raw === null) {
    state.emit({ type: "cache.miss", ms: Date.now() - start });
    return undefined;
  }

  try {
    raw = await decompressValue(raw);
  } catch {
    state.emit({ type: "cache.miss", meta: { reason: "decode-error" } });
    return undefined;
  }

  envelope = decodeEnvelope(raw as string);
  if (!envelope) {
    state.emit({ type: "cache.miss", meta: { reason: "decode-error" } });
    return undefined;
  }

  // 3-axis SWR partition.
  const partition = partitionEntry(envelope, Date.now());
  if (!shouldServeStale(partition, state.opts.staleWhileRevalidate)) {
    // Hard miss. Best-effort cleanup of the entry.
    if (useRedis) {
      try {
        await withAbortSignal(
          "cacheHandlers.get.evict",
          state.opts.abortTimeoutMs,
          async () => {
            const c = await state.conn.getOrConnect();
            if (c) await c.del(eKey);
          }
        );
      } catch {
        // Ignore — eviction is best-effort.
      }
    } else {
      state.memEntries.delete(eKey);
    }
    state.emit({
      type: "cache.miss",
      meta: { reason: "expired", freshness: partition.freshness },
    });
    return undefined;
  }

  // Tag freshness check. An entry is stale if ANY of its tags was invalidated
  // after entry.timestamp. Two tag sources must be considered:
  //   1. softTags — implicit route tags Next passes in (revalidatePath). Next
  //      also enforces these itself via getExpiration(implicitTags), so this
  //      handler-side check is defense in depth.
  //   2. envelope.tags — explicit tags carried on the entry via cacheTag().
  //      Next does NOT consult the handler for these across requests (it only
  //      checks the current action's pending/previous tags), so cross-request
  //      soft invalidation — revalidateTag(tag, "max") — is entirely the
  //      handler's job here. Checking only softTags made that a no-op (#1).
  const freshnessTags =
    softTags.length > 0 ? [...softTags, ...envelope.tags] : envelope.tags;
  let tagStale = false;
  if (freshnessTags.length > 0) {
    let mostRecent = 0;
    for (const t of freshnessTags) {
      const ts = state.localTagTimestamps.get(t);
      if (ts !== undefined && ts > mostRecent) mostRecent = ts;
    }
    if (mostRecent > envelope.timestamp) {
      // Soft invalidation is stale-while-revalidate per spec §2.3#updateTags
      // ("entries can stay; subsequent reads treat them as stale"): keep
      // serving the entry but classify it stale so it flows through the
      // background-refresh path below. Only when SWR is disabled (or the
      // entry is already hard-expired) do we degrade to a miss.
      if (state.opts.staleWhileRevalidate && partition.freshness !== "expired") {
        tagStale = true;
      } else {
        state.emit({ type: "cache.miss", meta: { reason: "tag-invalidated" } });
        return undefined;
      }
    }
  }

  const freshness = tagStale ? "stale" : partition.freshness;

  // For stale entries, try the single-flight refresh lock so only one
  // instance triggers the background refresh (when the option is on).
  // The lock outcome is purely informational — we always serve the entry.
  if (freshness === "stale") {
    const staleMeta = tagStale
      ? { freshness, reason: "tag-invalidated" }
      : { freshness };
    if (state.opts.singleFlight) {
      const isLeader = await tryAcquireRefreshLock(state, cacheKey);
      state.emit({
        type: isLeader
          ? "cache.stale.refresh.leader"
          : "cache.stale.refresh.follower",
        ms: Date.now() - start,
        meta: staleMeta,
      });
    } else {
      state.emit({
        type: "cache.stale",
        ms: Date.now() - start,
        meta: staleMeta,
      });
    }
  } else {
    state.emit({
      type: "cache.hit",
      ms: Date.now() - start,
      meta: { freshness },
    });
  }

  // When stale because of a tag invalidation (not time), present the entry as
  // just past its `revalidate` boundary so Next serves it immediately AND
  // schedules a background re-render (true SWR). Time-stale entries already
  // satisfy this through their real timestamp. The Math.min guard never makes
  // an entry look fresher than it actually is.
  const revalidateMs = Math.max(0, envelope.revalidate) * 1000;
  const outTimestamp = tagStale
    ? Math.min(envelope.timestamp, Date.now() - revalidateMs - 1)
    : envelope.timestamp;

  // Reconstruct stream and return.
  return {
    value: bufferToStream(Buffer.from(envelope.value, "base64")),
    tags: envelope.tags,
    stale: envelope.stale,
    timestamp: outTimestamp,
    expire: envelope.expire,
    revalidate: envelope.revalidate,
  };
}

// ─── set() ───────────────────────────────────────────────────────────────────

async function setImpl(
  state: HandlerState,
  cacheKey: string,
  pendingEntry: Promise<CacheComponentsEntry>
): Promise<void> {
  // Spec mandates awaiting the promise before reading value.
  let entry: CacheComponentsEntry;
  try {
    entry = await pendingEntry;
  } catch (err) {
    state.logger.warn("pendingEntry rejected, skipping set()", {
      message: (err as Error).message,
    });
    state.emit({ type: "cache.set.failed", meta: { reason: "pending-rejected" } });
    return;
  }

  let buf: Buffer;
  try {
    buf = await readStreamFully(entry.value);
  } catch (err) {
    // Partial writes — discard per spec §2.3#set.
    state.logger.warn("stream errored mid-read, discarding entry", {
      message: (err as Error).message,
    });
    state.emit({ type: "cache.set.failed", meta: { reason: "partial-stream" } });
    return;
  }

  const eKey = entryKey(state, cacheKey);
  const ttl = resolveTtlSeconds(entry);
  const payload = encodeEnvelope(buf, {
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
  });

  const useRedis = gateRedis(state);

  if (!useRedis) {
    state.emit({ type: "build_phase.skip", meta: { op: "set" } });
    if (state.opts.fallback !== "never") {
      state.memEntries.set(eKey, payload, ttl);
      for (const t of entry.tags) {
        state.memTags.sAdd(tagKey(state, t), eKey);
        state.memTags.expire(tagKey(state, t), ttl);
      }
    }
    state.emit({ type: "cache.set", meta: { backend: "memory" } });
    return;
  }

  try {
    await withAbortSignal(
      "cacheHandlers.set",
      state.opts.abortTimeoutMs,
      async () => {
        const client = await state.conn.getOrConnect();
        if (!client) {
          if (state.opts.fallback !== "never") {
            state.memEntries.set(eKey, payload, ttl);
          }
          return;
        }
        // Compress only the Redis-bound copy — the memory fallback keeps the
        // plain payload (local reads shouldn't pay decompress CPU).
        const wirePayload = await compressValue(
          payload,
          state.opts.rest.compression
        );
        if (entry.tags.length === 0) {
          // No tags → simple SET.
          await client.set(eKey, wirePayload, { EX: ttl });
        } else {
          await luaSetWithTags(client, state, eKey, wirePayload, ttl, entry.tags);
        }
      }
    );
    state.emit({ type: "cache.set", meta: { backend: "redis" } });
  } catch (err) {
    if (err instanceof CacheTimeoutError) {
      state.emit({ type: "redis.timeout", meta: { op: "set" } });
    } else {
      state.logger.warn("set() failed (best-effort)", {
        message: (err as Error).message,
      });
    }
    state.emit({ type: "cache.set.failed", meta: { reason: "redis-error" } });
    // No re-throw per spec error policy.
  }
}

async function luaSetWithTags(
  client: RedisClientLike,
  state: HandlerState,
  eKey: string,
  payload: string,
  ttl: number,
  tags: string[]
): Promise<void> {
  const tagKeys = tags.map((t) => tagKey(state, t));
  await execLuaScript<number>(
    client,
    "setWithTags",
    [eKey, ...tagKeys],
    [payload, String(ttl), String(ttl), String(tags.length)]
  );
}

// ─── tagPubSub (opt-in push propagation) ─────────────────────────────────────

function invalChannel(state: HandlerState): string {
  const ns = state.opts.hashTag
    ? `{${state.resolveNs()}}`
    : state.resolveNs();
  return `${state.opts.keyPrefix}inval:${ns}`;
}

const SUBSCRIBE_RETRY_MS = 5000;

/**
 * Lazily establish the invalidation subscription. Failures never surface to
 * callers: the refreshTags() scan remains the consistency safety net, so a
 * missing/broken subscription only costs latency, not correctness.
 */
async function ensureTagSubscription(state: HandlerState): Promise<void> {
  if (
    !state.opts.tagPubSub ||
    state.pubsub.active ||
    state.pubsub.disabled ||
    state.pubsub.attempting
  ) {
    return;
  }
  const now = Date.now();
  if (now - state.pubsub.lastAttempt < SUBSCRIBE_RETRY_MS) return;
  state.pubsub.lastAttempt = now;
  state.pubsub.attempting = true;

  try {
    const client = await state.conn.getOrConnect();
    if (!client) return;
    if (typeof client.subscribe !== "function") {
      state.pubsub.disabled = true;
      state.logger.warn(
        "tagPubSub unavailable on this client (no subscribe support, e.g. Cluster) — falling back to scan-based propagation"
      );
      return;
    }
    const stop = await client.subscribe(invalChannel(state), (message) => {
      try {
        const parsed = JSON.parse(message) as { t?: string[]; ts?: number };
        if (!Array.isArray(parsed.t) || typeof parsed.ts !== "number") return;
        for (const tag of parsed.t) {
          const prev = state.localTagTimestamps.get(tag) ?? 0;
          if (parsed.ts > prev) state.localTagTimestamps.set(tag, parsed.ts);
          const prevMem = state.memTagExp.get(tag) ?? 0;
          if (parsed.ts > prevMem) state.memTagExp.set(tag, parsed.ts);
        }
      } catch {
        // Malformed message — ignore; the scan will reconcile.
      }
    });
    state.pubsub.active = true;
    state.pubsub.stop = async () => {
      state.pubsub.active = false;
      await stop();
    };
  } catch (err) {
    state.logger.warn("tagPubSub subscribe failed — will retry", {
      message: (err as Error).message,
    });
  } finally {
    state.pubsub.attempting = false;
  }
}

// ─── refreshTags() ───────────────────────────────────────────────────────────

async function refreshTagsImpl(state: HandlerState): Promise<void> {
  // Per spec §6: errors here MUST be caught.
  if (
    !gateRedis(state)
  ) {
    return;
  }

  void ensureTagSubscription(state);
  try {
    await withAbortSignal(
      "cacheHandlers.refreshTags",
      state.opts.abortTimeoutMs,
      async () => {
        const client = await state.conn.getOrConnect();
        if (!client) return;
        // Scan only the current namespace's markers. The old pattern omitted
        // the namespace, so every deploy's markers were scanned and then
        // discarded by stripExpPrefix; combined with a 500-key cap (SCAN
        // restarts at cursor 0 each call) markers past the cap were never
        // read. Chunk-by-chunk MGET replaces the cap: work per chunk stays
        // small and no marker is silently skipped.
        const ns = state.opts.hashTag
          ? `{${state.resolveNs()}}`
          : state.resolveNs();
        const pattern = `${escapeMatch(
          `${state.opts.keyPrefix}${TAG_EXP_SUFFIX}${ns}:`
        )}*`;
        const scanStartMs = Date.now();
        const fresh = new Map<string, number>();
        for await (const chunk of client.scanIterator({
          MATCH: pattern,
          COUNT: 100,
        })) {
          const keys = Array.isArray(chunk)
            ? chunk.map(String)
            : [String(chunk)];
          if (keys.length === 0) continue;
          const values = await client.mGet(keys);
          for (let i = 0; i < keys.length; i += 1) {
            const v = values[i];
            if (!v) continue;
            const ts = Number.parseInt(v, 10);
            if (!Number.isFinite(ts)) continue;
            // Strip prefix back to bare tag name.
            const key = keys[i];
            if (key === undefined) continue;
            const tag = stripExpPrefix(state, key);
            if (tag) fresh.set(tag, ts);
          }
        }
        // Invalidations recorded locally while the scan ran may not have had
        // visible markers yet — carry them over so they aren't lost.
        for (const [tag, ts] of state.localTagTimestamps) {
          if (ts >= scanStartMs && (fresh.get(tag) ?? 0) < ts) {
            fresh.set(tag, ts);
          }
        }
        // Wholesale replacement keeps the mirror bounded by live-marker
        // count: tags whose markers expired out of Redis (7d TTL) drop out
        // here. Only reached on a complete scan — a failed or timed-out scan
        // keeps the previous mirror instead of installing partial data.
        state.localTagTimestamps = fresh;
      }
    );
  } catch (err) {
    state.logger.warn("refreshTags() error swallowed", {
      message: (err as Error).message,
    });
  }
}

/** Escape Redis MATCH glob metacharacters so key prefixes match literally. */
function escapeMatch(s: string): string {
  return s.replace(/[\\*?[\]]/g, "\\$&");
}

/** Cap for the process-local tag-timestamp mirrors. */
const MAX_LOCAL_TAG_ENTRIES = 10_000;

/** Drop the oldest-timestamped entries until the map fits the cap. */
function pruneOldestByTimestamp(
  map: Map<string, number>,
  maxEntries: number
): void {
  if (map.size <= maxEntries) return;
  const byAge = [...map.entries()].sort((a, b) => a[1] - b[1]);
  const drop = map.size - maxEntries;
  for (let i = 0; i < drop; i += 1) {
    const entry = byAge[i];
    if (entry) map.delete(entry[0]);
  }
}

function stripExpPrefix(state: HandlerState, fullKey: string): string | null {
  const ns = state.resolveNs();
  const prefix = state.opts.hashTag
    ? `${state.opts.keyPrefix}${TAG_EXP_SUFFIX}{${ns}}:`
    : `${state.opts.keyPrefix}${TAG_EXP_SUFFIX}${ns}:`;
  return fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : null;
}

// ─── getExpiration() ────────────────────────────────────────────────────────

async function getExpirationImpl(
  state: HandlerState,
  tags: string[]
): Promise<number> {
  if (tags.length === 0) return 0;

  let max = 0;
  for (const t of tags) {
    const local = state.localTagTimestamps.get(t);
    if (local !== undefined && local > max) max = local;
    const mem = state.memTagExp.get(t);
    if (mem !== undefined && mem > max) max = mem;
  }
  if (max > 0) {
    state.emit({ type: "tag.expiration.read", meta: { source: "local", count: tags.length } });
    return max;
  }

  // Cold path: no local hits → consult Redis if reachable.
  if (
    !gateRedis(state)
  ) {
    return 0;
  }

  try {
    return await withAbortSignal(
      "cacheHandlers.getExpiration",
      state.opts.abortTimeoutMs,
      async () => {
        const client = await state.conn.getOrConnect();
        if (!client) return 0;
        const keys = tags.map((t) => tagExpKey(state, t));
        const values = await client.mGet(keys);
        let m = 0;
        for (const v of values) {
          if (!v) continue;
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n > m) m = n;
        }
        return m;
      }
    );
  } catch {
    // Best-effort. Falling back to 0 is safe (treats tags as never invalidated).
    return 0;
  }
}

// ─── updateTags() ───────────────────────────────────────────────────────────

async function updateTagsImpl(
  state: HandlerState,
  tags: string[],
  durations?: { expire?: number }
): Promise<void> {
  if (tags.length === 0) return;
  const isHardExpire = durations?.expire === 0;
  const now = Date.now();

  // Local mirror update first — guarantees read-after-write within instance.
  for (const t of tags) {
    state.localTagTimestamps.set(t, now);
    state.memTagExp.set(t, now);
  }
  // memTagExp has no scan-based rebuild to shed dead tags (refreshTags only
  // replaces localTagTimestamps), so cap it here against unbounded growth in
  // high-tag-cardinality apps.
  pruneOldestByTimestamp(state.memTagExp, MAX_LOCAL_TAG_ENTRIES);

  if (
    !gateRedis(state)
  ) {
    if (isHardExpire) {
      // Drop matching entries from memory.
      for (const t of tags) {
        const tk = tagKey(state, t);
        const members = state.memTags.sMembers(tk);
        for (const m of members) state.memEntries.delete(m);
        state.memTags.delete(tk);
      }
    }
    state.emit({
      type: isHardExpire ? "tag.invalidate.hard" : "tag.invalidate.soft",
      meta: { count: tags.length, backend: "memory" },
    });
    return;
  }

  // Soft path: best-effort. Hard path: propagate failure.
  try {
    await withAbortSignal(
      "cacheHandlers.updateTags",
      state.opts.abortTimeoutMs,
      async () => {
        const client = await state.conn.getOrConnect();
        if (!client) {
          if (isHardExpire) {
            throw new Error(
              "[next-cache] hard updateTags requested but Redis unavailable"
            );
          }
          return;
        }
        // Concurrent fan-out instead of a per-tag await chain: N tags cost
        // ~1 round trip (redis@5 auto-pipelines same-tick commands; ioredis
        // has enableAutoPipelining set in our factory) instead of N. With
        // many tags the sequential version could exceed abortTimeoutMs.
        await Promise.all(
          tags.map((t) =>
            isHardExpire
              ? execLuaScript<number>(
                  client,
                  "revalidateHard",
                  [tagKey(state, t), tagExpKey(state, t)],
                  [String(now), String(TAG_EXP_MARKER_TTL_SEC)]
                )
              : client.set(tagExpKey(state, t), String(now), {
                  EX: TAG_EXP_MARKER_TTL_SEC,
                })
          )
        );
      }
    );
    state.emit({
      type: isHardExpire ? "tag.invalidate.hard" : "tag.invalidate.soft",
      meta: { count: tags.length, backend: "redis" },
    });
    if (state.opts.tagPubSub) {
      // Best-effort push notification — subscribers converge in ms instead
      // of at their next refreshTags() scan. Failures are irrelevant to
      // correctness (markers are already written).
      try {
        const client = await state.conn.getOrConnect();
        await client?.publish?.(
          invalChannel(state),
          JSON.stringify({ t: tags, ts: now })
        );
      } catch {
        /* scan reconciles */
      }
    }
  } catch (err) {
    if (err instanceof CacheTimeoutError) {
      state.emit({ type: "redis.timeout", meta: { op: "updateTags" } });
    }
    if (isHardExpire) {
      // Hard failures must surface — read-your-own-writes was requested.
      throw err;
    }
    state.logger.warn("updateTags() soft path failed (best-effort)", {
      message: (err as Error).message,
    });
  }
}

// ─── Public factory ─────────────────────────────────────────────────────────

export function createCacheComponentsHandler(
  opts: CacheHandlerOptions
): CacheComponentsHandler {
  const state = init(opts);
  return {
    get: (cacheKey, softTags) => getImpl(state, cacheKey, softTags),
    set: (cacheKey, pendingEntry) => setImpl(state, cacheKey, pendingEntry),
    refreshTags: () => refreshTagsImpl(state),
    getExpiration: (tags) => getExpirationImpl(state, tags),
    updateTags: (tags, durations) => updateTagsImpl(state, tags, durations),
  };
}
