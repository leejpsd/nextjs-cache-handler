import { describe, expect, it, vi } from "vitest";

import { CacheTimeoutError, withAbortSignal } from "../../src/shared/abort.js";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}

describe("withAbortSignal", () => {
  it("returns the resolved value when fn finishes before deadline", async () => {
    const result = await withAbortSignal("test.op", 100, async () => 42);
    expect(result).toBe(42);
  });

  it("throws CacheTimeoutError when fn exceeds the deadline", async () => {
    await expect(
      withAbortSignal("test.op", 30, async (signal) => sleep(200, signal))
    ).rejects.toBeInstanceOf(CacheTimeoutError);
  });

  it("CacheTimeoutError carries the operation name and ms", async () => {
    try {
      await withAbortSignal("op.foo", 25, async (signal) => sleep(200, signal));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CacheTimeoutError);
      const e = err as CacheTimeoutError;
      expect(e.opName).toBe("op.foo");
      expect(e.ms).toBe(25);
      expect(e.message).toContain("op.foo");
      expect(e.message).toContain("25ms");
    }
  });

  it("propagates non-timeout errors unchanged", async () => {
    const original = new Error("upstream failure");
    await expect(
      withAbortSignal("test.op", 100, async () => {
        throw original;
      })
    ).rejects.toBe(original);
  });

  it("clears the timer after fn resolves (no leaked handles)", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await withAbortSignal("test.op", 100, async () => "ok");
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
