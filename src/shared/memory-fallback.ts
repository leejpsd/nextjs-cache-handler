/**
 * In-memory cache stores with proper TTL handling.
 *
 * The reference implementation in next-redis-cache-demo had a subtle leak:
 * when the memory fallback was activated, `getMemoryTagSet(tag).add(redisKey)`
 * stored entries indefinitely because no `setTimeout` was registered to clean
 * them up. This implementation fixes that by attaching an `unref()`-ed timer
 * to every keyed value.
 *
 * Why two classes:
 *   - `MemoryStore<T>` mirrors Redis SET/GET/DEL with EX semantics
 *   - `MemorySetStore`  mirrors SADD/SMEMBERS/EXPIRE for tag indices
 */

interface MemoryEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Node's setTimeout coerces delays to a 32-bit signed integer. Anything
 * beyond ~24.85 days fires immediately with a TimeoutOverflowWarning. We cap
 * scheduled timers at this safe maximum and rely on the lazy `expiresAt`
 * check inside `get()` for the rest. Useful for the 1-year TTL fallback that
 * `cacheLife({expire: Infinity})` resolves to.
 */
const MAX_TIMER_MS = 2_147_483_647; // 2^31 - 1, ~24.85 days
function clampTimerMs(ms: number): number {
  return Math.min(Math.max(0, ms), MAX_TIMER_MS);
}

/**
 * Default entry cap for the fallback stores. The fallback exists to ride out
 * a Redis outage, not to replace it — an unbounded map filled by a long
 * outage on a busy site is an OOM waiting to happen.
 */
const DEFAULT_MAX_ENTRIES = 1000;

export class MemoryStore<T> {
  private readonly kv = new Map<string, MemoryEntry<T>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  set(key: string, value: T, ttlSeconds: number): void {
    this.delete(key);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.kv.set(key, { value, expiresAt });
    const timer = setTimeout(() => this.delete(key), clampTimerMs(ttlSeconds * 1000));
    if (typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.timers.set(key, timer);
    // LRU eviction: Map preserves insertion order and get() re-inserts on
    // hit, so the first key is always the least recently used.
    while (this.kv.size > this.maxEntries) {
      const oldest = this.kv.keys().next().value as string;
      this.delete(oldest);
    }
  }

  get(key: string): T | null {
    const entry = this.kv.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }
    // Refresh recency for LRU ordering.
    this.kv.delete(key);
    this.kv.set(key, entry);
    return entry.value;
  }

  delete(key: string): boolean {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    return this.kv.delete(key);
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  keys(): string[] {
    const now = Date.now();
    const live: string[] = [];
    for (const [key, entry] of this.kv.entries()) {
      if (entry.expiresAt >= now) live.push(key);
    }
    return live;
  }

  size(): number {
    return this.keys().length;
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.kv.clear();
  }
}

/**
 * Set-of-strings store with per-set TTL. Mirrors Redis SADD / SMEMBERS / EXPIRE.
 *
 * TTL semantics: EXPIRE replaces the previous TTL. We schedule one timer per
 * set (not per member) and reset it on every SADD or EXPIRE.
 */
export class MemorySetStore {
  private readonly sets = new Map<string, Set<string>>();
  private readonly expiresAt = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxSets: number;

  constructor(maxSets: number = DEFAULT_MAX_ENTRIES) {
    this.maxSets = Math.max(1, maxSets);
  }

  sAdd(key: string, member: string | string[]): number {
    const members = Array.isArray(member) ? member : [member];
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
    } else {
      // Refresh recency for LRU ordering.
      this.sets.delete(key);
    }
    this.sets.set(key, set);
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added += 1;
      }
    }
    while (this.sets.size > this.maxSets) {
      const oldest = this.sets.keys().next().value as string;
      this.delete(oldest);
    }
    return added;
  }

  sMembers(key: string): string[] {
    if (this.isExpired(key)) {
      this.delete(key);
      return [];
    }
    const set = this.sets.get(key);
    return set ? Array.from(set) : [];
  }

  expire(key: string, ttlSeconds: number): boolean {
    if (!this.sets.has(key)) return false;
    const prev = this.timers.get(key);
    if (prev !== undefined) clearTimeout(prev);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.expiresAt.set(key, expiresAt);
    const timer = setTimeout(() => this.delete(key), clampTimerMs(ttlSeconds * 1000));
    if (typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
    this.timers.set(key, timer);
    return true;
  }

  delete(key: string): boolean {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.expiresAt.delete(key);
    return this.sets.delete(key);
  }

  keys(): string[] {
    const live: string[] = [];
    for (const key of this.sets.keys()) {
      if (!this.isExpired(key)) live.push(key);
    }
    return live;
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.expiresAt.clear();
    this.sets.clear();
  }

  private isExpired(key: string): boolean {
    const at = this.expiresAt.get(key);
    return at !== undefined && Date.now() > at;
  }
}
