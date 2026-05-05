import { describe, expect, it } from "vitest";

import {
  bufferToStream,
  decodeEnvelope,
  encodeEnvelope,
  readStreamFully,
} from "../../src/cache-components/serialize.js";
import {
  deserializeCacheRecord,
  serializeCacheRecord,
} from "../../src/incremental/serialize.js";

describe("cache-components/serialize", () => {
  it("encodes and decodes a stream round-trip", async () => {
    const original = Buffer.from("hello world");
    const stream = bufferToStream(original);
    const buf = await readStreamFully(stream);
    expect(buf.equals(original)).toBe(true);
  });

  it("envelope round-trip preserves all metadata", async () => {
    const buf = Buffer.from("payload");
    const envelope = encodeEnvelope(buf, {
      tags: ["a", "b"],
      stale: 60,
      timestamp: 1_700_000_000_000,
      expire: 3600,
      revalidate: 120,
    });
    const decoded = decodeEnvelope(envelope);
    expect(decoded).not.toBeNull();
    expect(decoded?.tags).toEqual(["a", "b"]);
    expect(decoded?.stale).toBe(60);
    expect(decoded?.timestamp).toBe(1_700_000_000_000);
    expect(Buffer.from(decoded!.value, "base64").toString("utf8")).toBe("payload");
  });

  it("decodeEnvelope returns null on malformed JSON", () => {
    expect(decodeEnvelope("not json")).toBeNull();
  });

  it("decodeEnvelope returns null on missing fields", () => {
    expect(decodeEnvelope(JSON.stringify({ tags: [] }))).toBeNull();
  });
});

describe("incremental/serialize — Buffer + Map preservation", () => {
  it("Buffer round-trip", () => {
    const record = {
      lastModified: 1,
      value: { kind: "APP_PAGE", body: Buffer.from("html body") },
    };
    const wire = serializeCacheRecord(record);
    const back = deserializeCacheRecord<typeof record>(wire);
    expect(back).not.toBeNull();
    const body = (back as typeof record).value.body;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).toString("utf8")).toBe("html body");
  });

  it("Map round-trip", () => {
    const m = new Map<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    const record = { lastModified: 1, value: { kind: "APP_PAGE", meta: m } };
    const wire = serializeCacheRecord(record);
    const back = deserializeCacheRecord<typeof record>(wire);
    const meta = (back as typeof record).value.meta;
    expect(meta).toBeInstanceOf(Map);
    expect((meta as Map<string, number>).get("a")).toBe(1);
    expect((meta as Map<string, number>).get("b")).toBe(2);
  });

  it("legacy Buffer shape (Node default toJSON) is also revived", () => {
    // Node Buffer.toJSON() => { type: 'Buffer', data: number[] }
    const wire = JSON.stringify({
      lastModified: 1,
      value: { type: "Buffer", data: [104, 105] }, // "hi"
    });
    const back = deserializeCacheRecord<{ value: Buffer }>(wire);
    expect(back).not.toBeNull();
    expect(Buffer.isBuffer(back?.value)).toBe(true);
    expect((back?.value as Buffer).toString("utf8")).toBe("hi");
  });

  it("returns null on parse failure", () => {
    expect(deserializeCacheRecord("not json")).toBeNull();
  });
});
