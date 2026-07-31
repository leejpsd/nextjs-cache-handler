import { describe, expect, it } from "vitest";

import {
  compressValue,
  decompressValue,
} from "../../src/shared/compress.js";

const BIG = "The quick brown fox jumps over the lazy dog. ".repeat(200); // ~9 KB

describe("compressValue / decompressValue", () => {
  it("gzip round-trips and shrinks a compressible payload", async () => {
    const stored = await compressValue(BIG, "gzip");
    expect(stored.startsWith("__ncgz__:")).toBe(true);
    expect(stored.length).toBeLessThan(BIG.length / 2);
    expect(await decompressValue(stored)).toBe(BIG);
  });

  it("brotli round-trips and shrinks a compressible payload", async () => {
    const stored = await compressValue(BIG, "brotli");
    expect(stored.startsWith("__ncbr__:")).toBe(true);
    expect(stored.length).toBeLessThan(BIG.length / 2);
    expect(await decompressValue(stored)).toBe(BIG);
  });

  it("payloads under 1 KiB are stored uncompressed", async () => {
    const small = "tiny value";
    expect(await compressValue(small, "gzip")).toBe(small);
  });

  it("no algorithm configured → passthrough", async () => {
    expect(await compressValue(BIG, undefined)).toBe(BIG);
  });

  it("unmarked values pass through decompression untouched", async () => {
    expect(await decompressValue(BIG)).toBe(BIG);
    expect(await decompressValue(null)).toBeNull();
  });

  it("multibyte content survives the round trip", async () => {
    const korean = "다국어 콘텐츠 압축 왕복 테스트 — 절대 깨지면 안 된다. ".repeat(100);
    expect(await decompressValue(await compressValue(korean, "gzip"))).toBe(
      korean
    );
  });

  it("corrupt compressed data rejects (callers treat as miss)", async () => {
    await expect(
      decompressValue("__ncgz__:not-actually-gzip-data")
    ).rejects.toThrow();
  });
});
