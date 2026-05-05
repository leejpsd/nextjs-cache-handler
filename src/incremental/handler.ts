/**
 * Spec-compliant `cacheHandler` (singular) implementation. See
 * docs/next16-spec.md §3.
 *
 * Used for:
 *   - Pages Router ISR
 *   - On-demand ISR (`res.revalidate`, `x-prerender-revalidate`)
 *   - `fetch(..., { next: { tags } })` cache (kind: FETCH)
 *   - App Router page/route HTML (when not using `'use cache'`)
 *
 * Differs from cache-components handler in two important ways:
 *   1. `value` is a plain Buffer/string, not a stream
 *   2. Tag invalidation is encoded as `{stale, expired}` payloads stored at
 *      `next-incremental:tag:<tag>` (no namespace prefix — tags are shared
 *      across deployments by design so revalidateTag survives a deploy)
 */

import { CacheTimeoutError, withAbortSignal } from "../shared/abort.js";
import { ConnectionManager } from "../shared/client/index.js";
import { defaultLogger } from "../shared/logger.js";
import { MemoryStore } from "../shared/memory-fallback.js";
import { createEmitter } from "../shared/metrics.js";
import { buildKey, resolveBuildNamespace } from "../shared/namespace.js";
import { shouldUseRedis } from "../shared/build-phase.js";
import type {
  CacheHandlerOptions,
  IncrementalCacheData,
  Logger,
  MetricEmitter,
} from "../types.js";

import {
  deserializeCacheRecord,
  serializeCacheRecord,
} from "./serialize.js";

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_KEY_PREFIX = "next-incremental:";
const ENTRY_SUFFIX = "entry:";
const TAG_SUFFIX = "tag:";
const INSTANCE_LOCAL_TAG_PREFIX = "instance-local:";
const ONE_YEAR_SEC = 60 * 60 * 24 * 365;
const MIN_TTL_SEC = 60;
const DEFAULT_ABORT_MS = 1500;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IncrementalCtx {
  kind?: string;
  tags?: string[];
  softTags?: string[];
  revalidatedTags?: string[];
  cacheControl?: { revalidate?: number | false };
  fetchCache?: boolean;
}

interface CacheRecord {
  lastModified: number;
  value: IncrementalCacheData["value"];
}

interface TagState {
  /** Last revalidate timestamp (ms). Soft — only fetch entries treat this as expired. */
  stale?: number;
  /** Hard expiration timestamp (ms). All entry kinds treat this as expired. */
  expired?: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

interface HandlerState {
  opts: Required<
    Pick<
      CacheHandlerOptions,
      "abortTimeoutMs" | "fallback" | "hashTag" | "keyPrefix"
    >
  > & { rest: CacheHandlerOptions };
  logger: Logger;
  emit: MetricEmitter;
  conn: ConnectionManager;
  memEntries: MemoryStore<string>;
  /** Tag states, by bare tag (no namespace prefix — see tagMetaKey comment). */
  memTagStates: Map<string, TagState>;
  resolveNs: () => string;
}

function gateRedis(state: HandlerState): boolean {
  const fb = state.opts.fallback;
  const ibp = state.opts.rest.isBuildPhase;
  return ibp ? shouldUseRedis({ fallback: fb, isBuildPhase: ibp }) : shouldUseRedis({ fallback: fb });
}

function gateRedisInit(state: HandlerState): boolean {
  return gateRedis(state);
}

function init(opts: CacheHandlerOptions): HandlerState {
  const logger = opts.logger ?? defaultLogger;
  const emit = createEmitter(opts.onMetric);
  const conn = new ConnectionManager(opts.client, (err) => {
    logger.warn("Redis client error (incremental)", { message: err.message });
    emit({ type: "redis.connect.failed", meta: { message: err.message } });
  });
  return {
    opts: {
      abortTimeoutMs: opts.abortTimeoutMs ?? DEFAULT_ABORT_MS,
      fallback: opts.fallback ?? "auto",
      hashTag: opts.hashTag ?? false,
      keyPrefix: opts.keyPrefix ?? DEFAULT_KEY_PREFIX,
      rest: opts,
    },
    logger,
    emit,
    conn,
    memEntries: new MemoryStore<string>(),
    memTagStates: new Map(),
    resolveNs: () => resolveBuildNamespace(opts.buildNamespace),
  };
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

function entryKey(state: HandlerState, cacheKey: string): string {
  // Entries ARE namespaced by build — the whole point of BUILD_NAMESPACE.
  return buildKey(
    `${state.opts.keyPrefix}${ENTRY_SUFFIX}`,
    state.resolveNs(),
    cacheKey,
    state.opts.hashTag
  );
}

function tagMetaKey(state: HandlerState, tag: string): string {
  // Tag states are intentionally NOT namespaced. revalidateTag should be
  // observable from new deployments too (otherwise a deploy-time invalidation
  // is lost). See incremental-cache-handler.js comment in reference impl.
  return `${state.opts.keyPrefix}${TAG_SUFFIX}${tag}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeTags(tags: unknown): string[] {
  return Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
}

function shouldUseLocalIncrementalStore(tags: string[]): boolean {
  return tags.some((t) => t.startsWith(INSTANCE_LOCAL_TAG_PREFIX));
}

function extractTagsFromValue(
  value: IncrementalCacheData["value"],
  ctx: IncrementalCtx | undefined
): string[] {
  if (!value || typeof value !== "object") return [];
  const v = value as { kind?: string; tags?: unknown; headers?: Record<string, unknown> };

  if (v.kind === "FETCH") {
    return normalizeTags([
      ...normalizeTags(v.tags),
      ...normalizeTags(ctx?.tags),
      ...normalizeTags(ctx?.softTags),
    ]);
  }

  const headers = v.headers;
  if (!headers) return [];
  const tagsHeader = headers["x-next-cache-tags"];
  if (typeof tagsHeader === "string") {
    return tagsHeader
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  if (Array.isArray(tagsHeader)) {
    return tagsHeader
      .flatMap((part) => String(part).split(","))
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
}

function isTagStateExpired(
  state: TagState | null,
  lastModified: number | undefined,
  isFetch: boolean
): boolean {
  if (!state || typeof lastModified !== "number") return false;
  if (typeof state.expired === "number" && state.expired >= lastModified) return true;
  if (isFetch && typeof state.stale === "number" && state.stale >= lastModified) return true;
  return false;
}

function normalizeTtlSeconds(
  data: IncrementalCacheData["value"],
  ctx: IncrementalCtx | undefined
): number {
  if (data && typeof data === "object") {
    const d = data as { kind?: string; revalidate?: number | false };
    if (d.kind === "FETCH") {
      if (typeof d.revalidate === "number" && d.revalidate > 0) {
        return Math.min(Math.max(Math.ceil(d.revalidate), MIN_TTL_SEC), ONE_YEAR_SEC);
      }
      return ONE_YEAR_SEC;
    }
  }
  const revalidate = ctx?.cacheControl?.revalidate;
  if (revalidate === false || revalidate === undefined) return ONE_YEAR_SEC;
  if (typeof revalidate === "number" && revalidate > 0) {
    return Math.min(Math.max(Math.ceil(revalidate), MIN_TTL_SEC), ONE_YEAR_SEC);
  }
  return MIN_TTL_SEC;
}

async function readTagStates(
  state: HandlerState,
  tags: string[]
): Promise<(TagState | null)[]> {
  if (tags.length === 0) return [];

  const useRedis = gateRedisInit(state);
  if (!useRedis) {
    return tags.map((t) => state.memTagStates.get(t) ?? null);
  }

  try {
    return await withAbortSignal(
      "incremental.readTagStates",
      state.opts.abortTimeoutMs,
      async () => {
        const client = await state.conn.getOrConnect();
        if (!client) return tags.map((t) => state.memTagStates.get(t) ?? null);
        const values = await client.mGet(tags.map((t) => tagMetaKey(state, t)));
        return values.map((v) => {
          if (!v) return null;
          try {
            return JSON.parse(v) as TagState;
          } catch {
            return null;
          }
        });
      }
    );
  } catch {
    return tags.map((t) => state.memTagStates.get(t) ?? null);
  }
}

// ─── Handler class ──────────────────────────────────────────────────────────

export class IncrementalRedisCacheHandler {
  private readonly state: HandlerState;
  private readonly revalidatedTags: string[];

  constructor(state: HandlerState, ctx?: { revalidatedTags?: string[] }) {
    this.state = state;
    this.revalidatedTags = normalizeTags(ctx?.revalidatedTags);
  }

  async get(
    cacheKey: string,
    ctx?: IncrementalCtx
  ): Promise<(CacheRecord & { tags?: string[] }) | null> {
    try {
      const requestedTags = normalizeTags([
        ...(ctx?.tags ?? []),
        ...(ctx?.softTags ?? []),
      ]);
      const useLocal = shouldUseLocalIncrementalStore(requestedTags);
      const eKey = entryKey(this.state, cacheKey);

      const useRedis =
        !useLocal &&
        gateRedis(this.state);

      let raw: string | null = null;
      if (useRedis) {
        try {
          raw = await withAbortSignal(
            "incremental.get",
            this.state.opts.abortTimeoutMs,
            async () => {
              const client = await this.state.conn.getOrConnect();
              if (!client) return null;
              return await client.get(eKey);
            }
          );
        } catch (err) {
          if (err instanceof CacheTimeoutError) {
            this.state.emit({ type: "redis.timeout", meta: { op: "incremental.get" } });
          }
          raw = null;
        }
      }
      if (raw === null) raw = this.state.memEntries.get(eKey);
      if (raw === null) {
        this.state.emit({ type: "cache.miss" });
        return null;
      }

      const parsed = deserializeCacheRecord<CacheRecord>(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.value) return null;

      const tags = extractTagsFromValue(parsed.value, ctx);
      if (tags.some((t) => this.revalidatedTags.includes(t))) {
        this.state.emit({ type: "cache.miss", meta: { reason: "revalidated-this-request" } });
        return null;
      }

      const tagStates = await readTagStates(this.state, tags);
      const isFetch = ctx?.kind === "FETCH";
      if (tagStates.some((s) => isTagStateExpired(s, parsed.lastModified, isFetch))) {
        this.state.emit({ type: "cache.miss", meta: { reason: "tag-state-expired" } });
        return null;
      }

      this.state.emit({ type: "cache.hit" });
      return { ...parsed, tags };
    } catch (err) {
      this.state.logger.error("get() unexpected error", {
        message: (err as Error).message,
      });
      return null;
    }
  }

  async set(
    cacheKey: string,
    data: IncrementalCacheData["value"],
    ctx?: IncrementalCtx
  ): Promise<void> {
    if (!data) return;
    try {
      const tags = extractTagsFromValue(data, ctx);
      const useLocal = shouldUseLocalIncrementalStore(tags);
      const ttl = normalizeTtlSeconds(data, ctx);
      const record: CacheRecord = { lastModified: Date.now(), value: data };
      const serialized = serializeCacheRecord(record);
      const eKey = entryKey(this.state, cacheKey);

      const useRedis =
        !useLocal &&
        gateRedis(this.state);

      if (useRedis) {
        try {
          await withAbortSignal(
            "incremental.set",
            this.state.opts.abortTimeoutMs,
            async () => {
              const client = await this.state.conn.getOrConnect();
              if (!client) {
                this.state.memEntries.set(eKey, serialized, ttl);
                return;
              }
              await client.set(eKey, serialized, { EX: ttl });
            }
          );
          this.state.emit({ type: "cache.set", meta: { backend: "redis" } });
          return;
        } catch (err) {
          if (err instanceof CacheTimeoutError) {
            this.state.emit({ type: "redis.timeout", meta: { op: "incremental.set" } });
          }
          // Fall through to memory.
        }
      }

      this.state.memEntries.set(eKey, serialized, ttl);
      this.state.emit({ type: "cache.set", meta: { backend: "memory" } });
    } catch (err) {
      this.state.logger.error("set() error", {
        message: (err as Error).message,
      });
      this.state.emit({ type: "cache.set.failed" });
    }
  }

  async revalidateTag(
    tags: string | string[],
    durations?: { expire?: number }
  ): Promise<void> {
    const list = normalizeTags([tags].flat());
    if (list.length === 0) return;

    const useLocal = shouldUseLocalIncrementalStore(list);
    const useRedis = !useLocal && gateRedis(this.state);

    const now = Date.now();
    const payload: TagState = durations
      ? {
          stale: now,
          ...(durations.expire !== undefined
            ? { expired: now + durations.expire * 1000 }
            : {}),
        }
      : { expired: now };

    // Local first.
    for (const t of list) this.state.memTagStates.set(t, payload);

    if (!useRedis) {
      this.state.emit({
        type: payload.expired ? "tag.invalidate.hard" : "tag.invalidate.soft",
        meta: { count: list.length, backend: "memory" },
      });
      return;
    }

    try {
      await withAbortSignal(
        "incremental.revalidateTag",
        this.state.opts.abortTimeoutMs,
        async () => {
          const client = await this.state.conn.getOrConnect();
          if (!client) return;
          await Promise.all(
            list.map((t) =>
              client.set(tagMetaKey(this.state, t), JSON.stringify(payload), {
                EX: ONE_YEAR_SEC,
              })
            )
          );
        }
      );
      this.state.emit({
        type: payload.expired ? "tag.invalidate.hard" : "tag.invalidate.soft",
        meta: { count: list.length, backend: "redis" },
      });
    } catch (err) {
      this.state.logger.warn("revalidateTag() failed", {
        message: (err as Error).message,
      });
      // Hard expirations should propagate so callers know to retry.
      if (payload.expired !== undefined) throw err;
    }
  }

  resetRequestCache(): void {
    // Per-request memoization isn't shared between requests anyway; nothing
    // to clear at this level.
  }
}

/**
 * Factory returning a class compatible with Next.js's `cacheHandler` (singular)
 * option. Next.js does `new CacheHandler(ctx)` at request time, so we close
 * over the configured state and produce a class with the spec-required
 * methods. Note: Next constructs the class with just `(ctx)`, so the returned
 * class's constructor signature accepts the single-arg shape.
 */
export interface NextCacheHandlerCtor {
  new (ctx?: { revalidatedTags?: string[] }): IncrementalRedisCacheHandler;
}

export function createIncrementalCacheHandler(
  opts: CacheHandlerOptions
): NextCacheHandlerCtor {
  const state = init(opts);

  class BoundIncrementalCacheHandler extends IncrementalRedisCacheHandler {
    constructor(ctx?: { revalidatedTags?: string[] }) {
      super(state, ctx);
    }
  }

  return BoundIncrementalCacheHandler;
}
