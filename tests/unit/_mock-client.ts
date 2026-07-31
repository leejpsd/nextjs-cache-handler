/**
 * Lightweight in-test Redis mock implementing RedisClientLike. Backed by
 * Maps + Sets so the handler tests can run without docker.
 *
 * Lua execution is faked: we route known SCRIPTS by SHA1 (or body match) to
 * their JS analogs so the handler's atomicity contract gets exercised.
 */

import { createHash } from "node:crypto";

import { SCRIPTS, type ScriptName } from "../../src/shared/lua/index.js";
import type { RedisClientLike } from "../../src/types.js";

interface MockOptions {
  /** Inject a delay before each command, used by abort/timeout tests. */
  delayMs?: number;
  /** Make the next N commands throw. Decremented on each call. */
  failNext?: number;
}

export class MockRedisClient implements RedisClientLike {
  isOpen = false;
  readonly kv = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly errorListeners: Array<(err: Error) => void> = [];
  private readonly shaToName = new Map<string, ScriptName>();
  private readonly options: MockOptions;

  constructor(options: MockOptions = {}) {
    this.options = options;
    for (const name of Object.keys(SCRIPTS) as ScriptName[]) {
      const sha = createHash("sha1").update(SCRIPTS[name]).digest("hex");
      this.shaToName.set(sha, name);
    }
  }

  private async tick(): Promise<void> {
    if (this.options.failNext && this.options.failNext > 0) {
      this.options.failNext -= 1;
      throw new Error("[mock] forced failure");
    }
    if (this.options.delayMs) {
      await new Promise((r) => setTimeout(r, this.options.delayMs));
    }
  }

  async connect(): Promise<void> {
    await this.tick();
    this.isOpen = true;
  }

  async get(key: string): Promise<string | null> {
    await this.tick();
    return this.kv.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    opts?: { EX?: number; NX?: boolean }
  ): Promise<unknown> {
    await this.tick();
    if (opts?.NX && this.kv.has(key)) return null; // Redis returns nil when NX blocks
    this.kv.set(key, value);
    return "OK";
  }

  async del(keys: string | string[]): Promise<number> {
    await this.tick();
    const arr = Array.isArray(keys) ? keys : [keys];
    let n = 0;
    for (const k of arr) {
      if (this.kv.delete(k)) n += 1;
      if (this.sets.delete(k)) n += 1;
    }
    return n;
  }

  async sAdd(key: string, member: string | string[]): Promise<number> {
    await this.tick();
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    const arr = Array.isArray(member) ? member : [member];
    let n = 0;
    for (const m of arr) {
      if (!s.has(m)) {
        s.add(m);
        n += 1;
      }
    }
    return n;
  }

  async sMembers(key: string): Promise<string[]> {
    await this.tick();
    const s = this.sets.get(key);
    return s ? Array.from(s) : [];
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    // Mock: no-op (no real TTLs). Tests that verify TTL go through Lua args.
    return 1;
  }

  async mGet(keys: string[]): Promise<(string | null)[]> {
    await this.tick();
    return keys.map((k) => this.kv.get(k) ?? null);
  }

  async eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown> {
    await this.tick();
    const sha = createHash("sha1").update(script).digest("hex");
    const name = this.shaToName.get(sha);
    if (!name) throw new Error("[mock] unknown EVAL script");
    return this.runLua(name, opts.keys, opts.arguments);
  }

  async evalSha(sha: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown> {
    await this.tick();
    const name = this.shaToName.get(sha);
    if (!name) {
      const err = new Error("NOSCRIPT No matching script");
      throw err;
    }
    return this.runLua(name, opts.keys, opts.arguments);
  }

  async scriptLoad(script: string): Promise<string> {
    await this.tick();
    return createHash("sha1").update(script).digest("hex");
  }

  async *scanIterator(opts: {
    MATCH: string;
    COUNT?: number;
  }): AsyncGenerator<string[]> {
    const re = matchToRegex(opts.MATCH);
    const matches = [...this.kv.keys()].filter((k) => re.test(k));
    // Yield in COUNT-sized chunks like a real SCAN so callers' per-chunk
    // processing paths get exercised.
    const count = opts.COUNT ?? 100;
    for (let i = 0; i < matches.length; i += count) {
      yield matches.slice(i, i + count);
    }
  }

  async ping(): Promise<string> {
    await this.tick();
    return "PONG";
  }

  on(event: "error", listener: (err: Error) => void): unknown {
    if (event === "error") this.errorListeners.push(listener);
    return this;
  }

  // ─── Test-only helpers ────────────────────────────────────────────────────

  fail(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }

  /** Schedule the next N commands to throw. Used by failure-path tests. */
  failNext(count: number): void {
    this.options.failNext = (this.options.failNext ?? 0) + count;
  }

  private runLua(name: ScriptName, keys: string[], args: string[]): unknown {
    if (name === "setWithTags") {
      const [entryKey, ...tagKeys] = keys;
      if (!entryKey) throw new Error("[mock] setWithTags missing entry key");
      const [payload] = args;
      if (payload === undefined) throw new Error("[mock] setWithTags missing payload");
      this.kv.set(entryKey, payload);
      for (const tk of tagKeys) {
        let s = this.sets.get(tk);
        if (!s) {
          s = new Set();
          this.sets.set(tk, s);
        }
        s.add(entryKey);
      }
      return 1;
    }
    if (name === "revalidateHard") {
      const [tagKey, markerKey] = keys;
      const [nowMs] = args;
      if (!tagKey || !markerKey || nowMs === undefined) {
        throw new Error("[mock] revalidateHard missing args");
      }
      const s = this.sets.get(tagKey);
      let deleted = 0;
      if (s) {
        for (const k of s) {
          if (this.kv.delete(k)) deleted += 1;
        }
        this.sets.delete(tagKey);
      }
      this.kv.set(markerKey, nowMs);
      return deleted;
    }
    if (name === "refreshTagLock") {
      const [lockKey] = keys;
      const [owner] = args;
      if (!lockKey || owner === undefined) throw new Error("[mock] refreshTagLock missing args");
      if (this.kv.has(lockKey)) return 0;
      this.kv.set(lockKey, owner);
      return 1;
    }
    throw new Error(`[mock] unhandled script: ${name as string}`);
  }
}

function matchToRegex(pattern: string): RegExp {
  // Translate Redis MATCH glob to a regex. Supports * and ? only — enough for
  // the prefixes our handlers use.
  const escaped = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
