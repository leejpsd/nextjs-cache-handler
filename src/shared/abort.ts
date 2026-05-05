/**
 * Timeout-bounded operation wrapper. Surrounds every Redis call so a hung
 * connection doesn't lock up the Next.js request thread.
 *
 * Why explicit `withAbortSignal` instead of a Proxy (like @fortedigital's
 * `withAbortSignalProxy`):
 *   - Stack traces stay clean; consumers see "cacheHandlers.get" not "Proxy.apply"
 *   - Per-method timeouts can differ (set 500ms, updateTags 3000ms) without
 *     re-instantiating a Proxy
 *   - Easier to follow in `step into` debugging
 */

export class CacheTimeoutError extends Error {
  override readonly name = "CacheTimeoutError";
  constructor(
    public readonly opName: string,
    public readonly ms: number
  ) {
    super(`[@leejpsd/nextjs-cache-handler] ${opName} timed out after ${ms}ms`);
  }
}

/**
 * Run `fn` with a hard deadline. The provided AbortSignal is forwarded so the
 * inner operation can cancel cooperatively if it supports it.
 *
 * Behavior:
 *   - If `fn` resolves before the deadline → resolved value is returned
 *   - If the deadline fires first → CacheTimeoutError is thrown
 *
 * Note: aborting the AbortSignal does NOT close the underlying Redis socket.
 * The connection is retained for subsequent calls. We trust the Redis client
 * to recover on its own; we just stop waiting on this particular promise.
 */
export async function withAbortSignal<T>(
  opName: string,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if (typeof timer === "object" && "unref" in timer) {
    // Don't keep the event loop alive just for this timer.
    (timer as { unref: () => void }).unref();
  }

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        ctrl.signal.removeEventListener("abort", onAbort);
        reject(new CacheTimeoutError(opName, ms));
      };
      if (ctrl.signal.aborted) onAbort();
      else ctrl.signal.addEventListener("abort", onAbort, { once: true });
    });

    return await Promise.race([fn(ctrl.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
