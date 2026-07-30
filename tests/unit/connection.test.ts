import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionManager } from "../../src/shared/client/index.js";
import type { RedisClientLike } from "../../src/types.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

interface FakeClient extends RedisClientLike {
  isOpen: boolean;
  disposeCalls: number;
}

function makeFakeClient(): FakeClient {
  const client = {
    isOpen: false,
    disposeCalls: 0,
    connect: async () => {
      client.isOpen = true;
    },
    dispose: () => {
      client.disposeCalls += 1;
      client.isOpen = false;
    },
    on: () => client,
  } as unknown as FakeClient;
  return client;
}

const RETRY = { baseCooldownMs: 100, maxCooldownMs: 400 };

describe("ConnectionManager — retry after connect failure (no permanent latch)", () => {
  it("returns null on failure and fast-fails within the cooldown without re-invoking the factory", async () => {
    const factory = vi.fn(() => {
      throw new Error("ECONNREFUSED");
    });
    const onError = vi.fn();
    const mgr = new ConnectionManager(factory, onError, RETRY);

    expect(await mgr.getOrConnect()).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // Inside the cooldown window: no new connect attempt.
    vi.advanceTimersByTime(50);
    expect(await mgr.getOrConnect()).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("retries after the cooldown elapses and recovers", async () => {
    const good = makeFakeClient();
    const factory = vi
      .fn<() => RedisClientLike>()
      .mockImplementationOnce(() => {
        throw new Error("ECONNREFUSED");
      })
      .mockImplementation(() => good);
    const mgr = new ConnectionManager(factory, () => {}, RETRY);

    expect(await mgr.getOrConnect()).toBeNull();
    vi.advanceTimersByTime(101);
    expect(await mgr.getOrConnect()).toBe(good);
    expect(good.isOpen).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("doubles the cooldown per consecutive failure, capped at maxCooldownMs", async () => {
    const factory = vi.fn(() => {
      throw new Error("ECONNREFUSED");
    });
    const mgr = new ConnectionManager(factory, () => {}, RETRY);

    await mgr.getOrConnect(); // failure #1 → cooldown 100
    vi.advanceTimersByTime(101);
    await mgr.getOrConnect(); // failure #2 → cooldown 200
    expect(factory).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(150);
    await mgr.getOrConnect(); // still cooling down
    expect(factory).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(51);
    await mgr.getOrConnect(); // failure #3 → cooldown 400
    expect(factory).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(401);
    await mgr.getOrConnect(); // failure #4 → cooldown capped at 400
    expect(factory).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(401);
    await mgr.getOrConnect();
    expect(factory).toHaveBeenCalledTimes(5);
  });

  it("a successful connect resets the failure counter", async () => {
    const good = makeFakeClient();
    const factory = vi
      .fn<() => RedisClientLike>()
      .mockImplementationOnce(() => {
        throw new Error("fail 1");
      })
      .mockImplementationOnce(() => {
        throw new Error("fail 2");
      })
      .mockImplementationOnce(() => good)
      .mockImplementation(() => {
        throw new Error("fail after recovery");
      });
    const mgr = new ConnectionManager(factory, () => {}, RETRY);

    await mgr.getOrConnect(); // fail 1 → cooldown 100
    vi.advanceTimersByTime(101);
    await mgr.getOrConnect(); // fail 2 → cooldown 200
    vi.advanceTimersByTime(201);
    expect(await mgr.getOrConnect()).toBe(good); // recovery

    // Drop the connection; next attempt fails → cooldown must be back at
    // base (100ms), not the doubled 400ms.
    good.isOpen = false;
    await mgr.getOrConnect(); // fail after recovery → cooldown 100
    vi.advanceTimersByTime(101);
    await mgr.getOrConnect();
    expect(factory).toHaveBeenCalledTimes(5);
  });
});

describe("ConnectionManager — dropped-connection replacement", () => {
  it("builds a fresh client immediately when the current one is no longer open, and disposes the dead one", async () => {
    const first = makeFakeClient();
    const second = makeFakeClient();
    const factory = vi
      .fn<() => RedisClientLike>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    const mgr = new ConnectionManager(factory, () => {}, RETRY);

    expect(await mgr.getOrConnect()).toBe(first);
    first.isOpen = false; // simulate socket drop

    // No failure was recorded, so replacement happens with no cooldown.
    expect(await mgr.getOrConnect()).toBe(second);
    expect(first.disposeCalls).toBe(1);
  });

  it("parallel getOrConnect calls share a single connect attempt", async () => {
    const good = makeFakeClient();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const factory = vi.fn(async () => {
      await gate;
      return good;
    });
    const mgr = new ConnectionManager(factory, () => {}, RETRY);

    const p1 = mgr.getOrConnect();
    const p2 = mgr.getOrConnect();
    release();
    expect(await p1).toBe(good);
    expect(await p2).toBe(good);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reset() clears the cooldown and disposes the current client", async () => {
    const good = makeFakeClient();
    const factory = vi
      .fn<() => RedisClientLike>()
      .mockImplementationOnce(() => {
        throw new Error("ECONNREFUSED");
      })
      .mockImplementation(() => good);
    const mgr = new ConnectionManager(factory, () => {}, RETRY);

    await mgr.getOrConnect(); // failure → cooldown active
    mgr.reset();
    expect(await mgr.getOrConnect()).toBe(good); // no cooldown wait needed

    mgr.reset();
    expect(good.disposeCalls).toBe(1);
  });
});
