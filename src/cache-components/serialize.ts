/**
 * ReadableStream <-> base64 conversion for the cacheHandlers value field.
 *
 * Per the Next 16 spec (docs/next16-spec.md §2.2):
 *   value: ReadableStream<Uint8Array>
 *
 * Redis stores strings, so we materialize the stream into a Buffer, encode as
 * base64, persist as part of a JSON envelope, then reconstruct a single-chunk
 * ReadableStream on read.
 *
 * Spec-mandated behavior on partial writes:
 *   "the stream may error partway through rendering. Your handler should
 *    decide whether to keep partial entries or discard them. Discarding is
 *    safer."
 * → readStreamFully throws on stream errors. The caller must catch and skip
 *   the SET operation when this throws.
 */

export async function readStreamFully(
  stream: ReadableStream<Uint8Array>
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  // Capture once; the controller's enqueue copy isn't necessary because the
  // backing Buffer is owned by us at this point.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

export interface StoredEntryEnvelope {
  /** base64-encoded stream contents */
  value: string;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

export function encodeEnvelope(
  buf: Buffer,
  meta: Omit<StoredEntryEnvelope, "value">
): string {
  const envelope: StoredEntryEnvelope = {
    value: buf.toString("base64"),
    ...meta,
  };
  return JSON.stringify(envelope);
}

export function decodeEnvelope(raw: string): StoredEntryEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as StoredEntryEnvelope).value !== "string"
    ) {
      return null;
    }
    return parsed as StoredEntryEnvelope;
  } catch {
    return null;
  }
}
