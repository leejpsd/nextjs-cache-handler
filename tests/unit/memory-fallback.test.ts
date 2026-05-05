import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStore, MemorySetStore } from "../../src/shared/memory-fallback.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MemoryStore — TTL leak prevention (reference impl bug)", () => {
  it("returns the value before TTL expires", () => {
    const m = new MemoryStore<string>();
    m.set("k1", "v1", 60);
    expect(m.get("k1")).toBe("v1");
  });

  it("returns null after TTL expires (timer-driven)", () => {
    const m = new MemoryStore<string>();
    m.set("k1", "v1", 60);
    vi.advanceTimersByTime(61_000);
    expect(m.get("k1")).toBeNull();
  });

  it("returns null after TTL expires (lazy via system time)", () => {
    const m = new MemoryStore<string>();
    m.set("k1", "v1", 60);
    // Bypass the timer and just advance the clock — the get() path must
    // still detect expiration.
    vi.setSystemTime(new Date(Date.now() + 120_000));
    expect(m.get("k1")).toBeNull();
  });

  it("clears prior timer when same key is overwritten", () => {
    const m = new MemoryStore<string>();
    m.set("k1", "v1", 60);
    m.set("k1", "v2", 30);
    vi.advanceTimersByTime(40_000);
    expect(m.get("k1")).toBeNull();
  });

  it("delete() removes both value and timer", () => {
    const m = new MemoryStore<string>();
    m.set("k1", "v1", 60);
    expect(m.delete("k1")).toBe(true);
    expect(m.get("k1")).toBeNull();
    // Subsequent timer fire should not double-delete.
    vi.advanceTimersByTime(70_000);
    expect(m.size()).toBe(0);
  });

  it("clear() drains everything", () => {
    const m = new MemoryStore<string>();
    m.set("a", "1", 60);
    m.set("b", "2", 60);
    m.set("c", "3", 60);
    m.clear();
    expect(m.size()).toBe(0);
    expect(m.get("a")).toBeNull();
  });
});

describe("MemorySetStore — tag index with TTL", () => {
  it("sAdd returns count of newly inserted members", () => {
    const s = new MemorySetStore();
    expect(s.sAdd("tag:a", ["k1", "k2"])).toBe(2);
    expect(s.sAdd("tag:a", ["k2", "k3"])).toBe(1);
  });

  it("sMembers returns the current set", () => {
    const s = new MemorySetStore();
    s.sAdd("tag:a", ["k1", "k2"]);
    expect(new Set(s.sMembers("tag:a"))).toEqual(new Set(["k1", "k2"]));
  });

  it("expire schedules deletion", () => {
    const s = new MemorySetStore();
    s.sAdd("tag:a", "k1");
    s.expire("tag:a", 30);
    vi.advanceTimersByTime(31_000);
    expect(s.sMembers("tag:a")).toEqual([]);
  });

  it("expire() on non-existent key returns false", () => {
    const s = new MemorySetStore();
    expect(s.expire("tag:nope", 10)).toBe(false);
  });

  it("expire reset replaces previous TTL", () => {
    const s = new MemorySetStore();
    s.sAdd("tag:a", "k1");
    s.expire("tag:a", 60);
    vi.advanceTimersByTime(20_000);
    s.expire("tag:a", 60); // reset
    vi.advanceTimersByTime(50_000);
    // Total elapsed = 70s, but we reset at 20s, so 50s elapsed since reset.
    expect(s.sMembers("tag:a")).toEqual(["k1"]);
  });
});
