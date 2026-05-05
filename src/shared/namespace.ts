/**
 * Build namespace resolution.
 *
 * Why this matters: the reference implementation's "static chunk 404" incident
 * was caused by old prerender HTML from a previous deployment hitting in Redis.
 * Two deployments shared the same cache key prefix, so a new build's request
 * could deserialize an entry that referenced static chunks deleted by the
 * deployment swap.
 *
 * Embedding a per-deployment namespace into every entry key fixes this:
 *   next-incremental:entry:<commit-sha>:<path>
 *
 * Rolling forward to a new SHA invalidates everything atomically without
 * needing a manual flush. Tags remain shared across deployments so
 * `revalidateTag()` keeps cross-deployment semantics.
 */

const FALLBACK = "unversioned";

/**
 * Resolve the namespace value. Pure helper used at runtime when constructing
 * keys.
 */
export function resolveBuildNamespace(
  override?: string | (() => string)
): string {
  if (override !== undefined) {
    return typeof override === "function" ? override() : override;
  }
  return (
    process.env.DEPLOYMENT_VERSION ??
    process.env.GIT_HASH ??
    process.env.NEXT_DEPLOYMENT_ID ??
    FALLBACK
  );
}

/**
 * Build a namespaced key. When `hashTag` is true, the namespace is wrapped in
 * `{}` so multi-key Lua scripts on Redis Cluster all hash to the same slot.
 *
 * Example:
 *   buildKey("next-incremental:entry:", "ns42", "/blog/hello", false)
 *     → "next-incremental:entry:ns42:/blog/hello"
 *   buildKey("next-cache:tag:", "ns42", "post-1", true)
 *     → "next-cache:tag:{ns42}:post-1"
 */
export function buildKey(
  prefix: string,
  namespace: string,
  rest: string,
  hashTag = false
): string {
  const ns = hashTag ? `{${namespace}}` : namespace;
  return `${prefix}${ns}:${rest}`;
}
