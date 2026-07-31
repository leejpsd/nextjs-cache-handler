/**
 * Transparent value compression for Redis-bound entries (node:zlib — zero
 * added dependencies).
 *
 * Storage format: `<marker><base64>` with marker `__ncgz__:` (gzip) or
 * `__ncbr__:` (brotli). Values without a marker pass through untouched, so
 * mixed caches stay readable: entries written before compression was enabled,
 * or by instances configured differently, decode fine — decompression is
 * always active regardless of the local `compression` option.
 *
 * Base64 re-inflates the compressed bytes by ~33% (our client contract is
 * string-typed), but RSC/HTML payloads are text-heavy enough that the net
 * reduction is typically 3–5×. Payloads under 1 KiB are stored uncompressed —
 * at that size marker+header overhead can exceed the savings.
 *
 * Only entry values are compressed. Tag markers and tag states are a few
 * bytes each and stay plain.
 */

import { promisify } from "node:util";
import {
  brotliCompress,
  brotliDecompress,
  constants,
  gunzip,
  gzip,
} from "node:zlib";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

export type CompressionAlgo = "gzip" | "brotli";

const GZIP_MARKER = "__ncgz__:";
const BROTLI_MARKER = "__ncbr__:";
const MIN_COMPRESS_BYTES = 1024;

/**
 * Brotli's default quality (11) is tuned for static assets and is far too
 * slow for a request-path cache write. 5 compresses close to gzip speed
 * while still beating it on ratio for text.
 */
const BROTLI_OPTS = {
  params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
};

export async function compressValue(
  value: string,
  algo: CompressionAlgo | undefined
): Promise<string> {
  if (!algo || Buffer.byteLength(value) < MIN_COMPRESS_BYTES) return value;
  const input = Buffer.from(value);
  if (algo === "gzip") {
    return GZIP_MARKER + (await gzipAsync(input)).toString("base64");
  }
  return (
    BROTLI_MARKER +
    (await brotliCompressAsync(input, BROTLI_OPTS)).toString("base64")
  );
}

/**
 * Marker-dispatched decompression. Unmarked values are returned as-is.
 * Throws on corrupt compressed data — callers treat that as a cache miss.
 */
export async function decompressValue(
  value: string | null
): Promise<string | null> {
  if (value === null) return null;
  if (value.startsWith(GZIP_MARKER)) {
    const buf = Buffer.from(value.slice(GZIP_MARKER.length), "base64");
    return (await gunzipAsync(buf)).toString("utf8");
  }
  if (value.startsWith(BROTLI_MARKER)) {
    const buf = Buffer.from(value.slice(BROTLI_MARKER.length), "base64");
    return (await brotliDecompressAsync(buf)).toString("utf8");
  }
  return value;
}
