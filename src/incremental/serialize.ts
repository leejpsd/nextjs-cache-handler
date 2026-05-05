/**
 * JSON serialization with Buffer / Map support for ISR cache records.
 *
 * Next.js's IncrementalCacheValue can contain Buffer (rendered HTML body) and
 * Map instances (RSC payload metadata). Plain JSON.stringify destroys both.
 *
 * The `__type` discriminator approach is borrowed from the reference handler
 * in next-redis-cache-demo. The reviver also accepts the legacy
 * `{ type: "Buffer", data: number[] }` shape that Node.js's default
 * Buffer.toJSON produces.
 */

interface BufferEnvelope {
  __type: "Buffer";
  data: string;
}
interface MapEnvelope {
  __type: "Map";
  entries: Array<[unknown, unknown]>;
}
type Envelope = BufferEnvelope | MapEnvelope;

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "__type" in value &&
    typeof (value as { __type: unknown }).__type === "string"
  );
}

interface LegacyBufferShape {
  type: "Buffer";
  data: number[];
}

function isLegacyBufferShape(value: unknown): value is LegacyBufferShape {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  );
}

function replacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    const env: BufferEnvelope = {
      __type: "Buffer",
      data: value.toString("base64"),
    };
    return env;
  }
  if (value instanceof Map) {
    const env: MapEnvelope = {
      __type: "Map",
      entries: Array.from(value.entries()) as Array<[unknown, unknown]>,
    };
    return env;
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (isLegacyBufferShape(value)) {
    return Buffer.from(value.data);
  }
  if (!isEnvelope(value)) return value;
  if (value.__type === "Buffer") {
    return Buffer.from((value as BufferEnvelope).data, "base64");
  }
  if (value.__type === "Map") {
    return new Map((value as MapEnvelope).entries);
  }
  return value;
}

export function serializeCacheRecord(record: unknown): string {
  return JSON.stringify(record, replacer);
}

export function deserializeCacheRecord<T = unknown>(serialized: string): T | null {
  try {
    return JSON.parse(serialized, reviver) as T;
  } catch {
    return null;
  }
}
